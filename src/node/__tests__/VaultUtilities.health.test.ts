import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * The denominator ( 2026-08-17 ).
 *
 * `health` reported `{ total: 0 }` for both *I examined 314 documents and found nothing* and *I
 * examined nothing* — on the one command a person runs to prove a vault is sound. That is this
 * project's dominant failure class exactly: the check never returned a WRONG answer, it returned the
 * right answer for an empty input, which is why every existing assertion passed it.
 *
 * THE POINT OF THESE CASES is that the empty-vault one asserts the report does NOT read as success.
 * Asserting absence is the weakest assertion available, so each case here pins a POSITIVE number —
 * the count that makes a clean tally meaningful.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

const doc = ( name: string, body: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n${ body }\n</article>\n</body></html>\n`;

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-health-' ) );
	mkdirSync( join( root, '_Claude', 'references', 'patterns' ), { recursive: true } );
	mkdirSync( join( root, '_Claude', 'work', 'scratch' ), { recursive: true } );

	writeFileSync( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ), doc( 'alpha', '<p>Fine.</p>' ) );
	writeFileSync( join( root, '_Claude', 'references', 'patterns', 'beta.html' ),  doc( 'beta',  '<p>Also fine.</p>' ) );

	// A `plans/plans_complete/retired.html` STOOD HERE and was the whole point of the fixture: archival
	// space sat inside an indexed directory, so the walk reached it and the grader then skipped it, which
	// is what produced a scanned/checked gap. Archival is gone with the plan buckets, so the document
	// would now be GRADED — and it would fail, because `doc()` writes `type: reference` while the path
	// classifies `plan`. Removed rather than re-typed: there is no exclusion left for it to demonstrate.
	writeFileSync( join( root, '_Claude', 'work', 'scratch', 'notes.html' ), doc( 'notes', '<p>Scratch.</p>' ) );
	writeFileSync( join( root, '_Claude', 'references', 'patterns', 'tool.js' ), '// not a document\n' );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'VaultUtilities.health — the denominator', () => {

	it( 'reports how many documents it actually validated, not only what went wrong', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.checked ).toBe( 2 );
		expect( summary.total ).toBe( 0 );
	} );

	/**
	 * SCANNED AND CHECKED NOW AGREE, and the two numbers are kept apart anyway.
	 *
	 * They diverged while `archival` existed: a retired plan sat inside an indexed directory, so the walk
	 * reached it and the grader skipped it. Ephemeral is the only exclusion left and ephemeral space is
	 * not walked at all ( the walker covers indexed dirs only ), so nothing the walk reaches is now
	 * ungraded. A `.js` file is not a document and falls below `scanned` entirely.
	 *
	 * The pair stays in the report rather than collapsing to one number, because the gap is how a future
	 * exclusion would make itself visible instead of silently shrinking the denominator.
	 */
	it( 'grades everything the walk reaches, now that no exclusion sits inside an indexed directory', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.scanned ).toBe( 2 );
		expect( summary.checked ).toBe( 2 );
	} );

	/**
	 * THE FINDING THIS SWEEP EXISTS FOR, pinned as its own case. `health` used to enumerate via
	 * `vault.scan()`, which PARSES each file and drops whatever fails — so the malformed document was
	 * absent from its own report and the whole-vault summary read clean. Reproduced live on
	 * 2026-08-17: an unparseable file surfaced only in a per-path check, never in a sweep.
	 */
	it( 'reaches a malformed document that a parse-based scan would have dropped', () => {
		const bad = join( root, '_Claude', 'references', 'patterns', 'unparseable.html' );
		writeFileSync( bad, '<!DOCTYPE html><html><body><p>no article root</p></body></html>\n' );
		try {
			const { summary, issues } = VaultUtilities.health( vaultOf() );
			expect( summary.checked ).toBe( 3 );
			expect( issues.some( i => i.path.includes( 'unparseable' ) ) ).toBe( true );
		} finally {
			rmSync( bad, { force: true } );
		}
	} );

	/**
	 * THE CASE THE WHOLE FILE EXISTS FOR. An empty vault must not be indistinguishable from a clean
	 * one. `total: 0` is identical across both; `checked: 0` is what separates them.
	 */
	it( 'a vault with nothing in it reports checked:0 rather than a clean bill', () => {
		const empty = mkdtempSync( join( tmpdir(), 'kcd-health-empty-' ) );
		mkdirSync( join( empty, '_Claude' ), { recursive: true } );
		try {
			const { summary } = VaultUtilities.health( new Vault( empty, '_Claude' ) );
			expect( summary.total ).toBe( 0 );      // identical to a healthy vault…
			expect( summary.checked ).toBe( 0 );    // …and this is the only thing that says otherwise
		} finally {
			rmSync( empty, { recursive: true, force: true } );
		}
	} );

	it( 'a single-file check reports a denominator of one', () => {
		const { summary } = VaultUtilities.health( vaultOf(), 'references/patterns/alpha.html' );
		expect( summary.checked ).toBe( 1 );
		expect( summary.scanned ).toBe( 1 );
	} );

	// A parse failure is COUNTED and REPORTED — it must not silently reduce the denominator, or a
	// malformed document would make the vault look smaller and cleaner at the same time.
	it( 'counts an unparseable document as checked, and reports it as an error', () => {
		const bad = join( root, '_Claude', 'references', 'patterns', 'broken.html' );
		writeFileSync( bad, '<!DOCTYPE html><html><body><p>no article root</p></body></html>\n' );
		try {
			const { summary, issues } = VaultUtilities.health( vaultOf() );
			expect( summary.checked ).toBe( 3 );
			expect( summary.errors ).toBeGreaterThan( 0 );
			expect( issues.some( i => i.path.includes( 'broken' ) ) ).toBe( true );
		} finally {
			rmSync( bad, { force: true } );
		}
	} );
} );
