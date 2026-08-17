import { describe, it, expect } from 'vitest';
import { HtmlTree, type HtmlEl } from '../HtmlTree';
import { KcdEmit } from '../KcdEmit';

/**
 * The entity seam — `decode` and `escapeText`/`escapeAttr` are two halves of ONE round trip, and the
 * defect this file locks down was them disagreeing. `decode` knows a handful of entities and passes
 * every other one through as literal text; escaping used to add `&amp;` to every `&` unconditionally,
 * so `&mdash;` came back out of a parse → serialize pass as `&amp;mdash;` and rendered as literal text
 * to the reader. Every `kcd_save` runs that pass ( `KcdEmit.spliceFrontmatter` ), so any edit to a
 * document corroded the entities it never touched.
 *
 * The acceptance question is therefore not "does escaping work" but "do the two halves agree" — which
 * only a round trip can answer. Hence `trip()` rather than assertions on either half alone.
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
	 * KNOWN LIMITATION, pinned deliberately — the cost side of the trade above.
	 *
	 * `decode` is PARTIAL, and that makes it non-injective: source `&mdash;` and source `&amp;mdash;`
	 * both decode to the same text, so NO stateless escape can restore both. The information is gone
	 * before escaping is reached. Some direction must lose, and the chosen one is this: a DOUBLE-escaped
	 * entity ( text that means to display `&lt;` to the reader ) loses one layer on the first save, then
	 * holds. It is the rarer loss — it only reaches text shaped like `&word;`, in practice a `<pre>` code
	 * sample about escaping — where the old behaviour corroded ordinary prose typography on every save.
	 *
	 * Closing this properly means an injective decode ( a full named-entity table ) or `<pre>` treated as
	 * raw and spliced verbatim. Both are their own pass. Until then this test is the honest record: if it
	 * starts failing, someone changed the trade, and that should be on purpose.
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
 * The defect's real blast radius: `KcdEmit.emit` is what every `kcd_save` runs, and it re-parses and
 * re-serializes the whole body to splice fresh frontmatter in. Both save paths — body passthrough and
 * content synthesis — land here, so this is the assertion that matters to a reader of the corpus.
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
 * RAW content ( <script> / <style> ) — the other half of the same seam, and the half that was missing.
 *
 * `parse` has a RAW branch that slices these elements' contents out VERBATIM; it is the single text path
 * that skips `decode`. `serialize` had no matching branch until 2026-08-13, so raw text went through
 * `escapeText` like ordinary prose and `a > b` became `a &gt; b` on the first save. One-time and then
 * stable — the negative lookahead protects `&gt;` on every later pass — which is worse than compounding:
 * nothing ever gets visibly worse, so nothing prompts anyone to look.
 *
 * The blast radius is not cosmetic. Protocol §10 seed payloads are MARKDOWN inside
 * `<script type="text/kcd-md">`, `>` is markdown's blockquote character, and `daedalus seed` extracts
 * those payloads with a regex straight off disk — so an escape written here lands verbatim in a real
 * project's CLAUDE.md. Worse, the WHOLE BODY is re-serialized on every save, so corrupting the payloads
 * never required touching them: editing a neighbouring table was enough.
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
 * The breakout guard — the reason verbatim emission is safe rather than merely correct.
 *
 * Raw text has no entity escaping ( `&lt;` is not decoded there ), so content carrying its own end tag is
 * UNREPRESENTABLE, not awkward: writing `&lt;/script` would leave those literal characters in the payload
 * while making the document look repaired. Emitting it raw is worse — the element ends early on the next
 * read and everything after it re-tokenizes as markup, so what comes back is a different tree from what
 * was written. That is the shape every raw-text injection takes.
 *
 * `parse` cannot produce such a node. Only a hand-built or DOM-sourced one can, which makes it a caller
 * bug, which is exactly what should fail loudly.
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

	/**
	 * Guard and lexer must agree. Anything `parse` would end the element at, `serialize` must refuse to
	 * emit — a gap between what the writer permits and what the reader stops at is the affordance a
	 * breakout needs. This asserts the property directly: whatever survives serialization re-parses to
	 * one element with its payload intact, and nothing leaks out beside it.
	 */
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
