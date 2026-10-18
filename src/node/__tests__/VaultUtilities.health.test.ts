import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * The denominator. `total: 0` reads the same for an empty vault as for a healthy one, so each case
 * pins a positive count (`checked`) rather than asserting absence, which is the weakest assertion.
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

	// Nothing inside an indexed directory is excluded, so this document is graded.
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
	 * Kept as two numbers on purpose: a future exclusion would show as a gap between them rather than
	 * silently shrinking the denominator. A non-document file falls below `scanned` entirely.
	 */
	it( 'grades everything the walk reaches, now that no exclusion sits inside an indexed directory', () => {
		const { summary } = VaultUtilities.health( vaultOf() );
		expect( summary.scanned ).toBe( 2 );
		expect( summary.checked ).toBe( 2 );
	} );

	/** A parse-based scan drops a malformed document and the sweep reads clean; the walk must reach it. */
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

	/** `total: 0` is identical for an empty vault and a healthy one; `checked: 0` is what separates them. */
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
