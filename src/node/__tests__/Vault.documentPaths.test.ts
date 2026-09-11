import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * WHAT THE SWEEP NEVER LOOKED AT ( 2026-09-10 ).
 *
 * `documentPaths()` walked the indexed DIRECTORIES. The vault root is not one of them, so every
 * document sitting directly at the root was outside every whole-vault sweep ever run — and those
 * are the four most-read documents there are: `root.html` ( the entry an agent loads first ),
 * `root-context.html` ( the source every host entry file is generated from ), `kcd_framework.html`,
 * and the vault's own `nav-index.html` ( the map a human opens first ).
 *
 * The report did not say they were skipped. It said the vault was clean. "Nothing is here" and
 * "everything here is fine" rendering identically is the defect this project names most often, and
 * it was live one level below the command that exists to catch it.
 *
 * NESTED AND ROOT ARE BOTH PINNED, because they reach the walk by different routes and only one of
 * them was ever broken — a test covering the nested case alone passes against the bug.
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

/** One `ephemeral-link` — the same code the generated root nav-index was carrying six of. */
const BROKEN_BODY =
	'<section data-kcd-section="overview"><h2>Overview</h2>'
	+ '<p>A link into scratch space: <a href="_Claude/work/notes.html">notes</a></p></section>';

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-docpaths-' ) );
	mkdirSync( join( root, '_Claude', 'lenses' ),     { recursive: true } );
	mkdirSync( join( root, '_Claude', 'references' ), { recursive: true } );
	mkdirSync( join( root, '_Claude', 'work' ),       { recursive: true } );

	// At the vault ROOT — the set that was never swept.
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

	/**
	 * The root walk must NOT recurse. Ephemeral directories sit at the root, and walking it
	 * recursively would grade `work/` and `logs/` — undoing the library gate from the other side and
	 * re-creating the noise it was added to remove.
	 */
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

	/**
	 * THE CASE THIS FILE EXISTS FOR. Four documents carry one error each; three are graded and one
	 * is ephemeral. Pinned as a COUNT, because the failure mode was a report that read clean rather
	 * than one that read wrong.
	 */
	it( 'counts every root-level error that the sweep used to miss', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.checked ).toBe( 4 );   // 2 root + 2 nested; work/ is not walked
		expect( summary.errors ).toBe( 3 );    // nav-index, root, lenses/nav-index
	} );
} );
