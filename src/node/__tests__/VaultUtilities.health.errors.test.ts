import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';
import { KcdValidate } from '../../core/html/KcdValidate';

/**
 * ONE ISSUE PER ERROR ( 2026-09-10 ).
 *
 * A validation throw carries every finding, but its `message` is a sentence and a sentence holds
 * one. `health` built its issue from that sentence, so a document failing on four counts reported
 * as one — and the summary tally, which is the number a repair loop actually reads, undercounted by
 * three. Measured live against a migration: a whole-vault sweep said 13 errors where there were 34.
 *
 * WHY AN UNDERCOUNT IS WORSE THAN A WRONG NUMBER. It does not read as broken; it reads as PROGRESS.
 * Fix the one named error, re-run, meet the next one, watch the tally fall — and the vault reads
 * green while documents are still malformed. Every assertion here pins a COUNT for that reason.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

/**
 * Three errors, three DIFFERENT codes, one document — so a test that passes cannot be passing
 * because one error was reported three times:
 *
 *   ephemeral-link  a link into work/, which is not installed into a vault at all ( §1.1 )
 *   bad-address     an absolute address, which escapes the project root
 *   empty-section   a declared section with nothing in it
 */
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

	// THE FIXTURE'S OWN PREMISE, asserted before anything is built on it. If the document stops
	// carrying exactly three errors, every count below becomes meaningless, and this case says so
	// directly rather than letting the others fail with a confusing number.
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

	// The sweep and the single-file check run the same method, so they cannot disagree — but this is
	// the face a repair loop actually drives, and the undercount was found on it.
	it( 'reports one issue per error on a whole-vault sweep', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.checked ).toBe( 1 );
		expect( summary.errors ).toBe( 3 );
	} );

	// The codes must SURVIVE the trip. Collapsing three findings into one generic "failed
	// validation" line would satisfy a count assertion and still tell a reader nothing about what to
	// fix — so the distinct codes are pinned too.
	it( 'carries each error\'s own code through to the issue text', () => {
		const { issues } = VaultUtilities.health( vaultOf(), 'references/patterns/trio.html' );
		for ( const code of [ 'ephemeral-link', 'bad-address', 'empty-section' ] )
			expect( issues.some( i => i.message.includes( code ) ) ).toBe( true );
	} );
} );
