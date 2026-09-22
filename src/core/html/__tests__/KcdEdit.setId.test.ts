import { describe, expect, it } from 'vitest';

import { KcdEdit } from '../KcdEdit';
import { KcdValidate } from '../KcdValidate';
import { VaultLayout } from '../../VaultLayout';

/** A document's stable id, written into its own frontmatter ( plan agents-own-behaviour, "Lens and habit ids
 *  live in their frontmatter" ). */

const ID    = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** Hand-formatted, one row a line — the shape the real vault is written in. */
const DOC = `<!DOCTYPE html>
<html><head><title>kept</title></head><body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
	<dt>name</dt>
	<dd data-kcd-field="name" data-kcd-type="slug">kept</dd>
	<dt>description</dt>
	<dd data-kcd-field="description" data-kcd-type="text">A fixture   with   odd spacing.</dd>
	<dt>type</dt>
	<dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
	<dt>status</dt>
	<dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>kept</h1>
<p>A body   nobody should   reformat.</p>
</article>
</body></html>
`;

const INLINE = '<article data-kcd="reference"><dl data-kcd-frontmatter><dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">kept</dd></dl><p>x</p></article>';

describe( 'KcdEdit.setId', () => {

	it( 'adds the id row after name, at its indentation, and changes no other byte', () => {
		const next = KcdEdit.setId( DOC, ID )!;

		expect( next ).toBe( DOC.replace(
			'<dd data-kcd-field="name" data-kcd-type="slug">kept</dd>\n',
			`<dd data-kcd-field="name" data-kcd-type="slug">kept</dd>\n\t<dt>id</dt><dd data-kcd-field="id" data-kcd-type="text">${ ID }</dd>\n`
		) );
	} );

	it( 'writes a document the validator accepts', () => {
		const report = KcdValidate.validate( KcdEdit.setId( DOC, ID )!, { docRoot: VaultLayout.DEFAULT_DOC_ROOT } );
		expect( report.errors ).toEqual( [] );
	} );

	it( 'keeps a one-line frontmatter block on one line', () => {
		expect( KcdEdit.setId( INLINE, ID ) ).toBe( INLINE.replace( 'kept</dd>', `kept</dd><dt>id</dt><dd data-kcd-field="id" data-kcd-type="text">${ ID }</dd>` ) );
	} );

	it( 'rewrites an id the document already carries, and is a no-op for the same one', () => {
		const once = KcdEdit.setId( DOC, ID )!;

		expect( KcdEdit.setId( once, ID ) ).toBeNull();
		const twice = KcdEdit.setId( once, OTHER )!;
		expect( twice ).toBe( once.replace( ID, OTHER ) );
		expect( twice.match( /data-kcd-field="id"/g ) ).toHaveLength( 1 );
	} );

	it( 'refuses a document with no frontmatter block', () => {
		expect( KcdEdit.setId( '<article data-kcd="reference"><p>x</p></article>', ID ) ).toBeNull();
	} );
} );

describe( 'KcdValidate — the id field', () => {

	const withId = ( id: string ): string => DOC.replace(
		'<dt>description</dt>',
		`<dt>id</dt><dd data-kcd-field="id" data-kcd-type="text">${ id }</dd>\n\t<dt>description</dt>`
	);

	it( 'is optional', () => {
		expect( KcdValidate.validate( DOC, { docRoot: VaultLayout.DEFAULT_DOC_ROOT } ).errors ).toEqual( [] );
	} );

	it( 'refuses an id that is not a UUID', () => {
		const report = KcdValidate.validate( withId( 'lens-crafter' ), { docRoot: VaultLayout.DEFAULT_DOC_ROOT } );
		expect( report.errors.map( ( e ) => e.code ) ).toContain( 'bad-format' );
	} );
} );
