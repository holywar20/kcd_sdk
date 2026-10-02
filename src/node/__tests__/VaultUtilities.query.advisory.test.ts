import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * WHO THE PARSE-FAULT ADVISORY IS ALLOWED TO NAME ( DEFECT-173 ).
 *
 * `query` rides a fault list on every call, and that list is a tax on every documentation call in the
 * project. It exists for one genuinely hard failure — a document that IS on disk and that no query
 * returns, because it failed to parse and absence looks identical to "no such document". That case is
 * worth every token it costs.
 *
 * What it must never do is cry wolf. The research corpus under `research/` is plain HTML by design,
 * carries no `data-kcd-*` root, and is never meant to parse as an artifact; naming all of it on every
 * call is advice nobody can act on, and an advisory a reader learns to skip is one that will not be
 * read on the day it is telling the truth. The gate is the EPHEMERAL rule — `indexed: false` space —
 * which `research` is declared into.
 *
 * THE OPPOSITE ERROR IS WORSE, and the last two cases here are what stand against it. Silencing the
 * advisory for "anything in no `VaultLayout` row" would convert a loud *your document is broken* into
 * a silent *your document is not checked* for any folder somebody forgot to register — absence wearing
 * failure's clothes, the confusion this codebase rules against everywhere else. An unregistered folder
 * stays noisy on purpose.
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

/** Plain HTML with no `data-kcd` root — what a research report deliberately is, and what a broken
 *  library document accidentally is. The scan cannot tell them apart, which is exactly why the
 *  advisory has to be scoped by PATH rather than by content. */
const plain = ( title: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ title }</title></head><body>\n`
	+ `<h1>${ title }</h1>\n<p>Human reading. Not an artifact.</p>\n</body></html>\n`;

const BROKEN  = 'references/patterns/broken.html';
const REPORT  = 'research/academic/some-report.html';
const ORPHAN  = 'unregistered-folder/orphan.html';

/** The constants above are forward-slash by convention — they double as the fixture WRITER via
 *  `.split( '/' )`. A value read back out of a sweep is whatever its producer spells it as, so it is
 *  normalized HERE, at the assertion, the way `Vault.documentPaths.test.ts` beside this file does.
 *  The fact under test is always WHICH document, never the separator; comparing a forward-slash literal
 *  to a native-separator value is a Windows-only failure that says nothing about grading. */
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

	/** THE TRAP. `unknown ⇒ ungraded` as a general rule would silence any folder nobody added to
	 *  `VaultLayout` — including a folder of real artifacts somebody forgot to register. The
	 *  exclusion is DECLARED, never inferred from the absence of a declaration. */
	it( 'still names a fault in a folder nobody registered — absence of a row is not permission', () => {
		const { unreadable } = VaultUtilities.query( vaultOf() );
		expect( unreadable ).toContain( ORPHAN );
	} );

	/** The same courtesy the archival rule gets beside it: NAMING the bucket is a caller asking about
	 *  that space, and a silent drop there would be the original bug wearing different clothes. */
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
 * THE COUNT THAT MUST NOT MOVE. Grading is `documentPaths()` — indexed directories plus root files —
 * filtered through `isLibraryPath`. Quieting the advisory may not quieten the sweep, so this pins the
 * graded set independently: a widened exclusion that bought silence by dropping a real document out of
 * validation fails here rather than passing unnoticed.
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
