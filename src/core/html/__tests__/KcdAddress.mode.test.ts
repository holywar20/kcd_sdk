import { describe, it, expect } from 'vitest';
import { KcdAddress } from '../KcdAddress';
import { KcdValidate } from '../KcdValidate';
import { KcdParse } from '../KcdParse';
import { HtmlTree } from '../HtmlTree';

/**
 * The slot-mode word, read by one shared reader so the parser and the validator cannot disagree on an input.
 * `suggested` is refused, not absent: it must fail loudly and name the word to use.
 */
function doc( mode: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>fixture</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">mode-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for reading a slot's mode.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Mode Fixture</h1>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-table>
<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
<div data-kcd-slot="reference"${ mode === '' ? '' : ` data-kcd-mode="${ mode }"` }><span data-kcd-field="what" data-kcd-type="text">A reference</span><a data-kcd-field="where" data-kcd-type="path" href="_Claude/references/thing.html">thing</a><span data-kcd-field="why" data-kcd-type="text">why</span></div>
</div>
</section>
</section>
</article>
</body>
</html>
`;
}

/** What the PARSER makes of a raw mode word. */
const parsed = ( mode: string ): string => KcdParse.build( HtmlTree.parse( doc( mode ) ), 'mode-fixture.html' ).slots[ 0 ].mode;

/** What the VALIDATOR makes of the same document. */
const codes = ( mode: string ): string[] => KcdValidate.validate( doc( mode ), { docRoot: '_Claude' } ).errors.map( e => e.code );

describe( 'KcdAddress.readMode — the one reader both heads share', () => {

	it( 'reads each canonical word as itself', () => {
		expect( KcdAddress.readMode( 'off' ) ).toBe( 'off' );
		expect( KcdAddress.readMode( 'on' ) ).toBe( 'on' );
		expect( KcdAddress.readMode( 'load' ) ).toBe( 'load' );
	} );

	it( 'REFUSES the retired `suggested` — the transitional alias is gone', () => {
		expect( KcdAddress.readMode( 'suggested' ) ).toBeNull();
	} );

	it( 'returns null for absent, empty and unknown alike — telling those apart is the caller\'s job', () => {
		expect( KcdAddress.readMode( undefined ) ).toBeNull();
		expect( KcdAddress.readMode( '' ) ).toBeNull();
		expect( KcdAddress.readMode( 'preload' ) ).toBeNull();
		expect( KcdAddress.readMode( 'Load' ) ).toBeNull();
	} );

	it( 'MODES derives from SLOT_MODES rather than restating it — the drift these two literals allowed is what let the heads disagree', () => {
		expect( KcdAddress.MODES ).toEqual( [ 'off', 'on', 'load' ] );
	} );
} );

describe( 'slot mode — parser and validator agree on every input', () => {

	it( 'a `load` slot parses as load and validates clean', () => {
		expect( parsed( 'load' ) ).toBe( 'load' );
		expect( codes( 'load' ) ).not.toContain( 'bad-mode' );
	} );

	it( 'a `suggested` slot is REFUSED, and the message names the rename rather than only the legal set', () => {
		expect( codes( 'suggested' ) ).toContain( 'bad-mode' );
		const fault = KcdValidate.validate( doc( 'suggested' ), { docRoot: '_Claude' } ).errors.find( e => e.code === 'bad-mode' );
		expect( fault!.msg ).toContain( 'load' );
		// The hint matters: a vault never swept loses its whole floor lens to this, and the legal
		// set alone does not name the rename.
		expect( fault!.msg ).toContain( '2026-09-16' );
	} );

	it( 'an absent mode is `on`, the documented default, and is not an error', () => {
		expect( parsed( '' ) ).toBe( 'on' );
		expect( codes( '' ) ).not.toContain( 'bad-mode' );
	} );

	it( 'an UNKNOWN mode is refused by the validator, which is what keeps the parser\'s silent demotion out of reach', () => {
		expect( codes( 'rubbish' ) ).toContain( 'bad-mode' );
		// The parser still answers `on` for it — but only off the non-validating assembly path. `parse()`
		// throws on a failing document, so no caller reading a real vault can reach this value.
		expect( parsed( 'rubbish' ) ).toBe( 'on' );
	} );
} );
