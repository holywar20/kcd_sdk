/**
 * KcdContext.lean — the READ projection ( `get_doc` ), which differs from the compile projection on
 * exactly one axis: air between blocks.
 *
 * What is locked here is the CONTRACT, not the prettiness: that NO tag survives ( markdown carries
 * the structure for a fraction of the tokens ), that the two whitespace exemptions hold ( a `pre`
 * and a real table keep their own ), that a slot row is never flattened into welded text, and — the
 * one with teeth — that `leanArtifact` drops `body` rather than shrinking it, because a stripped
 * body fed back to `save_doc` would gut the document it claims to edit.
 */

import { describe, it, expect } from 'vitest';
import { KcdContext } from '../KcdContext';
import type { SerializedArtifact } from '../../../primitives/types';

const artifact = ( over: Partial<SerializedArtifact> = {} ): SerializedArtifact => ( {
	path:        'references/x.html',
	type:        'reference',
	frontmatter: { name: 'x' },
	sections:    {},
	body:        '',
	links:       [],
	...over,
} );

describe( 'KcdContext.lean — tags', () => {

	it( 'emits NO tags — a heading becomes its markdown hashes at its own level', () => {
		expect( KcdContext.lean( '<h3>Why</h3>' ) ).toBe( '### Why' );
		expect( KcdContext.lean( '<h1>Doc Title</h1>' ) ).toBe( '# Doc Title' );
		expect( KcdContext.lean( '<h2>Know</h2><h4>Deep</h4>' ) ).toBe( '## Know\n#### Deep' );
	} );

	it( 'renders a list as markdown bullets, one per line', () => {
		expect( KcdContext.lean( '<ul>\n\t<li>one</li>\n\t<li>two</li>\n</ul>' ) ).toBe( '- one\n- two' );
		expect( KcdContext.lean( '<ol><li>first</li></ol>' ) ).toBe( '- first' );
	} );

	it( 'strips presentation and wrapper tags, keeping the text', () => {
		expect( KcdContext.lean( '<section data-kcd-section="why"><p>a <strong>bold</strong> claim</p></section>' ) )
			.toBe( 'a bold claim' );
		expect( KcdContext.lean( '<div><blockquote>a summary</blockquote></div>' ) ).toBe( 'a summary' );
	} );

	it( 'strips an anchor to its label — the href rides in the artifact\'s links, not the prose', () => {
		expect( KcdContext.lean( '<p>see <a href="_Claude/references/y.html">y</a> first</p>' ) )
			.toBe( 'see y first' );
	} );

	it( 'separates block siblings so two paragraphs cannot weld into one sentence', () => {
		expect( KcdContext.lean( '<p>First.</p><p>Second.</p>' ) ).toBe( 'First.\nSecond.' );
	} );

	it( 'returns empty for empty or whitespace-only input', () => {
		expect( KcdContext.lean( '' ) ).toBe( '' );
		expect( KcdContext.lean( '   \n\t ' ) ).toBe( '' );
	} );
} );

describe( 'KcdContext.lean — whitespace', () => {

	it( 'removes indentation and blank lines, collapsing inline runs to single spaces', () => {
		const html = '<section>\n\t<p>one\r\n\t\ttwo     three</p>\n\n\t<p>four</p>\n</section>';
		expect( KcdContext.lean( html ) ).toBe( 'one two three\nfour' );
	} );

	it( 'suspends the collapse inside pre, fencing it so the example stays distinguishable', () => {
		const html = '<pre>get_doc { path: "root.html" }\n  depth: 2</pre>';
		expect( KcdContext.lean( html ) ).toBe( '```\nget_doc { path: "root.html" }\n  depth: 2\n```' );
	} );
} );

describe( 'KcdContext.lean — tables', () => {

	it( 'renders a real table as markdown, separator and all, so the header is legible as one', () => {
		const html =
			'<table>' +
			'<thead><tr><th>Name</th><th>Kind</th></tr></thead>' +
			'<tbody><tr><td>model</td><td>enum</td></tr><tr><td>dry-run</td><td>toggle</td></tr></tbody>' +
			'</table>';
		expect( KcdContext.lean( html ) ).toBe(
			'| Name    | Kind |\n' +
			'| ------- | --- |\n' +
			'| model   | enum |\n' +
			'| dry-run | toggle |'
		);
	} );

	it( 'pads columns to their widest cell — the alignment IS the affordance', () => {
		const html = '<table><tr><th>a</th><th>b</th></tr><tr><td>longer</td><td>x</td></tr></table>';
		expect( KcdContext.lean( html ) ).toBe( '| a      | b |\n| ------ | --- |\n| longer | x |' );
	} );

	it( 'leaves a prose column UNPADDED, so one long cell cannot pad every other to its width', () => {
		const prose = 'x'.repeat( KcdContext.PAD_CAP + 1 );
		const html  = `<table><tr><th>k</th><th>note</th></tr><tr><td>a</td><td>${ prose }</td></tr><tr><td>b</td><td>s</td></tr></table>`;
		const lines = KcdContext.lean( html ).split( '\n' );
		expect( lines[ 1 ] ).toBe( '| --- | --- |' );
		expect( lines[ 3 ] ).toBe( '| b   | s |' );
	} );

	it( 'gives a header-less table an EMPTY header rather than promoting its first data row', () => {
		expect( KcdContext.lean( '<table><tr><td>one</td><td>two</td></tr></table>' ) )
			.toBe( '|     |  |\n| --- | --- |\n| one | two |' );
	} );

	it( 'escapes a pipe inside a cell, which would otherwise split it and shift the whole row', () => {
		expect( KcdContext.lean( '<table><tr><th>h</th></tr><tr><td>a | b</td></tr></table>' ) )
			.toBe( '| h |\n| --- |\n| a \\| b |' );
	} );

	it( 'pads a ragged row out to the widest, so no column silently shifts left', () => {
		expect( KcdContext.lean( '<table><tr><th>a</th><th>b</th></tr><tr><td>x</td></tr></table>' ) )
			.toBe( '| a   | b |\n| --- | --- |\n| x   |  |' );
	} );
} );

describe( 'KcdContext.lean — policy shared with the compile path', () => {

	it( 'drops a human-only subtree ( protocol §5 )', () => {
		expect( KcdContext.lean( '<p>kept</p><p data-kcd-audience="human">scaffold note</p>' ) ).toBe( 'kept' );
	} );

	it( 'drops the faux-table header row and the frontmatter dl', () => {
		expect( KcdContext.lean( '<div data-kcd-head><span>What</span></div><p>kept</p>' ) ).toBe( 'kept' );
		expect( KcdContext.lean( '<dl data-kcd-frontmatter><dt>name</dt><dd>x</dd></dl><p>kept</p>' ) ).toBe( 'kept' );
	} );

	it( 'drops the Tools section and any stray tool slot — metadata, never body content', () => {
		expect( KcdContext.lean( '<section data-kcd-section="tools"><p>sm_browser</p></section><p>kept</p>' ) ).toBe( 'kept' );
		expect( KcdContext.lean( '<div data-kcd-slot="tool"><span data-kcd-field="what">x</span></div><p>kept</p>' ) ).toBe( 'kept' );
	} );

	it( 'renders a slot row through slotLine rather than welding its fields together', () => {
		const html =
			'<div data-kcd-slot="reference">' +
			'<span data-kcd-field="what">writing-a-keystone</span>' +
			'<span data-kcd-field="where" data-kcd-type="path"><a href="_Claude/references/k.html">k</a></span>' +
			'<span data-kcd-field="why">before authoring a tool</span>' +
			'</div>';
		expect( KcdContext.lean( html ) )
			.toBe( '- writing-a-keystone — before authoring a tool (_Claude/references/k.html)' );
	} );
} );

describe( 'KcdContext.leanArtifact', () => {

	it( 'DROPS body rather than stripping it — a stripped body would gut the save_doc round trip', () => {
		const lean = KcdContext.leanArtifact( artifact( { body: '<section data-kcd-section="why"><p>a</p></section>' } ) );
		expect( 'body' in lean ).toBe( false );
	} );

	it( 'leans every section and keeps the rest of the shape intact', () => {
		const lean = KcdContext.leanArtifact( artifact( {
			sections: { why: '<h3>Why</h3>\n\t<p>because   so</p>' },
			links:    [ { text: 'y', href: '_Claude/y.html', type: 'internal' } ],
		} ) );
		expect( lean.sections ).toEqual( { why: '### Why\nbecause so' } );
		expect( lean.path ).toBe( 'references/x.html' );
		expect( lean.type ).toBe( 'reference' );
		expect( lean.frontmatter ).toEqual( { name: 'x' } );
		expect( lean.links ).toHaveLength( 1 );
	} );

	it( 'drops a section that projects to nothing rather than claiming it exists and is blank', () => {
		const lean = KcdContext.leanArtifact( artifact( {
			sections: { tools: '<section data-kcd-section="tools"><p>x</p></section>', why: '<p>kept</p>' },
		} ) );
		expect( Object.keys( lean.sections ) ).toEqual( [ 'why' ] );
	} );

	it( 'recurses into a lens\'s dredged nodes, leaning each the same way', () => {
		const lens = {
			...artifact( { type: 'lens', sections: { purpose: '<p>p</p>' } } ),
			nodes: [ artifact( { path: 'habits/h.html', type: 'habit', body: '<p>b</p>', sections: { why: '<p>w</p>' } } ) ],
		} as SerializedArtifact;
		const lean = KcdContext.leanArtifact( lens );
		expect( lean.nodes ).toHaveLength( 1 );
		expect( lean.nodes![ 0 ].sections ).toEqual( { why: 'w' } );
		expect( 'body' in lean.nodes![ 0 ] ).toBe( false );
	} );
} );
