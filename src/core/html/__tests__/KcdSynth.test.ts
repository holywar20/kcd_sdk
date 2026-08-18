import { describe as describeProse, it as itProse, expect as expectProse } from 'vitest';
import { KcdSynth as Synth } from '../KcdSynth';

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
	return { body, undeclared, html, report: KcdValidate.validate( html ) };
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

		const parsed = KcdParse.parse( html, 'synth-round.html' );
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
		// Also found live: the advisory audited prose keys only, so a lens whose `habits` arrived as
		// ROWS was reported missing `habits`.
		const supplied = KcdSynth.suppliedSections( {
			sections: { purpose: 'p', philosophy: 'q' },
			slots:    [ { section: 'habits', rows: [ { what: 'track-todo-liberal' } ] } ],
		} );

		expect( supplied ).toContain( 'habits' );
		expect( KcdShapes.audit( 'lens', supplied ).thin ).not.toContain( 'habits' );
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

	it( 'wraps a lens\'s sections in their Know/Care/Do regions', () => {
		const { html, report } = build( 'lens', 'synth-lens', {
			sections: { purpose: 'What it governs.', philosophy: 'What it defends.' },
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).toContain( '<section data-kcd-region="care">' );

		const care    = html.indexOf( 'data-kcd-region="care"' );
		const purpose = html.indexOf( 'data-kcd-section="purpose"' );
		expect( care ).toBeLessThan( purpose );
	} );

	it( 'emits slot rows as a faux-table with a real href, and validates', () => {
		const { html, report } = build( 'lens', 'synth-slots', {
			sections: { purpose: 'p', philosophy: 'q' },
			slots: [ {
				section: 'habits',
				rows: [ { what: 'track-todo-liberal', where: '_Claude/habits/track-todo/track-todo-liberal.html', why: 'when a deferred item surfaces' } ],
			} ],
		} );

		expect( report.errors ).toEqual( [] );
		expect( html ).toContain( '<div data-kcd-table>' );
		expect( html ).toContain( 'data-kcd-slot="habit"' );          // kind defaulted from the shape
		expect( html ).toContain( 'href="_Claude/habits/track-todo/track-todo-liberal.html"' );
		expect( html ).not.toContain( '<table' );                      // never a real table
	} );

	it( 'defaults an unknown slot kind to table-data rather than emitting an invalid one', () => {
		const { report } = build( 'lens', 'synth-badkind', {
			sections: { purpose: 'p', philosophy: 'q' },
			slots:    [ { section: 'habits', kind: 'not-a-kind', rows: [ { what: 'x' } ] } ],
		} );
		expect( report.errors ).toEqual( [] );
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
		expect( KcdShapes.audit( 'lens', [ 'purpose', 'philosophy', 'bespoke' ] ).unexpected ).toEqual( [ 'bespoke' ] );
	} );

	it( 'describes a shape in prose an author can act on', () => {
		const text = KcdShapes.describe( 'plan' );
		expect( text ).toContain( 'goal ( REQUIRED )' );
		expect( text ).toContain( 'nests "phase-*"' );
	} );
} );
