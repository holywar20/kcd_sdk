import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * A `lens` FIELD IS A LIST ON MOST TYPES AND A STRING ON A FEW ( 2026-09-26 ).
 *
 * `referenceIssues` has always checked that a `base` / `lens` slug names a real artifact, and it has
 * always been right about what to do when it does not — warn, never block. It read one shape. A
 * `typeof v !== 'string'` guard sent every array-valued lens field to `continue`, which is every
 * analyzer and every reference that names more than one lens.
 *
 * HOW IT SURFACED, because the shape of the discovery is the reason these cases exist. A lens
 * retirement deleted ten lenses. Seven of the eight audit analyzers were left declaring a lens that
 * no longer existed — including `audit-rollup`, whose whole job is reading the other reports — and a
 * whole-vault sweep reported zero issues throughout. The rule was not missing. It was reading the
 * uncommon shape of the field it governs.
 *
 * WHY THESE STAY WARNINGS. Nothing breaks. The document parses, and the runtime degrades by design:
 * `BrokenLens` keeps a lens an agent's record names but cannot load, with its id, name, stack
 * position and reason, so a record write puts the id back rather than dropping it. Failing the parse
 * would remove the one thing a repair needs — a readable document. The severity is not the signal
 * here; being reported at all is.
 */

let root = '';

const LIVE = 'live-lens';

const lensDoc = ( name: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="lens">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture lens.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="personality"><h2>Personality</h2><p>A fixture.</p></section>\n`
	// BOTH SECTIONS, OR THIS IS NOT A LENS. `KcdValidate.checkLens` requires `personality` AND
	// `philosophy`, so a fixture carrying one of them fails `tryParse`, drops out of the scan as a fault,
	// and never reaches the `names` set this suite resolves against. The symptom is not a parse error —
	// it is `live-lens` being reported as a lens that does not exist, in the four cases that assert a
	// live one resolves, while every dead-lens case passes. Found by running the suite for the first
	// time ( Bristol, 2026-09-26 ); it was written and never executed.
	+ `<section data-kcd-section="philosophy"><h2>Philosophy</h2><p>A fixture's stance.</p></section>\n`
	+ `</article>\n</body></html>\n`;

/** A reference carrying a `lens` field in whichever shape the caller wants to test. */
const refDoc = ( name: string, lensField: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ lensField
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="overview"><h2>Overview</h2><p>Body.</p></section>\n`
	+ `</article>\n</body></html>\n`;

const asList   = ( ...names: string[] ) =>
	`<dt>lens</dt><dd data-kcd-field="lens" data-kcd-type="list"><ul data-kcd-chips>`
	+ names.map( n => `<li data-kcd-tag>${ n }</li>` ).join( '' )
	+ `</ul></dd>`;
const asString = ( name: string ) =>
	`<dt>lens</dt><dd data-kcd-field="lens" data-kcd-type="text">${ name }</dd>`;

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-lensrefs-' ) );
	mkdirSync( join( root, '_kcd', 'lenses', LIVE ),  { recursive: true } );
	mkdirSync( join( root, '_kcd', 'references' ),    { recursive: true } );
	mkdirSync( join( root, '_kcd', 'work', 'notes' ), { recursive: true } );

	writeFileSync( join( root, '_kcd', 'lenses', LIVE, `${ LIVE }.html` ), lensDoc( LIVE ) );

	// THE REGRESSION CASE — a list naming one live lens and one that is gone.
	writeFileSync( join( root, '_kcd', 'references', 'list-one-dead.html' ),
		refDoc( 'list-one-dead', asList( LIVE, 'retired-lens' ) ) );

	// A list where every member is gone — the shape the analyzers were actually in.
	writeFileSync( join( root, '_kcd', 'references', 'list-all-dead.html' ),
		refDoc( 'list-all-dead', asList( 'retired-lens', 'also-gone' ) ) );

	// A list that fully resolves — the guard must not fire.
	writeFileSync( join( root, '_kcd', 'references', 'list-clean.html' ),
		refDoc( 'list-clean', asList( LIVE ) ) );

	// The shape that always worked, kept so the repair cannot regress it.
	writeFileSync( join( root, '_kcd', 'references', 'string-dead.html' ),
		refDoc( 'string-dead', asString( 'retired-lens' ) ) );
	writeFileSync( join( root, '_kcd', 'references', 'string-clean.html' ),
		refDoc( 'string-clean', asString( LIVE ) ) );

	// `cross` is a sentinel, not a reference — and it has to stay skipped inside a list.
	writeFileSync( join( root, '_kcd', 'references', 'cross-in-list.html' ),
		refDoc( 'cross-in-list', asList( 'cross' ) ) );
	writeFileSync( join( root, '_kcd', 'references', 'cross-as-string.html' ),
		refDoc( 'cross-as-string', asString( 'cross' ) ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

const issuesFor = ( file: string ) => new Vault( root, '_kcd' ).referenceIssues( file );
const lensIssues = ( file: string ) => issuesFor( file ).filter( i => i.message.startsWith( 'lens ' ) );

describe( 'Vault.referenceIssues — a lens field in list form', () => {

	/**
	 * THE ONE THAT WAS BROKEN. Before the repair this returned nothing at all, which is how seven
	 * broken analyzers coexisted with a clean vault report.
	 */
	it( 'reports a dead lens named inside a list', () => {
		const found = lensIssues( 'references/list-one-dead.html' );
		expect( found ).toHaveLength( 1 );
		expect( found[ 0 ]!.ref ).toBe( 'retired-lens' );
	} );

	// One issue PER DEAD MEMBER, not one per field. A field naming three gone lenses is three things to
	// repair, and a tally a repair loop reads must not undercount — an undercount reads as progress.
	it( 'reports every dead member of a list separately', () => {
		const found = lensIssues( 'references/list-all-dead.html' );
		expect( found.map( i => i.ref ).sort() ).toEqual( [ 'also-gone', 'retired-lens' ] );
	} );

	it( 'says nothing about a list whose every member resolves', () => {
		expect( lensIssues( 'references/list-clean.html' ) ).toEqual( [] );
	} );

	// The message has to carry the repair, or the reader has to work out what happened by hand. A
	// retired lens is the cause in practice, and naming it is what turns the warning into an action.
	it( 'names the slug and why the reference was left behind', () => {
		const [ issue ] = lensIssues( 'references/list-one-dead.html' );
		expect( issue!.message ).toContain( 'retired-lens' );
		expect( issue!.message ).toContain( 'names no artifact in the vault' );
		expect( issue!.message ).toContain( 'renamed or retired' );
	} );

	/**
	 * ADVISORY, and this is a ruling rather than an implementation detail. A missing lens does not stop
	 * the document parsing and the runtime already carries a named gap for it, so blocking here would
	 * cost the repair its subject. If this ever flips to `error`, it should be because somebody decided
	 * that, not because a severity was easier to type.
	 */
	it( 'is a WARNING, never a parse-blocking error', () => {
		for ( const f of [ 'references/list-one-dead.html', 'references/list-all-dead.html', 'references/string-dead.html' ] )
			for ( const issue of lensIssues( f ) )
				expect( issue.severity ).toBe( 'warn' );
	} );
} );

describe( 'Vault.referenceIssues — the shapes that already worked', () => {

	it( 'still reports a dead lens named as a bare string', () => {
		const found = lensIssues( 'references/string-dead.html' );
		expect( found ).toHaveLength( 1 );
		expect( found[ 0 ]!.ref ).toBe( 'retired-lens' );
	} );

	it( 'still says nothing about a bare string that resolves', () => {
		expect( lensIssues( 'references/string-clean.html' ) ).toEqual( [] );
	} );
} );

describe( 'Vault.referenceIssues — the cross sentinel', () => {

	// Skipped per MEMBER rather than per field, so it survives arriving inside a list. A member-level
	// skip is the difference between "this field is exempt" and "this value is not a reference".
	it( 'skips cross inside a list', () => {
		expect( lensIssues( 'references/cross-in-list.html' ) ).toEqual( [] );
	} );

	it( 'skips cross as a bare string', () => {
		expect( lensIssues( 'references/cross-as-string.html' ) ).toEqual( [] );
	} );
} );
