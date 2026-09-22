import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * A DUPLICATED ID IS AN ERROR ( plan agents-own-behaviour, "Lens and habit ids live in their frontmatter" ).
 *
 * The id is a document's identity — an agent names its lenses by it — so two library documents carrying one
 * means a record could resolve to either. A scratch copy under `work/` is a backup nobody resolves, and is not.
 */

const SHARED = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const OWN    = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

let root = '';

const doc = ( name: string, id: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>id</dt><dd data-kcd-field="id" data-kcd-type="text">${ id }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n<p>Body.</p>\n`
	+ `</article>\n</body></html>\n`;

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-duplicate-id-' ) );
	mkdirSync( join( root, '_Claude', 'references' ), { recursive: true } );
	mkdirSync( join( root, '_Claude', 'work', 'someone', 'AI', 'scratch' ), { recursive: true } );

	writeFileSync( join( root, '_Claude', 'references', 'original.html' ), doc( 'original', SHARED ) );
	writeFileSync( join( root, '_Claude', 'references', 'copied.html' ),   doc( 'copied', SHARED ) );
	writeFileSync( join( root, '_Claude', 'references', 'alone.html' ),    doc( 'alone', OWN ) );
	// A scratch backup of `alone` — the same id, outside the library.
	writeFileSync( join( root, '_Claude', 'work', 'someone', 'AI', 'scratch', 'alone.html' ), doc( 'alone', OWN ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

const issuesFor = ( file: string ) => new Vault( root, '_Claude' ).referenceIssues( file );

describe( 'Vault.referenceIssues — a duplicated id', () => {

	it( 'is an error on each document carrying it, naming the other', () => {
		const [ onOriginal ] = issuesFor( 'references/original.html' );
		expect( onOriginal.severity ).toBe( 'error' );
		expect( onOriginal.message ).toContain( SHARED );
		expect( onOriginal.message ).toContain( 'references/copied.html' );

		const [ onCopy ] = issuesFor( 'references/copied.html' );
		expect( onCopy.message ).toContain( 'references/original.html' );
	} );

	it( 'is not raised by a scratch copy outside the library', () => {
		expect( issuesFor( 'references/alone.html' ) ).toEqual( [] );
	} );
} );
