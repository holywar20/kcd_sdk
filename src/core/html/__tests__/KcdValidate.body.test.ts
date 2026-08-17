import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * The empty-body rule. A document whose frontmatter is perfect and whose body is absent used to
 * validate clean and land on disk — `kcd_save` refuses on errors only, so nothing stopped it. These
 * cases pin the rule at both edges: the empty box FAILS, and the thinnest real document ( a bare
 * `<h1>` ) PASSES, because the rule asks whether a body exists and not whether it is any good.
 */
function doc( type: string, name: string, body: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${ name }</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="${ type }">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for the empty-body rule.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ type }</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
${ body }</article>
</body>
</html>
`;
}

describe( 'KcdValidate — the body rule', () => {

	it( 'frontmatter and nothing else is an ERROR, so kcd_save refuses the write', () => {
		const report = KcdValidate.validate( doc( 'reference', 'empty-shell', '' ) );

		expect( report.ok ).toBe( false );
		expect( report.errors.map( e => e.code ) ).toEqual( [ 'empty-body' ] );
	} );

	// The frontmatter block's own <dt>/<dd> cells are elements inside the article. If the rule counted
	// them the empty document would pass and the rule would assert nothing at all.
	it( 'the frontmatter block does not count as its own body', () => {
		const report = KcdValidate.validate( doc( 'reference', 'cells-are-not-body', '' ) );

		expect( report.errors.some( e => e.code === 'empty-body' ) ).toBe( true );
	} );

	// The ruling, pinned: an h1 alone is thin, not broken. Anything stricter grades authorship.
	it( 'frontmatter plus a bare <h1> PASSES', () => {
		const report = KcdValidate.validate( doc( 'reference', 'title-only', '<h1>Title only</h1>\n' ) );

		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );

	it( 'a normal artifact still passes', () => {
		const body = '<h1>Normal Reference</h1>\n'
			+ '<p>A document with an actual body — prose, a heading, and a named section.</p>\n'
			+ '<section data-kcd-section="location"><h2>Location</h2><p>It lives here.</p></section>\n';
		const report = KcdValidate.validate( doc( 'reference', 'normal-reference', body ) );

		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );

	// RULED: no template exemption. `validate()` returns on `rootType === 'template'` before any
	// structural pass, so a scaffold is already exempt from this rule along with every other one —
	// adding a second exemption would only duplicate that. Pinned here so a future reader who goes
	// looking for the missing carve-out finds the reason instead of a hole.
	it( 'a template is exempt — it never reaches the rule', () => {
		const report = KcdValidate.validate( doc( 'template', 'scaffold', '' ) );

		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );
} );
