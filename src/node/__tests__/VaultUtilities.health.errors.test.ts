import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';
import { KcdValidate } from '../../core/html/KcdValidate';

/**
 * One issue per error, not one per document: a sentence-shaped message holds one finding, and an
 * undercounted tally reads as progress. Every assertion here pins a count for that reason.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

/** Three errors of three distinct codes, so a passing count cannot be one error reported three times. */
const THREE_ERRORS =
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>trio</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">trio</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">Three findings, three codes.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>trio</h1>\n`
	+ `<section data-kcd-section="overview"><h2>Overview</h2>`
	+ `<p>A link into scratch space: <a href="_Claude/work/notes.html">notes</a></p>`
	+ `<p>An absolute address: <code data-kcd-address="/etc/passwd">somewhere</code></p>`
	+ `</section>\n`
	+ `<section data-kcd-section="hollow"></section>\n`
	+ `</article>\n</body></html>\n`;

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-health-errors-' ) );
	mkdirSync( join( root, '_Claude', 'references', 'patterns' ), { recursive: true } );
	writeFileSync( join( root, '_Claude', 'references', 'patterns', 'trio.html' ), THREE_ERRORS );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'VaultUtilities.health — every error, not only the first', () => {

	// The fixture's premise: if it stops carrying three errors, every count below is meaningless.
	it( 'the fixture really does carry three errors of three different codes', () => {
		const report = KcdValidate.validate( THREE_ERRORS, { docRoot: '_Claude', path: '_Claude/references/patterns/trio.html' } );
		expect( report.ok ).toBe( false );
		expect( report.errors ).toHaveLength( 3 );
		expect( new Set( report.errors.map( e => e.code ) ).size ).toBe( 3 );
	} );

	it( 'reports one issue per error on a single-file check', () => {
		const { issues, summary } = VaultUtilities.health( vaultOf(), 'references/patterns/trio.html' );
		expect( issues ).toHaveLength( 3 );
		expect( summary.errors ).toBe( 3 );
	} );

	// The sweep is the face a repair loop drives, so the count is pinned here as well.
	it( 'reports one issue per error on a whole-vault sweep', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.checked ).toBe( 1 );
		expect( summary.errors ).toBe( 3 );
	} );

	// A generic line would pass the count and tell a reader nothing, so the codes are pinned too.
	it( 'carries each error\'s own code through to the issue text', () => {
		const { issues } = VaultUtilities.health( vaultOf(), 'references/patterns/trio.html' );
		for ( const code of [ 'ephemeral-link', 'bad-address', 'empty-section' ] )
			expect( issues.some( i => i.message.includes( code ) ) ).toBe( true );
	} );
} );
