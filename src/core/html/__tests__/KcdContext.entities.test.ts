/**
 * The PROJECTION-side entity decode — the other end of the seam `HtmlTree.entities.test.ts` locks.
 *
 * `HtmlTree.decode` knows five entities and must never learn a sixth: it is one half of a round trip
 * ( parse → serialize ) that every `kcd_save` runs, and widening it corrodes the entities it does not
 * own. So the vault's ~1,600 authored `&mdash;` / `&rdquo;` / `&rarr;` runs reached agents as LITERAL
 * TEXT, several tokens each, reading as noise in every compiled context and every `kcd_get`.
 *
 * The decode therefore lives HERE, on the way out to agent text, where nothing is written back. What
 * this file locks is both halves of that claim: that agent-facing text comes out decoded on every path
 * that produces it, and that the disk round trip is exactly as untouched as it was before.
 */

import { describe, it, expect } from 'vitest';
import { KcdContext } from '../KcdContext';
import { HtmlTree } from '../HtmlTree';
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

describe( 'KcdContext — entity decode, compile path', () => {

	it( 'decodes the census entities in projected prose', () => {
		expect( KcdContext.body( '<p>a &mdash; b</p>' ) ).toBe( 'a — b' );
		expect( KcdContext.body( '<p>&ldquo;quoted&rdquo; and it&rsquo;s</p>' ) ).toBe( '“quoted” and it’s' );
		expect( KcdContext.body( '<p>read &rarr; act &middot; then stop</p>' ) ).toBe( 'read → act · then stop' );
		expect( KcdContext.body( '<p>&hellip; &ndash; &lsquo;x&rsquo; &bull; &times; &deg;</p>' ) ).toBe( '… – ‘x’ • × °' );
	} );

	it( 'folds a decoded &nbsp; into the run around it rather than leaving a stray U+00A0', () => {
		const out = KcdContext.body( '<p>a&nbsp;b</p>' );
		expect( out ).toBe( 'a b' );
		expect( out ).not.toContain( ' ' );
	} );

	it( 'leaves an entity it does not own exactly as authored — it decodes, it never guesses', () => {
		expect( KcdContext.body( '<p>&frac12; &copy; &zzz;</p>' ) ).toBe( '&frac12; &copy; &zzz;' );
	} );

	it( 'decodes the projected frontmatter keep-set, where description is the densest carrier', () => {
		expect( KcdContext.frontmatter( { name: 'x', description: 'a &mdash; b', status: 'active' } ) )
			.toBe( 'name: x\ndescription: a — b\nstatus: active' );
	} );

	it( 'decodes inside a pre fence — the one projected text path that skips inline()', () => {
		expect( KcdContext.body( '<pre>one &mdash; two\n  three</pre>' ) )
			.toBe( '```\none — two\n  three\n```' );
	} );
} );

describe( 'KcdContext — entity decode, slot rows', () => {

	it( 'decodes a document slot\'s what and why, and leaves where verbatim', () => {
		const html =
			'<div data-kcd-slot="reference">' +
			'<span data-kcd-field="what">writing-a-keystone</span>' +
			'<span data-kcd-field="where" data-kcd-type="path"><a href="_Claude/references/k.html">k</a></span>' +
			'<span data-kcd-field="why">declare the gates &mdash; or it will not arm</span>' +
			'</div>';
		expect( KcdContext.body( html ) )
			.toBe( '- writing-a-keystone — declare the gates — or it will not arm (_Claude/references/k.html)' );
	} );

	// The roster path: `Agent` builds these rows straight off a lens's frontmatter and never touches
	// `readSlot`, so a decode placed there instead of in `renderRow` would miss every one of them.
	it( 'decodes a row handed in already-structured, not read from a document', () => {
		expect( KcdContext.renderRow( { what: 'render', where: '_Claude/lenses/render.html', why: 'the UI lens &mdash; read it first' } ) )
			.toBe( '- render — the UI lens — read it first (_Claude/lenses/render.html)' );
	} );

	it( 'leaves a where verbatim — it is a route retyped and deduped on, not prose', () => {
		expect( KcdContext.renderRow( { what: 'x', where: 'https://h/q?a=1&amp;b=2', why: '' } ) )
			.toBe( '- x (https://h/q?a=1&amp;b=2)' );
	} );
} );

describe( 'KcdContext — entity decode, read path', () => {

	it( 'decodes in the lean projection too — same text, same table', () => {
		expect( KcdContext.lean( '<p>a &mdash; b</p><p>it&rsquo;s &rarr; here</p>' ) ).toBe( 'a — b\nit’s → here' );
	} );

	it( 'decodes the lean shape\'s frontmatter, where every read pays for description', () => {
		const lean = KcdContext.leanArtifact( artifact( {
			frontmatter: { name: 'x', description: 'a &mdash; b', tags: [ 'one &rarr; two' ], schemaVersion: 2 },
		} ) );
		expect( lean.frontmatter ).toEqual( { name: 'x', description: 'a — b', tags: [ 'one → two' ], schemaVersion: 2 } );
	} );

	it( 'does NOT touch the caller\'s artifact — the full read is the kcd_save payload and stays authored', () => {
		const a = artifact( { frontmatter: { name: 'x', description: 'a &mdash; b' } } );
		KcdContext.leanArtifact( a );
		expect( a.frontmatter[ 'description' ] ).toBe( 'a &mdash; b' );
	} );
} );

describe( 'KcdContext — the disk seam is unmoved', () => {

	// The whole reason the table lives on this side. If this ever fails, the decode leaked into the
	// parse → serialize pass `kcd_save` runs, and documents are being corroded on every edit.
	it( 'leaves the HtmlTree round trip exactly as it was — entities survive a save untouched', () => {
		const html = '<p>a &mdash; b &rsquo; c &nbsp; d</p>';
		expect( HtmlTree.innerHtml( HtmlTree.parse( html ) ) ).toBe( html );
	} );
} );
