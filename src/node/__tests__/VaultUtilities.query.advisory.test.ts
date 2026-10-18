import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * The parse-fault advisory names a document that fails to parse, but never one in declared unindexed space:
 * the research corpus is plain HTML by design. The exclusion is declared by path, never inferred from a
 * missing row, so a folder nobody registered stays noisy on purpose.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

/** A well-formed artifact — parses, so it lands in `matches` and never in the fault list. */
const doc = ( name: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n<p>Fine.</p>\n</article>\n</body></html>\n`;

/** Plain HTML with no `data-kcd` root: what a research report is by design, and what a broken document
 *  accidentally is. The scan cannot tell them apart, so the advisory is scoped by PATH. */
const plain = ( title: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ title }</title></head><body>\n`
	+ `<h1>${ title }</h1>\n<p>Human reading. Not an artifact.</p>\n</body></html>\n`;

const BROKEN  = 'references/patterns/broken.html';
const REPORT  = 'research/academic/some-report.html';
const ORPHAN  = 'unregistered-folder/orphan.html';

/** Fixture paths are forward-slash; values read back from a sweep are normalized here, so the assertion checks WHICH document, not the separator. */
const fwd = ( p: string ) => p.replace( /\\/g, '/' );

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-query-advisory-' ) );
	for ( const dir of [ [ 'references', 'patterns' ], [ 'research', 'academic' ], [ 'unregistered-folder' ] ] )
		mkdirSync( join( root, '_Claude', ...dir ), { recursive: true } );

	writeFileSync( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ), doc( 'alpha' ) );

	// GRADED LIBRARY SPACE — the one case the advisory was built for.
	writeFileSync( join( root, '_Claude', ...BROKEN.split( '/' ) ), plain( 'broken' ) );
	// DECLARED, UNINDEXED — the research corpus. Non-conformance here is the design.
	writeFileSync( join( root, '_Claude', ...REPORT.split( '/' ) ), plain( 'some report' ) );
	// DECLARED NOWHERE — a folder nobody registered. Must stay noisy.
	writeFileSync( join( root, '_Claude', ...ORPHAN.split( '/' ) ), plain( 'orphan' ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'VaultUtilities.query — the parse-fault advisory', () => {

	it( 'says nothing about the research corpus on an unscoped query', () => {
		const { unreadable } = VaultUtilities.query( vaultOf() );
		expect( unreadable.filter( p => p.startsWith( 'research/' ) ) ).toEqual( [] );
	} );

	it( 'says nothing about it on a query whose glob merely reaches over it', () => {
		const { unreadable } = VaultUtilities.query( vaultOf(), { glob: '**/*.html' } );
		expect( unreadable.filter( p => p.startsWith( 'research/' ) ) ).toEqual( [] );
	} );

	/** THE CASE IT EXISTS FOR, and the reason the filter is a path rule rather than a blanket. A
	 *  filter widened until it silences everything passes every assertion above and fails this one. */
	it( 'still names a document that fails to parse inside GRADED library space', () => {
		const { unreadable } = VaultUtilities.query( vaultOf() );
		expect( unreadable ).toContain( BROKEN );
	} );

	/** `unknown ⇒ ungraded` would silence any folder nobody registered. The exclusion is DECLARED, never inferred from a missing row. */
	it( 'still names a fault in a folder nobody registered — absence of a row is not permission', () => {
		const { unreadable } = VaultUtilities.query( vaultOf() );
		expect( unreadable ).toContain( ORPHAN );
	} );

	/** Naming the corpus is a caller asking about that space; silence there would hide the file. */
	it( 'reports the corpus when the glob names it', () => {
		const { unreadable } = VaultUtilities.query( vaultOf(), { glob: 'research/**' } );
		expect( unreadable ).toContain( REPORT );
	} );

	/** `matches` is untouched by any of this — the advisory is withdrawn, never the documents. */
	it( 'still returns every document that does parse', () => {
		const { matches } = VaultUtilities.query( vaultOf() );
		expect( ( matches as { path: string }[] ).map( m => m.path ) ).toEqual( [ 'references/patterns/alpha.html' ] );
	} );
} )

/**
 * Quieting the advisory must not quieten the sweep: grading is `documentPaths()` filtered through
 * `isLibraryPath`, and a widened exclusion that drops a document out of validation fails here.
 */
describe( 'what a whole-vault sweep grades — unchanged by the advisory rule', () => {

	it( 'grades exactly the two documents in library space, broken one included', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.scanned ).toBe( 2 );
		expect( summary.checked ).toBe( 2 );
	} );

	it( 'reports the broken library document as a real defect', () => {
		const { issues } = VaultUtilities.health( vaultOf() );
		expect( issues.some( i => fwd( i.path ) === BROKEN ) ).toBe( true );
	} );

	it( 'never walks the research corpus or an unregistered folder — neither is indexed', () => {
		const graded = vaultOf().documentPaths().map( fwd );
		expect( graded ).toContain( BROKEN );
		expect( graded.filter( p => p.startsWith( 'research/' ) ) ).toEqual( [] );
		expect( graded ).not.toContain( ORPHAN );
	} );
} )
