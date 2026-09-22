import { describe, expect, it } from 'vitest';

import { LensMigration } from '../LensMigration';
import { KcdValidate } from '../KcdValidate';
import { VaultLayout } from '../../VaultLayout';

/**
 * The hard cut ( plan agents-own-behaviour, tasks 63 and 66 ): a Know / Care / Do lens is refused, and
 * `LensMigration.flatten` rewrites one into personality + philosophy + references with its prose untouched.
 */

const validate = ( html: string ) => KcdValidate.validate( html, { docRoot: VaultLayout.DEFAULT_DOC_ROOT } );
const codes    = ( html: string ) => validate( html ).errors.map( ( e ) => e.code );

const REF = ( href: string, mode = '' ) =>
	`<div data-kcd-slot="reference"${ mode ? ` data-kcd-mode="${ mode }"` : '' }><span data-kcd-field="what" data-kcd-type="text">${ href }</span>`
	+ `<a data-kcd-field="where" data-kcd-type="path" href="_Claude/references/${ href }.html">${ href }</a>`
	+ `<span data-kcd-field="why" data-kcd-type="text">why ${ href }</span></div>`;

const OLD = `<!DOCTYPE html>
<html><head><title>driver</title></head><body>

<article data-kcd="lens">
<dl data-kcd-frontmatter>
	<dt>name</dt>
	<dd data-kcd-field="name" data-kcd-type="slug">driver</dd>
	<dt>description</dt>
	<dd data-kcd-field="description" data-kcd-type="text">The orchestration lens.</dd>
	<dt>type</dt>
	<dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
	<dt>status</dt>
	<dd data-kcd-field="status" data-kcd-type="enum">active</dd>
	<dt>base</dt>
	<dd data-kcd-field="base" data-kcd-type="slug">_lens-base</dd>
</dl>
<h1>Driver — Lens</h1>
<p><em>The orchestration   lens, in its author's own spacing.</em></p>
<section data-kcd-region="know">
	<h2>Know</h2>
	<p><em>Read-only inputs.</em></p>
	<section data-kcd-section="references">
		<h3>References</h3>
		<div data-kcd-table>
			<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
			${ REF( 'pipeline', 'load' ) }
			${ REF( 'vocabulary' ) }
		</div>
	</section>
	<section data-kcd-section="domains">
		<h3>Domains</h3>
		<div data-kcd-table>
			<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
			<div data-kcd-slot="reference"><span data-kcd-field="what" data-kcd-type="text">Navigator</span><a data-kcd-field="where" data-kcd-type="path" href="starmind/src/main/dispatch/">dispatch</a><span data-kcd-field="why" data-kcd-type="text">the read head</span></div>
		</div>
	</section>
</section>
<section data-kcd-region="care">
	<h2>Care</h2>
	<p><em>Personality. Who this lens is.</em></p>
	<section data-kcd-section="purpose">
		<h3 data-kcd-heading>Purpose</h3>
		<p>Driver governs <strong>orchestration</strong>.</p>
	</section>
	<section data-kcd-section="open-questions">
		<h3 data-kcd-heading>Open Questions</h3>
		<ul><li>Is the governor a lane?</li></ul>
	</section>
	<section data-kcd-section="philosophy">
		<h3 data-kcd-heading>Philosophy &amp; Prerogatives</h3>
		<p>Layer above, build in our idioms.</p>
	</section>
</section>
<section data-kcd-region="do">
	<h2>Do</h2>
	<section data-kcd-section="habits">
		<h3>Habits</h3>
		<div data-kcd-table>
			<div data-kcd-slot="habit"><span data-kcd-field="what" data-kcd-type="text">no-new-idioms</span><a data-kcd-field="where" data-kcd-type="path" href="_Claude/habits/unslotted/no-new-idioms.html">no-new-idioms</a><span data-kcd-field="why" data-kcd-type="text">habit</span></div>
		</div>
	</section>
</section>
</article>

</body></html>
`;

describe( 'LensMigration.flatten', () => {

	it( 'refuses the old shape — the cut is hard', () => {
		const errors = codes( OLD );
		expect( errors ).toContain( 'region-retired' );
		expect( errors ).toContain( 'lens-behaviour-slot' );
		expect( errors ).toContain( 'base-retired' );
		expect( errors ).toContain( 'lens-no-personality' );
	} );

	it( 'writes a lens that validates, made of personality, philosophy and references alone', () => {
		const next = LensMigration.flatten( OLD )!;

		expect( validate( next ).errors ).toEqual( [] );
		expect( next ).not.toContain( 'data-kcd-region' );
		expect( next ).not.toContain( 'data-kcd-slot="habit"' );
		expect( next ).not.toContain( 'data-kcd-field="base"' );
		expect( next.match( /data-kcd-section="([^"]+)"/g ) ).toEqual( [
			'data-kcd-section="personality"', 'data-kcd-section="philosophy"', 'data-kcd-section="references"'
		] );
	} );

	it( 'carries the prose across byte for byte, each piece where it now belongs', () => {
		const next  = LensMigration.flatten( OLD )!;
		const at    = ( s: string ) => next.indexOf( s );
		const sec   = ( name: string ) => at( `data-kcd-section="${ name }"` );

		// The lede and the Purpose are the personality, in that order, spacing and markup intact.
		expect( at( 'The orchestration   lens, in its author\'s own spacing.' ) ).toBeGreaterThan( sec( 'personality' ) );
		expect( at( 'Driver governs <strong>orchestration</strong>.' ) ).toBeGreaterThan( at( 'The orchestration   lens' ) );
		expect( at( 'Driver governs' ) ).toBeLessThan( sec( 'philosophy' ) );

		// The philosophy keeps its author's heading, and the open questions ride under it.
		expect( next ).toContain( '<h3 data-kcd-heading>Philosophy &amp; Prerogatives</h3>' );
		expect( at( 'Is the governor a lane?' ) ).toBeGreaterThan( at( 'Layer above' ) );
		expect( at( 'Is the governor a lane?' ) ).toBeLessThan( sec( 'references' ) );

		// Domains are references now — one table, the lens's own rows first, modes kept.
		expect( at( 'href="starmind/src/main/dispatch/"' ) ).toBeGreaterThan( at( 'href="_Claude/references/vocabulary.html"' ) );
		expect( next ).toContain( REF( 'pipeline', 'load' ) );

		// The region intros go; the author's title and the rest of the page stay.
		expect( next ).not.toContain( 'Read-only inputs.' );
		expect( next ).not.toContain( 'Personality. Who this lens is.' );
		expect( next ).toContain( '<h1>Driver — Lens</h1>' );
		expect( next.startsWith( '<!DOCTYPE html>\n<html><head><title>driver</title></head><body>' ) ).toBe( true );
		expect( next.endsWith( '</article>\n\n</body></html>\n' ) ).toBe( true );
	} );

	it( 'leaves a flat lens, and anything that is not a lens, alone', () => {
		const flat = LensMigration.flatten( OLD )!;
		expect( LensMigration.flatten( flat ) ).toBeNull();
		expect( LensMigration.flatten( '<article data-kcd="reference"><h1>x</h1></article>' ) ).toBeNull();
	} );
} );
