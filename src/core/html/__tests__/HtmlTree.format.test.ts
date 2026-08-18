import { describe, it, expect } from 'vitest';
import { HtmlTree } from '../HtmlTree';

/**
 * The pretty-printer seam ( 2026-08-17 ).
 *
 * `serialize` emitted no newlines at all, and `parse` collapses every whitespace-only run to a single
 * space — so every document written through `kcd_save` came out as ONE PHYSICAL LINE. `KcdSynth` built
 * indented markup and `KcdEmit.spliceFrontmatter` re-parsed it through `HtmlTree` in the same call and
 * threw the formatting away: two halves of one pipeline undoing each other.
 *
 * The danger in fixing it is the opposite defect. Whitespace between BLOCK elements renders to nothing
 * and is free to use for structure; whitespace between INLINE elements is rendered content, and
 * injecting a newline there splits or welds words. These cases exist to pin that line, because a weld
 * is invisible in a diff and obvious only to a reader.
 */

const round = ( html: string ) => HtmlTree.innerHtml( HtmlTree.parse( html ) );

describe( 'HtmlTree.serialize — block structure', () => {

	it( 'gives each block child its own line, indented one level per depth', () => {
		const out = round( '<section><h2>Title</h2><p>Body</p></section>' );
		expect( out ).toBe( '<section>\n\t<h2>Title</h2>\n\t<p>Body</p>\n</section>' );
	} );

	it( 'nests indentation with depth rather than flattening at level one', () => {
		const out = round( '<div><section><p>deep</p></section></div>' );
		expect( out ).toBe( '<div>\n\t<section>\n\t\t<p>deep</p>\n\t</section>\n</div>' );
	} );

	it( 'separates sibling blocks at the top level', () => {
		expect( round( '<p>one</p><p>two</p>' ) ).toBe( '<p>one</p>\n<p>two</p>' );
	} );
} );

describe( 'HtmlTree.serialize — inline runs are never reformatted', () => {

	/**
	 * THE WELD. `</strong> <code>` carries a significant space; drop or newline it and the rendered text
	 * reads "canonical:_Claude". `parse` already preserves that space as a single-space text node — this
	 * asserts `serialize` does not then destroy it.
	 */
	it( 'preserves the significant space between two inline elements', () => {
		const out = round( '<p><strong>canonical:</strong> <code>_Claude</code></p>' );
		expect( out ).toBe( '<p><strong>canonical:</strong> <code>_Claude</code></p>' );
		expect( out ).not.toContain( '</strong>\n' );
	} );

	it( 'keeps a paragraph of mixed text and inline markup on ONE line', () => {
		const src = '<p>Some <em>emphasis</em> and <a href="x.html">a link</a> inline.</p>';
		expect( round( src ) ).toBe( src );
	} );

	it( 'does not split a block whose only children are text', () => {
		expect( round( '<li>just text</li>' ) ).toBe( '<li>just text</li>' );
	} );

	// A list is blocky ( its <li> children are blocks ) but each <li> is an inline run. Both rules
	// apply in one structure, which is the common shape in this corpus.
	it( 'breaks the list and keeps each item intact', () => {
		const out = round( '<ul><li>alpha</li><li>beta <code>x</code></li></ul>' );
		expect( out ).toBe( '<ul>\n\t<li>alpha</li>\n\t<li>beta <code>x</code></li>\n</ul>' );
	} );
} );

describe( 'HtmlTree.serialize — whitespace-significant and raw content', () => {

	// <pre> is deliberately NOT in RAW ( the double-escape trade is pinned in HtmlTree.entities ), so
	// it needs its own guard here: reformatting it changes what the reader sees.
	it( 'never reformats <pre>', () => {
		const src = '<pre><code>line one\n  indented two\n</code></pre>';
		expect( round( src ) ).toBe( src );
	} );

	it( 'leaves a <style> block byte-exact', () => {
		const src = '<div><style>\nbody { color:#fff; }\n</style></div>';
		expect( round( src ) ).toContain( '<style>\nbody { color:#fff; }\n</style>' );
	} );
} );

describe( 'HtmlTree.serialize — stability', () => {

	/**
	 * IDEMPOTENCE IS THE LOAD-BEARING PROPERTY. Every `kcd_save` re-parses and re-serializes the whole
	 * body, so a printer that is not a fixed point would churn the file on every write — a diff on every
	 * save that touched nothing, which is worse than the flattening it replaced.
	 */
	it( 'is a fixed point — a second pass changes nothing', () => {
		const src = '<section data-kcd-section="x"><h2>T</h2><p>Body with <code>code</code> in it.</p>'
			+ '<ul><li>one</li><li>two</li></ul></section>';
		const once  = round( src );
		const twice = round( once );
		expect( twice ).toBe( once );
	} );

	/**
	 * Content survives; SPACING BETWEEN BLOCKS may change, and that is the improvement rather than the
	 * regression. `textOf` concatenates a subtree with no separator, so on a flattened
	 * `<h2>T</h2><p>alpha…` it returned `Talpha` — two blocks welded into one word. Pretty-printing
	 * puts a newline there, so the same read gives `T alpha`.
	 *
	 * Asserting exact string equality across the round trip would therefore pin the WELD as correct.
	 * The real invariant is that no content is lost and word order holds — checked here — while the
	 * inline-spacing cases above pin the half where exact spacing genuinely matters.
	 *
	 * Nothing in the compile path was affected either way: `KcdContext.block()` dispatches per element
	 * and only ever calls `inline()` on a leaf block, never on a multi-block container. Verified before
	 * this comment was written, because the tempting claim — "the flattening was corrupting compiled
	 * context" — is false.
	 */
	// Asserted against the CORRECT reading, not against the source — the source carries the weld
	// ( `Talpha` ), so comparing the two would pin the defect as the expected result.
	it( 'preserves every word and their order across a round trip', () => {
		const src = '<section><h2>T</h2><p>alpha <strong>beta</strong> gamma</p></section>';
		const words = ( html: string ) => HtmlTree.textOf( HtmlTree.parse( html ) ).split( /\s+/ ).filter( Boolean );
		expect( words( round( src ) ) ).toEqual( [ 'T', 'alpha', 'beta', 'gamma' ] );
	} );

	it( 'adds a block boundary that textOf can see, rather than welding two blocks', () => {
		const src = '<section><h2>Heading</h2><p>Body</p></section>';
		expect( HtmlTree.textOf( HtmlTree.parse( src ) ) ).toBe( 'HeadingBody' );
		expect( HtmlTree.textOf( HtmlTree.parse( round( src ) ) ) ).toContain( 'Heading Body' );
	} );

	// The whole point: a real artifact body must stop being one line.
	it( 'emits a multi-line body where the old serializer emitted one line', () => {
		const src = '<h1>Doc</h1><section data-kcd-section="a"><h2>A</h2><p>text</p></section>'
			+ '<section data-kcd-section="b"><h2>B</h2><p>more</p></section>';
		expect( round( src ).split( '\n' ).length ).toBeGreaterThan( 6 );
	} );
} );
