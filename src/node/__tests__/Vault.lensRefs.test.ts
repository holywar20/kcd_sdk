import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * A `lens` field is a list on most types and a string on a few, and a dead slug must be reported in
 * either shape. These stay warnings: the document still parses, and the runtime keeps a named gap for
 * the lens. Being reported at all is the signal, not the severity.
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
	// Both sections are required: without `philosophy` the fixture fails tryParse and live-lens reads as dead.
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

	/** The list shape, which must be read and not skipped. */
	it( 'reports a dead lens named inside a list', () => {
		const found = lensIssues( 'references/list-one-dead.html' );
		expect( found ).toHaveLength( 1 );
		expect( found[ 0 ]!.ref ).toBe( 'retired-lens' );
	} );

	// One issue per dead member, not per field: a tally a repair loop reads must not undercount.
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

	/** Advisory by ruling: a missing lens does not stop the document parsing, so blocking would cost the repair its subject. */
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
