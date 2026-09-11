import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * A WRONG-VAULT REFERENCE IS AN ERROR, NOT A DANGLING LINK ( 2026-09-10 ).
 *
 * The two look identical to a naive check — neither target is on disk — but they call for opposite
 * responses. A dangling link usually means the target has not been written yet: wait, or write it.
 * A wrong-vault reference means the DOCUMENT IS MISTAKEN ABOUT WHERE IT LIVES, and everything that
 * follows the link goes nowhere until someone repairs it. Reporting both as advisory warnings put
 * the second one in a bucket people are trained to skim.
 *
 * IT IS PROVEN, NOT GUESSED, and that distinction is the whole design. Swap the href's leading
 * segment for this vault's name; if the target then exists, the reference was correct about
 * everything except which vault it is in. A heuristic on the shape of the name ( "starts with an
 * underscore" ) would have flagged project paths and missed a vault named `kcd`.
 */

let root = '';

const doc = ( name: string, body: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="overview"><h2>Overview</h2>${ body }</section>\n`
	+ `</article>\n</body></html>\n`;

beforeAll( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-wrongvault-' ) );
	mkdirSync( join( root, '_kcd', 'references' ), { recursive: true } );
	mkdirSync( join( root, 'starmind', 'src' ),    { recursive: true } );

	// The target really is here, under THIS vault's name.
	writeFileSync( join( root, '_kcd', 'references', 'target.html' ), doc( 'target', '<p>Here.</p>' ) );

	writeFileSync( join( root, '_kcd', 'references', 'stale.html' ),
		doc( 'stale', '<p><a href="_Claude/references/target.html">target</a></p>' ) );

	writeFileSync( join( root, '_kcd', 'references', 'unwritten.html' ),
		doc( 'unwritten', '<p><a href="_kcd/references/not-yet.html">not yet</a></p>' ) );

	writeFileSync( join( root, '_kcd', 'references', 'code.html' ),
		doc( 'code', '<p><a href="starmind/src/Missing.vue">Missing.vue</a></p>' ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

const issuesFor = ( file: string ) =>
	new Vault( root, '_kcd' ).referenceIssues( file );

describe( 'Vault.referenceIssues — wrong vault vs. missing target', () => {

	it( 'raises an ERROR when the target exists under this vault\'s own name', () => {
		const [ issue ] = issuesFor( 'references/stale.html' );
		expect( issue.severity ).toBe( 'error' );
		expect( issue.message ).toContain( 'wrong vault' );
	} );

	// The message has to carry the repair, or a reader has to go and work it out by hand.
	it( 'names both vaults and where the target actually is', () => {
		const [ issue ] = issuesFor( 'references/stale.html' );
		expect( issue.message ).toContain( '_Claude' );
		expect( issue.message ).toContain( '_kcd' );
		expect( issue.message ).toContain( '_kcd/references/target.html' );
	} );

	/**
	 * THE CASE THAT MUST NOT TRIGGER, and the reason the check is evidence-based. A link to project
	 * code is not a vault reference — swapping its first segment produces nothing, so it stays the
	 * advisory warning it always was. A shape-based rule would have promoted this to an error and
	 * taught everyone to ignore the new severity within a week.
	 */
	it( 'leaves a link to project code as an ordinary warning', () => {
		const [ issue ] = issuesFor( 'references/code.html' );
		expect( issue.severity ).toBe( 'warn' );
		expect( issue.message ).toContain( 'missing on disk' );
	} );

	// A target simply not written yet is the ordinary case and must stay advisory — an address, or a
	// plan for tomorrow, is not a defect.
	it( 'leaves a not-yet-written target in this vault as a warning', () => {
		const [ issue ] = issuesFor( 'references/unwritten.html' );
		expect( issue.severity ).toBe( 'warn' );
		expect( issue.message ).toContain( 'missing on disk' );
	} );

	// And a healthy document raises nothing at all — the guard must not fire on a link that resolves.
	it( 'says nothing about a link that resolves', () => {
		expect( issuesFor( 'references/target.html' ) ).toEqual( [] );
	} );
} );
