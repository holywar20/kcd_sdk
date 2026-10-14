import { describe as describeProse, it as itProse, expect as expectProse } from 'vitest';
import { KcdSynth as Synth, PROSE_INLINE_TAGS } from '../KcdSynth';

/**
 * Prose hygiene ( 2026-08-17 ). Two rules that both answer "what will this document actually SAY".
 *
 * Comments are stripped because they are a HUMAN channel ( ruling: Bryan ) — an agent has the body
 * for anything it needs to say, and a side channel it can write but a reader does not expect is a
 * contamination surface. Before this, the two input paths disagreed: a comment in an authored `body`
 * was dropped by the parser, and the same comment in `content` prose was ESCAPED and rendered a
 * literal `<!-- … -->` onto the page.
 *
 * Markdown is advised rather than converted, because interpreting it would mint a dialect this
 * project then owns forever, in a corpus that is HTML by deliberate choice.
 */
describeProse( 'KcdSynth — prose hygiene', () => {

	itProse( 'strips comment syntax rather than escaping it into visible text', () => {
		const html = Synth.proseToHtml( 'Before <!-- a human note --> after.' );
		expectProse( html ).not.toContain( '&lt;!--' );
		expectProse( html ).not.toContain( '<!--' );
		expectProse( html ).toContain( 'Before' );
		expectProse( html ).toContain( 'after.' );
	} );

	itProse( 'still recognizes authored HTML that merely opens with a comment', () => {
		expectProse( Synth.proseToHtml( '<!-- lead-in --><p>Real markup.</p>' ) ).toBe( '<p>Real markup.</p>' );
	} );

	itProse( 'flags each markdown form with the tag to use instead', () => {
		const warn = Synth.proseWarnings( { sections: { why: 'This is **bold** and `code` and [a link](x.html).' } } );
		expectProse( warn ).toHaveLength( 1 );
		expectProse( warn[ 0 ] ).toContain( 'why' );
		expectProse( warn[ 0 ] ).toContain( '<strong>' );
		expectProse( warn[ 0 ] ).toContain( '<code>' );
		expectProse( warn[ 0 ] ).toContain( '<a href>' );
	} );

	// The advice and the escaper used to be a hundred lines apart in one file, saying different things
	// ( BUG-74 ). Every tag the advice names must be a member of the set the escaper reads, by construction.
	itProse( 'advises only tags the allowlist actually holds', () => {
		const warn = Synth.proseWarnings( { sections: { why: 'This is **bold** and `code` and [a link](x.html).' } } );
		for ( const advertised of ( warn[ 0 ] ?? '' ).matchAll( /<([a-z]+)[^>]*>/g ) )
			expectProse( Object.keys( PROSE_INLINE_TAGS ) ).toContain( advertised[ 1 ] );
	} );

	itProse( 'says nothing about prose that carries no markers', () => {
		expectProse( Synth.proseWarnings( { sections: { why: 'Ordinary prose, nothing clever.' } } ) ).toEqual( [] );
	} );

	// An author writing markup means it — a <code> element is not a backtick mistake.
	itProse( 'does not flag a section already authored as HTML', () => {
		expectProse( Synth.proseWarnings( { sections: { why: '<p>Real <code>markup</code> here.</p>' } } ) ).toEqual( [] );
	} );
} );

import { describe, it, expect } from 'vitest';
import { KcdSynth } from '../KcdSynth';
import { KcdEmit } from '../KcdEmit';
import { KcdParse } from '../KcdParse';
import { KcdValidate } from '../KcdValidate';
import { KcdShapes } from '../KcdShapes';

/**
 * The acceptance question for synthesis is not "does it emit HTML" but "does the HTML it emits
 * survive the gate the write path actually runs". So every case here goes the full distance —
 * synthesize → emit → validate — because a body that parses but fails validation is exactly the
 * defect this module exists to prevent, and only the last step can see it.
 */
function build( type: string, name: string, input: Parameters<typeof KcdSynth.synthesize>[ 1 ] ) {
	const { body, undeclared } = KcdSynth.synthesize( type, input );
	const html = KcdEmit.emit( {
		path:        `${ name }.html`,
		type,
		frontmatter: { name, description: `Synthesis test fixture for ${ type }.`, type, status: 'active' },
		sections:    {},
		body,
		links:       [],
	} as any );
	return { body, undeclared, html, report: KcdValidate.validate( html , { docRoot: '_Claude' }) };
}

describe( 'KcdSynth — prose sections', () => {

	it( 'emits a body that validates clean, from content alone', () => {
		const { html, report } = build( 'reference', 'synth-prose', {
			summary:  'One line of summary.',
			sections: { location: 'It lives here.', interface: 'Call it like this.' },
		} );

		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
		expect( html ).toContain( '<section data-kcd-section="location">' );
	} );

	it( 'round-trips: every authored section is readable back through KcdParse', () => {
		const { html } = build( 'reference', 'synth-round', {
			sections: { location: 'Alpha.', interface: 'Beta.', status: 'Gamma.' },
		} );

		const parsed = KcdParse.parse( html, 'synth-round.html' , '_Claude');
		expect( Object.keys( parsed.sections ).sort() ).toEqual( [ 'interface', 'location', 'status' ] );
	} );

	it( 'turns blank-line-separated text into paragraphs and dash lines into a list', () => {
		const { html } = build( 'reference', 'synth-blocks', {
			sections: { location: 'First para.\n\nSecond para.', conventions: '- one\n- two' },
		} );

		expect( html ).toContain( '<p>First para.</p>' );
		expect( html ).toContain( '<p>Second para.</p>' );
		expect( html ).toContain( '<li>one</li>' );
		expect( html ).toContain( '<li>two</li>' );
	} );

	it( 'escapes plain text rather than letting it open a tag', () => {
		const { html, report } = build( 'reference', 'synth-escape', {
			sections: { location: 'A value under 5 < 10 and a <script>tag</script> in prose.' },
		} );

		expect( html ).not.toContain( '<script>' );
		expect( html ).toContain( '&lt;script&gt;' );
		expect( report.ok ).toBe( true );
	} );

	it( 'passes already-authored markup through untouched', () => {
		const { html } = build( 'reference', 'synth-passthrough', {
			sections: { location: '<p>Authored <strong>markup</strong> survives.</p>' },
		} );

		expect( html ).toContain( '<strong>markup</strong>' );
	} );

	it( 'omits a section the author left out rather than emitting an empty one', () => {
		// An empty section trips the validator's own empty-section rule, so silence is the only
		// correct handling of absence here.
		const { html, report } = build( 'reference', 'synth-absent', { sections: { location: 'Only this.' } } );
		expect( html ).not.toContain( 'data-kcd-section="interface"' );
		expect( report.ok ).toBe( true );
	} );
} );

describe( 'KcdSynth — declared shape drives placement', () => {

	it( 'emits declared sections in the table\'s order, not the caller\'s', () => {
		const { html, report } = build( 'plan', 'synth-order', {
			sections: {
				'current-state': 'Where it stands.',
				goal:            'What is true when done.',
				phases:          'The spine.',
			},
		} );

		expect( report.ok ).toBe( true );
		const order = [ ...html.matchAll( /data-kcd-section="([a-z-]+)"/g ) ].map( m => m[ 1 ] );
		expect( order.indexOf( 'goal' ) ).toBeLessThan( order.indexOf( 'phases' ) );
		expect( order.indexOf( 'phases' ) ).toBeLessThan( order.indexOf( 'current-state' ) );
	} );

	it( 'nests a phase inside phases, because the shape says phases nests phase-*', () => {
		const { html, report } = build( 'plan', 'synth-nest', {
			sections: {
				goal:            'A goal.',
				phases:          'Two phases follow.',
				'phase-1':       'The first.',
				'phase-2':       'The second.',
				'current-state': 'Active.',
			},
		} );

		expect( report.ok ).toBe( true );

		// The child must be INSIDE the parent element, not a sibling after it.
		const phases = html.indexOf( 'data-kcd-section="phases"' );
		const one    = html.indexOf( 'data-kcd-section="phase-1"' );
		const state  = html.indexOf( 'data-kcd-section="current-state"' );
		expect( phases ).toBeLessThan( one );
		expect( one ).toBeLessThan( state );

		// …and a nested child is never reported as undeclared.
		const { undeclared } = KcdSynth.synthesize( 'plan', { sections: { 'phase-1': 'x' } } );
		expect( undeclared ).toEqual( [] );
	} );

	// A title written into a phase's own HTML used to sit under a bare auto `Phase N` heading.
	it( 'lets a section\'s authored heading stand instead of adding a second one', () => {
		const { html, report } = build( 'plan', 'synth-titled', {
			sections: {
				goal: 'g', phases: 'p', 'current-state': 'c',
				'phase-1': '<h3>Phase 1 — Publish</h3>\n<p>The first.</p>',
				'phase-2': 'Untitled prose.',
			},
		} );

		expect( report.errors ).toEqual( [] );
		const one = html.slice( html.indexOf( 'data-kcd-section="phase-1"' ), html.indexOf( 'data-kcd-section="phase-2"' ) );
		expect( one.match( /<h[1-6]\b/g ) ).toHaveLength( 1 );
		expect( one ).toContain( 'Phase 1 — Publish' );
		// A section with no heading of its own still gets one.
		const two = html.slice( html.indexOf( 'data-kcd-section="phase-2"' ) );
		expect( two ).toMatch( /<h[1-6] data-kcd-heading>/ );
	} );

	// Found on the first live drive: phases supplied 2-then-1 were emitted 2-then-1. Numbered siblings
	// carry their sequence in their names, and ordering is this module's job, not the caller's.
	it( 'orders nested children numerically, not in the order supplied', () => {
		const { html } = build( 'plan', 'synth-child-order', {
			sections: {
				goal: 'g', phases: 'p', 'current-state': 'c',
				'phase-10': 'tenth', 'phase-2': 'second', 'phase-1': 'first',
			},
		} );

		const order = [ ...html.matchAll( /data-kcd-section="(phase-\d+)"/g ) ].map( m => m[ 1 ] );
		expect( order ).toEqual( [ 'phase-1', 'phase-2', 'phase-10' ] );
	} );

	it( 'counts a slot-supplied section as supplied, not as missing', () => {
		// Also found live: the advisory audited prose keys only, so a lens whose `references` arrived as
		// ROWS was reported missing `references`.
		const supplied = KcdSynth.suppliedSections( {
			sections: { personality: 'p', philosophy: 'q' },
			slots:    [ { section: 'references', rows: [ { what: 'protocol' } ] } ],
		} );

		expect( supplied ).toContain( 'references' );
		expect( KcdShapes.audit( 'lens', supplied ).thin ).not.toContain( 'references' );
	} );

	it( 'reports sections the shape does not declare, but still emits them', () => {
		const { html, undeclared, report } = build( 'plan', 'synth-undeclared', {
			sections: { goal: 'g', phases: 'p', 'current-state': 'c', findings: 'What we learned.' },
		} );

		expect( undeclared ).toEqual( [ 'findings' ] );
		expect( html ).toContain( 'data-kcd-section="findings"' );
		expect( report.ok ).toBe( true );
	} );
} );

describe( 'KcdSynth — regions and slot rows', () => {

	it( 'writes a lens as flat sections, in the shape\'s order, with no region wrapper', () => {
		const { html, report } = build( 'lens', 'synth-lens', {
			sections: { philosophy: 'What it defends.', personality: 'Who it is.' },
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).not.toContain( 'data-kcd-region' );
		expect( html.indexOf( 'data-kcd-section="personality"' ) ).toBeLessThan( html.indexOf( 'data-kcd-section="philosophy"' ) );
	} );

	it( 'emits slot rows as a faux-table with a real href, and validates', () => {
		const { html, report } = build( 'lens', 'synth-slots', {
			sections: { personality: 'p', philosophy: 'q' },
			slots: [ {
				section: 'references',
				rows: [ { what: 'protocol', where: '_Claude/references/kcd_sdk/kcd-document-protocol.html', why: 'the format' } ],
			} ],
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).toContain( '<div data-kcd-table>' );
		expect( html ).toContain( 'data-kcd-slot="reference"' );      // kind defaulted from the shape
		expect( html ).toContain( 'href="_Claude/references/kcd_sdk/kcd-document-protocol.html"' );
		expect( html ).not.toContain( '<table' );                      // never a real table
	} );

	// A habit's References rows were silently dropped: the shape did not list the section, so the content
	// path had nowhere to place them. The fix is the list, not a bespoke pass-through.
	it( 'keeps a habit\'s references rows', () => {
		const { html, report } = build( 'habit', 'synth-habit-refs', {
			sections: { why: 'a trigger', action: 'an act' },
			slots: [ {
				section: 'references',
				rows: [ { what: 'cover-changes', where: '_Claude/habits/unslotted/cover-changes.html', why: 'the test half' } ],
			} ],
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).toContain( 'data-kcd-section="references"' );
		expect( html ).toContain( 'data-kcd-slot="reference"' );
		expect( html ).toContain( 'href="_Claude/habits/unslotted/cover-changes.html"' );
	} );

	it( 'keeps a reference\'s references rows', () => {
		const { html, report } = build( 'reference', 'synth-reference-refs', {
			sections: { location: 'It lives here.' },
			slots: [ {
				section: 'references',
				rows: [ { what: 'kcd-document-protocol', where: '_Claude/references/kcd_sdk/kcd-document-protocol.html', why: 'the format' } ],
			} ],
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).toContain( 'data-kcd-section="references"' );
		expect( html ).toContain( 'data-kcd-slot="reference"' );
		expect( html ).toContain( 'href="_Claude/references/kcd_sdk/kcd-document-protocol.html"' );
	} );

	it( 'defaults an unknown slot kind to table-data rather than emitting an invalid one', () => {
		const { report } = build( 'reference', 'synth-badkind', {
			sections: { location: 'p' },
			slots:    [ { section: 'notes', kind: 'not-a-kind', rows: [ { what: 'x' } ] } ],
		} );
		expect( report.errors ).toEqual( [] );
	} );
} );

/**
 * THE INLINE ALLOWLIST ( BUG-74 ).
 *
 * ── THE DEFECT THESE CASES EXIST FOR ───────────────────────────────────────────────────────────────
 *
 * Inline markup used to survive by the ACCIDENT OF WHERE IT SAT. A section that happened to open with
 * `<p>` passed through verbatim and kept its `<strong>`; the identical prose without that wrapper went
 * through `escapeText` and rendered `&lt;strong&gt;` onto the page — while the tool description and the
 * authoring advisory both told the author to write exactly that. So the headline case here is not "does
 * `<strong>` work" but "do the two paths agree", and the list path is tested beside the paragraph path
 * because they were the two halves that could drift.
 *
 * ── AND ESCAPING IS STILL THE DEFAULT ──────────────────────────────────────────────────────────────
 *
 * The allowlist is the exception to escaping, not a relaxation of it, so most of what follows is the
 * REFUSAL surface: a tag outside the set, an attribute outside the set, a stray `<`, an unbalanced tag,
 * and a scheme that carries script. Each of those has to come back as text, because this is the only
 * thing standing between authored prose and arbitrary markup at the save path.
 */
describe( 'KcdSynth — the inline allowlist', () => {

	it( 'renders the advertised four as real markup mid-paragraph', () => {
		const html = KcdSynth.proseToHtml(
			'Plain, then <strong>bold</strong>, <em>emphasis</em>, <code>a span</code> and '
			+ '<a href="_Claude/references/patterns/x.html">a link</a>.'
		);

		expect( html ).toBe(
			'<p>Plain, then <strong>bold</strong>, <em>emphasis</em>, <code>a span</code> and '
			+ '<a href="_Claude/references/patterns/x.html">a link</a>.</p>'
		);
	} );

	// THE HEADLINE. Where the prose happens to sit decided whether its markup survived.
	it( 'renders identically whether or not the section opens with a block tag', () => {
		const prose   = 'Text with <strong>bold</strong> and <code>code</code> in it.';
		const authored = KcdSynth.proseToHtml( `<p>${ prose }</p>` );

		expect( KcdSynth.proseToHtml( prose ) ).toBe( authored );
	} );

	it( 'gives a list item the same treatment as a paragraph, not a different one', () => {
		const html = KcdSynth.proseToHtml( '- one with <strong>bold</strong>\n- two with <code>code</code>' );

		expect( html ).toContain( '<li>one with <strong>bold</strong></li>' );
		expect( html ).toContain( '<li>two with <code>code</code></li>' );
	} );

	// The behaviour half of the anti-drift pin: a tag advertised but not honoured is the same defect
	// wearing the other face, so the members are read off the constant rather than listed again here.
	it( 'honours every member of the allowlist, derived from the constant', () => {
		for ( const [ tag, attrs ] of Object.entries( PROSE_INLINE_TAGS ) ) {
			const open = `<${ [ tag, ...attrs.map( a => `${ a }="x.html"` ) ].join( ' ' ) }>`;
			expect( KcdSynth.proseToHtml( `before ${ open }inside</${ tag }> after` ) )
				.toBe( `<p>before ${ open }inside</${ tag }> after</p>` );
		}
	} );

	it( 'survives the validator the write path actually runs', () => {
		const { html, report } = build( 'reference', 'synth-inline', {
			sections: {
				location:    'It lives <strong>here</strong>, see <a href="_Claude/references/patterns/alpha.html">alpha</a>.',
				conventions: '- an <em>emphatic</em> rule\n- a <code>literal</code> one',
			},
		} );

		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
		expect( html ).toContain( '<strong>here</strong>' );
		expect( html ).toContain( '<em>emphatic</em>' );
	} );

	describe( 'everything outside the set is still escaped', () => {

		it( 'escapes a tag the allowlist does not hold, script included', () => {
			for ( const tag of [ 'script', 'style', 'div', 'span', 'b', 'i', 'br', 'img' ] ) {
				const html = KcdSynth.proseToHtml( `text <${ tag }>x</${ tag }> text` );
				expect( html ).not.toContain( `<${ tag }` );
				expect( html ).toContain( `&lt;${ tag }&gt;` );
			}
		} );

		it( 'escapes a stray and an unbalanced angle bracket', () => {
			expect( KcdSynth.proseToHtml( 'A value under 5 < 10.' ) ).toBe( '<p>A value under 5 &lt; 10.</p>' );
			expect( KcdSynth.proseToHtml( 'An arrow -> and a < b > c.' ) ).toBe( '<p>An arrow -&gt; and a &lt; b &gt; c.</p>' );
		} );

		it( 'escapes an allowlisted tag that is never closed, rather than letting it run on', () => {
			expect( KcdSynth.proseToHtml( 'Open <strong>and never shut.' ) ).toBe( '<p>Open &lt;strong&gt;and never shut.</p>' );
			expect( KcdSynth.proseToHtml( 'A close </em> with no open.' ) ).toBe( '<p>A close &lt;/em&gt; with no open.</p>' );
		} );

		it( 'keeps the well-nested pair and escapes the mis-nested one', () => {
			// `</strong>` does not match the open `em` on top of the stack, so neither strong tag stands —
			// and the kept set is balanced, which is the property that matters.
			const html = KcdSynth.proseToHtml( 'Mixed <strong><em>up</strong></em> here.' );
			expect( html ).toBe( '<p>Mixed &lt;strong&gt;<em>up&lt;/strong&gt;</em> here.</p>' );
		} );

		it( 'escapes a tag inside <code>, so a tag can be shown as text', () => {
			expect( KcdSynth.proseToHtml( 'Write <code><p></code> for a paragraph.' ) )
				.toBe( '<p>Write <code>&lt;p&gt;</code> for a paragraph.</p>' );
		} );

		it( 'escapes a comment-looking opener rather than treating it as a tag', () => {
			// Comments are stripped before this path, so what is left cannot reach the emitter as markup.
			expect( KcdSynth.proseToHtml( 'A <!doctype html> in prose.' ) ).toContain( '&lt;!doctype' );
		} );
	} );

	describe( 'an attribute it has not permitted refuses the whole tag', () => {

		it( 'refuses an event handler, a style and a target on an anchor', () => {
			for ( const attr of [ 'onclick="steal()"', 'style="position:fixed"', 'target="_blank"', 'class="x"' ] ) {
				const html = KcdSynth.proseToHtml( `See <a href="x.html" ${ attr }>this</a>.` );
				expect( html ).not.toContain( '<a ' );
				expect( html ).toContain( '&lt;a href=' );
			}
		} );

		it( 'refuses an attribute on a tag that takes none', () => {
			expect( KcdSynth.proseToHtml( 'A <strong class="x">word</strong>.' ) ).toContain( '&lt;strong class=' );
		} );

		it( 'refuses an anchor with no href, since the advertised form is <a href>', () => {
			expect( KcdSynth.proseToHtml( 'A <a>bare</a> anchor.' ) ).toBe( '<p>A &lt;a&gt;bare&lt;/a&gt; anchor.</p>' );
		} );

		it( 'refuses the same attribute said twice, which has no rule about which wins', () => {
			expect( KcdSynth.proseToHtml( 'A <a href="a.html" href="b.html">link</a>.' ) ).toContain( '&lt;a href=' );
		} );

		it( 'refuses an unquoted or single-quoted attribute rather than guessing its end', () => {
			expect( KcdSynth.proseToHtml( 'A <a href=x.html>link</a>.' ) ).toContain( '&lt;a href=x.html&gt;' );
			expect( KcdSynth.proseToHtml( "A <a href='x.html'>link</a>." ) ).toContain( '&lt;a href=' );
		} );

		it( 'refuses a quote smuggled in as an entity, rather than letting it break out of the value', () => {
			// The sharpest attempt available: the value carries no raw `"`, so it parses as ONE attribute, and
			// only decoding it reveals the second one hiding inside. Decoding is exactly what the browser would
			// do, which is why the check runs on the decoded value.
			const html = KcdSynth.proseToHtml( 'A <a href="x.html&quot; onclick=&quot;y">link</a>.' );
			expect( html ).not.toContain( '<a ' );
			expect( html ).not.toContain( 'onclick="y"' );
		} );
	} );

	describe( 'an href that carries script', () => {

		it( 'refuses a scheme that is not http, https or mailto', () => {
			for ( const href of [ 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'file:///etc/passwd' ] ) {
				const html = KcdSynth.proseToHtml( `Click <a href="${ href }">here</a>.` );
				expect( html ).not.toContain( '<a ' );
				expect( html ).toContain( '&lt;a href=' );
			}
		} );

		it( 'refuses an obfuscated scheme — entities and control characters decode before the check', () => {
			for ( const href of [ '&#x6a;avascript:alert(1)', '&#106;avascript:alert(1)', 'java&#9;script:alert(1)', ' javascript:alert(1)' ] ) {
				expect( KcdSynth.proseToHtml( `Click <a href="${ href }">here</a>.` ) ).not.toContain( '<a ' );
			}
		} );

		it( 'admits a vault-relative path and an http, https or mailto URL', () => {
			for ( const href of [ '_Claude/references/patterns/alpha.html', '../sibling.html', 'https://example.com/a?b=1&c=2', 'mailto:someone@example.com' ] ) {
				expect( KcdSynth.proseToHtml( `Click <a href="${ href }">here</a>.` ) ).toContain( '<a href=' );
			}
		} );
	} );
} );

describe( 'KcdShapes — the table itself', () => {

	it( 'audits a document against its type and separates required from expected', () => {
		const audit = KcdShapes.audit( 'plan', [ 'goal' ] );
		expect( audit.known ).toBe( true );
		expect( audit.missing ).toEqual( [ 'phases', 'current-state' ] );
		expect( audit.thin ).toEqual( [ 'approach' ] );
	} );

	it( 'is silent about a type it does not govern', () => {
		const audit = KcdShapes.audit( 'no-such-type', [] );
		expect( audit.known ).toBe( false );
		expect( audit.missing ).toEqual( [] );
	} );

	it( 'flags undeclared sections only on a closed type', () => {
		expect( KcdShapes.audit( 'plan', [ 'goal', 'phases', 'current-state', 'bespoke' ] ).unexpected ).toEqual( [] );
		expect( KcdShapes.audit( 'lens', [ 'personality', 'philosophy', 'bespoke' ] ).unexpected ).toEqual( [ 'bespoke' ] );
	} );

	it( 'describes a shape in prose an author can act on', () => {
		const text = KcdShapes.describe( 'plan' );
		expect( text ).toContain( 'goal ( REQUIRED )' );
		expect( text ).toContain( 'nests "phase-*"' );
	} );
} );
