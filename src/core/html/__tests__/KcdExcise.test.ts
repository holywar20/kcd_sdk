import { describe, it, expect } from 'vitest';
import { KcdExcise } from '../KcdExcise';

// A faux-table with two slot records ( the KCD reference-table shape ) plus a prose paragraph that
// also links one of the targets — the three cases the excision must tell apart.
const DOC = `<div data-kcd-table>
	<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
	<div data-kcd-slot>
		<span data-kcd-field="what" data-kcd-type="text">Keep Me</span>
		<a data-kcd-field="where" data-kcd-type="path" href="_Claude/refs/keep.html">keep</a>
		<span data-kcd-field="why" data-kcd-type="text">stays</span>
	</div>
	<div data-kcd-slot>
		<span data-kcd-field="what" data-kcd-type="text">Drop Me</span>
		<a data-kcd-field="where" data-kcd-type="path" href="_Claude/refs/gone.html">gone</a>
		<span data-kcd-field="why" data-kcd-type="text">goes</span>
	</div>
</div>
<p>See the <a href="_Claude/refs/gone.html">gone note</a> for context.</p>`;

const isGone = ( href: string ): boolean => href === '_Claude/refs/gone.html';

describe( 'KcdExcise.html', () => {
	it( 'removes the whole slot record whose where-link matches', () => {
		const out = KcdExcise.html( DOC, isGone );
		expect( out ).not.toContain( 'Drop Me' );
		expect( out ).not.toContain( 'href="_Claude/refs/gone.html"' );
		// the sibling record + the head survive byte-for-byte
		expect( out ).toContain( '<span data-kcd-field="what" data-kcd-type="text">Keep Me</span>' );
		expect( out ).toContain( '<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>' );
	} );

	it( 'unwraps a bare prose link to its own text, sentence intact', () => {
		const out = KcdExcise.html( DOC, isGone );
		expect( out ).toContain( 'See the gone note for context.' );
		expect( out ).not.toContain( '<a href="_Claude/refs/gone.html">' );
	} );

	it( 'leaves the whole source untouched when nothing matches', () => {
		expect( KcdExcise.html( DOC, () => false ) ).toBe( DOC );
	} );

	it( 'does not leave a blank line where a record was', () => {
		const out = KcdExcise.html( DOC, isGone );
		expect( out ).not.toMatch( /\n\s*\n\s*\n/ );
	} );
} );

describe( 'KcdExcise.js', () => {
	it( 'unwraps a matching markdown link, leaves others', () => {
		const src = 'see [gone](_Claude/refs/gone.html) and [keep](_Claude/refs/keep.html)';
		const out = KcdExcise.js( src, isGone );
		expect( out ).toBe( 'see gone and [keep](_Claude/refs/keep.html)' );
	} );
} );
