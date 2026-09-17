import { describe, it, expect } from 'vitest';
import { KcdAddress } from '../KcdAddress';
import { KcdValidate } from '../KcdValidate';
import { KcdParse } from '../KcdParse';
import { HtmlTree } from '../HtmlTree';

/**
 * THE SLOT-MODE WORD, and the agreement between the two heads that read it.
 *
 * The parser and the validator each held their own copy of the accepted set and fell in OPPOSITE
 * directions on the same input: one demoted an unrecognised mode to `on` in silence, the other raised a
 * hard `bad-mode`. So a document could pass one head and be quietly rewritten by the other, and the
 * symptom — an agent getting thinner context — had no failure to chase. Both read `KcdAddress.readMode`
 * now, and these cases pin the AGREEMENT rather than either head's private behaviour.
 *
 * `suggested` is the retired third state ( renamed `load` 2026-09-16 ). It is pinned as REFUSED, not as
 * absent: it read as an alias for one transitional period and the arm is gone, so the case that matters
 * is that it now fails LOUDLY and says which word to use, rather than parsing as something.
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
		// The hint is the whole value of this failure: a vault deployed elsewhere and never swept loses
		// its WHOLE floor lens to it, and the legal set alone does not say which word was wrong.
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
