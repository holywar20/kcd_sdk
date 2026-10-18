import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * `documentPaths()` reaches documents at the vault root as well as the indexed directories. Root and nested are both
 * pinned: they reach the walk by different routes, so one case alone would not cover the other.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

const doc = ( name: string, type: string, body = '<section data-kcd-section="overview"><h2>Overview</h2><p>Fine.</p></section>' ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="${ type }">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ type }</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n${ body }\n</article>\n</body></html>\n`;

/** One `ephemeral-link`: a link into scratch space. */
const BROKEN_BODY =
	'<section data-kcd-section="overview"><h2>Overview</h2>'
	+ '<p>A link into scratch space: <a href="_Claude/work/notes.html">notes</a></p></section>';

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-docpaths-' ) );
	mkdirSync( join( root, '_Claude', 'lenses' ),     { recursive: true } );
	mkdirSync( join( root, '_Claude', 'references' ), { recursive: true } );
	mkdirSync( join( root, '_Claude', 'work' ),       { recursive: true } );

	// At the vault root.
	writeFileSync( join( root, '_Claude', 'nav-index.html' ), doc( 'vault', 'nav-index', BROKEN_BODY ) );
	writeFileSync( join( root, '_Claude', 'root.html' ),      doc( 'root',  'framework', BROKEN_BODY ) );

	// NESTED — inside an indexed directory, reached by the recursive half of the walk.
	writeFileSync( join( root, '_Claude', 'lenses', 'nav-index.html' ), doc( 'lenses', 'nav-index', BROKEN_BODY ) );
	writeFileSync( join( root, '_Claude', 'references', 'ok.html' ),    doc( 'ok', 'reference' ) );

	// EPHEMERAL — walked by neither half, and that is deliberate: it is not installed into a vault,
	// so it is not held to the document standard ( `isLibraryPath` ).
	writeFileSync( join( root, '_Claude', 'work', 'notes.html' ), doc( 'notes', 'reference', BROKEN_BODY ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'Vault.documentPaths — what the sweep reaches', () => {

	it( 'reaches a document at the vault root', () => {
		const paths = vaultOf().documentPaths().map( p => p.replace( /\\/g, '/' ) );
		expect( paths ).toContain( 'nav-index.html' );
		expect( paths ).toContain( 'root.html' );
	} );

	it( 'reaches a nested nav-index too', () => {
		const paths = vaultOf().documentPaths().map( p => p.replace( /\\/g, '/' ) );
		expect( paths ).toContain( 'lenses/nav-index.html' );
	} );

	/** The root walk must not recurse, or it would grade ephemeral `work/` and `logs/`. */
	it( 'does not reach into ephemeral space at the root', () => {
		const paths = vaultOf().documentPaths().map( p => p.replace( /\\/g, '/' ) );
		expect( paths ).not.toContain( 'work/notes.html' );
	} );
} );

describe( 'VaultUtilities.health — root documents are graded', () => {

	it( 'grades both a root and a nested nav-index in one sweep', () => {
		const { issues } = VaultUtilities.health( vaultOf() );
		const paths = issues.map( i => i.path.replace( /\\/g, '/' ) );
		expect( paths ).toContain( 'nav-index.html' );
		expect( paths ).toContain( 'lenses/nav-index.html' );
	} );

	/** Four documents carry one error each; three are graded, one is ephemeral. Pinned as a count: a clean-reading report is the failure. */
	it( 'counts every root-level error that the sweep used to miss', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.checked ).toBe( 4 );   // 2 root + 2 nested; work/ is not walked
		expect( summary.errors ).toBe( 3 );    // nav-index, root, lenses/nav-index
	} );
} );
