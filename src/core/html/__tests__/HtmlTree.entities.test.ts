import { describe, it, expect } from 'vitest';
import { HtmlTree, type HtmlEl } from '../HtmlTree';
import { KcdEmit } from '../KcdEmit';

/**
 * `decode` and `escapeText`/`escapeAttr` are one round trip. Escaping must not add a layer to entities `decode`
 * does not own (`&mdash;` would come back as `&amp;mdash;` on every save), so the test is the round trip, not either half alone.
 */
function trip( html: string ): string {
	return HtmlTree.innerHtml( HtmlTree.parse( html ) );
}

describe( 'HtmlTree — entity round trip', () => {

	it( 'a named entity outside the decode set round-trips unchanged', () => {
		expect( trip( '<p>a &mdash; b</p>' ) ).toBe( '<p>a &mdash; b</p>' );
		expect( trip( '<p>it&rsquo;s</p>' ) ).toBe( '<p>it&rsquo;s</p>' );
		expect( trip( '<p>a&nbsp;b</p>' ) ).toBe( '<p>a&nbsp;b</p>' );
	} );

	// The regression itself, stated as the reader sees it: no layer is added, on any pass.
	it( 'stays stable across repeated round trips — no layer added, ever', () => {
		let html = '<p>a &mdash; b &amp; c &lt; d</p>';
		for ( let i = 0; i < 3; i++ ) html = trip( html );
		expect( html ).toBe( '<p>a &mdash; b &amp; c &lt; d</p>' );
		expect( html ).not.toContain( '&amp;mdash;' );
	} );

	it( 'a bare & is still escaped', () => {
		expect( trip( '<p>Tom & Jerry</p>' ) ).toBe( '<p>Tom &amp; Jerry</p>' );
		expect( HtmlTree.escapeText( 'a & b' ) ).toBe( 'a &amp; b' );
	} );

	it( '&amp; and &lt; still round-trip', () => {
		expect( trip( '<p>&amp;</p>' ) ).toBe( '<p>&amp;</p>' );
		expect( trip( '<p>&lt;tag&gt;</p>' ) ).toBe( '<p>&lt;tag&gt;</p>' );
		expect( trip( '<p>&quot;q&quot;</p>' ) ).toBe( '<p>"q"</p>' );
	} );

	// An entity `decode` DOES own resolves to its character and stays there — the same glyph to the
	// reader, so this is normalization, not the corruption above. Only unowned entities stay textual.
	it( 'a decoded entity normalizes to its character and holds', () => {
		expect( trip( '<p>&#8212;</p>' ) ).toBe( '<p>—</p>' );
		expect( trip( '<p>—</p>' ) ).toBe( '<p>—</p>' );
	} );

	/**
	 * KNOWN LIMITATION, pinned on purpose. `decode` is partial, so `&mdash;` and `&amp;mdash;` decode to the same
	 * text and no stateless escape restores both. A double-escaped entity loses one layer on the first save, then holds.
	 * If this starts failing, the trade changed and it should be deliberate.
	 */
	it( 'loses one layer from a double-escaped entity — the accepted trade, stable after', () => {
		expect( trip( '<p>&amp;amp;</p>' ) ).toBe( '<p>&amp;</p>' );
		expect( trip( '<pre>&amp;lt;div&amp;gt;</pre>' ) ).toBe( '<pre>&lt;div&gt;</pre>' );
		expect( trip( trip( '<pre>&amp;lt;div&amp;gt;</pre>' ) ) ).toBe( '<pre>&lt;div&gt;</pre>' );
	} );

	// Idempotence is the property the fix actually buys — everything above is a consequence of it.
	it( 'escaping twice equals escaping once', () => {
		const text = 'a &mdash; b & c < d > e';
		expect( HtmlTree.escapeText( HtmlTree.escapeText( text ) ) ).toBe( HtmlTree.escapeText( text ) );

		const attr = 'https://x.test/?a=1&b=2&amp;c=3 "quoted"';
		expect( HtmlTree.escapeAttr( HtmlTree.escapeAttr( attr ) ) ).toBe( HtmlTree.escapeAttr( attr ) );
	} );

	// escapeAttr got the same rule; the quoting guarantee it exists for must survive it.
	it( 'an attribute value keeps its entity, and still cannot break out of its quotes', () => {
		expect( trip( '<a title="a &mdash; b">x</a>' ) ).toBe( '<a title="a &mdash; b">x</a>' );
		expect( trip( '<a href="?a=1&amp;b=2">x</a>' ) ).toBe( '<a href="?a=1&amp;b=2">x</a>' );
		expect( HtmlTree.escapeAttr( 'he said "hi"' ) ).toBe( 'he said &quot;hi&quot;' );
	} );
} );

/**
 * Every `save_doc` runs `KcdEmit.emit`, which re-serializes the whole body, so this is the corpus-facing assertion.
 */
describe( 'KcdEmit — entities survive a save', () => {

	const BODY = `<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">entity-fixture</dd>
</dl>
<h1>Entity fixture</h1>
<p>A dash &mdash; a quote &rsquo; a space&nbsp;and an ampersand &amp; a bare one: Tom & Jerry.</p>`;

	function save() {
		return KcdEmit.emit( {
			path:        'entity-fixture.html',
			type:        'reference',
			frontmatter: { name: 'entity-fixture', description: 'Entity round-trip fixture.', type: 'reference', status: 'active' },
			sections:    {},
			body:        BODY,
			links:       [],
		} as any );
	}

	it( 'emits &mdash; and not &amp;mdash;', () => {
		const html = save();
		expect( html ).toContain( 'A dash &mdash; a quote &rsquo; a space&nbsp;and an ampersand &amp; a bare one: Tom &amp; Jerry.' );
		expect( html ).not.toContain( '&amp;mdash;' );
		expect( html ).not.toContain( '&amp;rsquo;' );
		expect( html ).not.toContain( '&amp;nbsp;' );
	} );

	it( 'is stable when the same document is saved again', () => {
		const once  = save();
		const twice = KcdEmit.emit( {
			path:        'entity-fixture.html',
			type:        'reference',
			frontmatter: { name: 'entity-fixture', description: 'Entity round-trip fixture.', type: 'reference', status: 'active' },
			sections:    {},
			body:        HtmlTree.innerHtml( HtmlTree.parse( BODY ) ),
			links:       [],
		} as any );
		expect( twice ).toBe( once );
	} );
} );

/**
 * Raw text (`<script>`, `<style>`) is the other half of the seam: `parse` slices it verbatim, so `serialize` must too.
 * Escaping it once corrupted `a > b` on the first save; §10 seed payloads are markdown that land verbatim in a project's CLAUDE.md.
 */
describe( 'HtmlTree — raw content round-trips verbatim', () => {

	it( 'a CSS child selector survives — the case that named the defect', () => {
		expect( trip( '<style>a > b { color: red }</style>' ) ).toBe( '<style>a > b { color: red }</style>' );
	} );

	it( 'a script payload keeps <, > and & exactly', () => {
		const js = '<script>if ( a < b && c > d ) go( "<x>" );</script>';
		expect( trip( js ) ).toBe( js );
	} );

	// The §10 shape itself: markdown inside a non-executing script container.
	it( 'a seed payload keeps its markdown blockquote, its entity, and its angle brackets', () => {
		const seed = '<script type="text/kcd-md" data-kcd-seed="claude" data-kcd-target="CLAUDE.md">\n'
			+ '> Note: use A & B when x > y.\n'
			+ 'An &mdash; entity, and a <tag>.\n'
			+ '</script>';
		expect( trip( seed ) ).toBe( seed );
	} );

	it( 'stays stable across repeated round trips', () => {
		const seed = '<script type="text/kcd-md">> quote & more < less</script>';
		let html = seed;
		for ( let i = 0; i < 3; i++ ) html = trip( html );
		expect( html ).toBe( seed );
	} );

	/** The <pre> trade pinned above is <pre>-ONLY and must stay that way. If someone "simplifies" by
	 *  adding `pre` to RAW, this flips and the accepted double-escape behaviour changes silently. */
	it( 'does NOT extend raw treatment to <pre>', () => {
		expect( HtmlTree.RAW.has( 'pre' ) ).toBe( false );
		expect( trip( '<pre>&amp;lt;div&amp;gt;</pre>' ) ).toBe( '<pre>&lt;div&gt;</pre>' );
	} );
} );

/**
 * Raw content cannot carry its own end tag: no entity escaping exists there, and emitting it raw ends the element early.
 * `serialize` refuses it, so a hand-built node fails loudly as a caller bug.
 */
describe( 'HtmlTree — raw breakout is refused, not repaired', () => {

	const rawEl = ( tag: string, value: string ): HtmlEl =>
		( { type: 'el', tag, attrs: {}, kids: [ { type: 'text', value } ] } );

	it( 'refuses a script whose content closes it', () => {
		expect( () => HtmlTree.serialize( rawEl( 'script', 'var a = "</script>"' ) ) )
			.toThrow( /cannot be represented/ );
	} );

	it( 'refuses case variants and the bare prefix the lexer stops at', () => {
		expect( () => HtmlTree.serialize( rawEl( 'script', '</SCRIPT>' ) ) ).toThrow();
		expect( () => HtmlTree.serialize( rawEl( 'script', 'x</script' ) ) ).toThrow();
	} );

	it( 'refuses a style that closes itself', () => {
		expect( () => HtmlTree.serialize( rawEl( 'style', 'a{}</style>' ) ) ).toThrow();
	} );

	it( 'allows the split-at-source form the error message tells a caller to write', () => {
		expect( () => HtmlTree.serialize( rawEl( 'script', 'var a = "<\\/script>"' ) ) ).not.toThrow();
	} );

	/** The writer and the reader must agree on the end tag, or a gap between them is the breakout. */
	it( 'nothing that survives serialize can terminate its own element on a re-parse', () => {
		const payload = 'plain content with < and > and & but no end tag';
		const html    = HtmlTree.serialize( rawEl( 'script', payload ) );
		const kids    = HtmlTree.parse( html ).kids;
		const els     = kids.filter( HtmlTree.isEl );
		expect( els.length ).toBe( 1 );
		expect( els[ 0 ].tag ).toBe( 'script' );
		expect( HtmlTree.textOf( els[ 0 ] ) ).toBe( payload );
	} );
} );
