import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * A link cased wrong is a broken link, and an error. The check reads directory entries rather than the filesystem's
 * willingness to open a path, so it judges case exactly and behaves the same on case-insensitive and case-sensitive hosts.
 * Error, not warn: the link fails in any container, and the failure is invisible on the developer's machine.
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
	root = mkdtempSync( join( tmpdir(), 'kcd-casemismatch-' ) );
	mkdirSync( join( root, '_kcd', 'references' ), { recursive: true } );
	mkdirSync( join( root, 'starmind', 'src' ),    { recursive: true } );

	writeFileSync( join( root, '_kcd', 'references', 'target.html' ), doc( 'target', '<p>Here.</p>' ) );
	writeFileSync( join( root, 'starmind', 'src', 'Thing.vue' ),      '<template><div /></template>\n' );

	// Right path, wrong case on a middle segment — the folder is `references`.
	writeFileSync( join( root, '_kcd', 'references', 'middle.html' ),
		doc( 'middle', '<p><a href="_kcd/References/target.html">target</a></p>' ) );

	// Wrong case on the DOC ROOT itself — the TitansReach shape exactly.
	writeFileSync( join( root, '_kcd', 'references', 'docroot.html' ),
		doc( 'docroot', '<p><a href="_KCD/references/target.html">target</a></p>' ) );

	// Wrong case on the leaf filename.
	writeFileSync( join( root, '_kcd', 'references', 'leaf.html' ),
		doc( 'leaf', '<p><a href="_kcd/references/Target.html">target</a></p>' ) );

	// Project code, cased wrong — the check is not vault-only, because neither is the link.
	writeFileSync( join( root, '_kcd', 'references', 'code.html' ),
		doc( 'code', '<p><a href="starmind/src/thing.vue">Thing.vue</a></p>' ) );

	// Correctly cased, and must stay silent.
	writeFileSync( join( root, '_kcd', 'references', 'clean.html' ),
		doc( 'clean', '<p><a href="_kcd/references/target.html">target</a>'
		            + ' <a href="starmind/src/Thing.vue">Thing.vue</a></p>' ) );

	// Genuinely absent, and must stay the advisory warning it has always been.
	writeFileSync( join( root, '_kcd', 'references', 'unwritten.html' ),
		doc( 'unwritten', '<p><a href="_kcd/references/not-yet.html">not yet</a></p>' ) );
} );

afterAll( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

const vaultOf  = () => new Vault( root, '_kcd' );
const issuesFor = ( file: string ) => vaultOf().referenceIssues( file );

describe( 'Vault.referenceIssues — a link cased wrong', () => {

	it( 'is an ERROR on a middle segment, naming the href and the real casing', () => {
		const [ issue ] = issuesFor( 'references/middle.html' );
		expect( issue.severity ).toBe( 'error' );
		expect( issue.message ).toContain( 'case mismatch' );
		expect( issue.ref ).toBe( '_kcd/References/target.html' );
		expect( issue.message ).toContain( '_kcd/references/target.html' );
	} );

	// The doc-root case also satisfies the wrong-vault check and must not be reported as one: that sends a reader
	// to redo a migration, where the fix is one letter.
	it( 'is an ERROR on the doc root, and reads as a case mismatch rather than a wrong vault', () => {
		const [ issue ] = issuesFor( 'references/docroot.html' );
		expect( issue.severity ).toBe( 'error' );
		expect( issue.message ).toContain( 'case mismatch' );
		expect( issue.message ).not.toContain( 'wrong vault' );
		expect( issue.message ).toContain( '_kcd/references/target.html' );
	} );

	it( 'is an ERROR on the leaf filename', () => {
		const [ issue ] = issuesFor( 'references/leaf.html' );
		expect( issue.severity ).toBe( 'error' );
		expect( issue.ref ).toBe( '_kcd/references/Target.html' );
		expect( issue.message ).toContain( '_kcd/references/target.html' );
	} );

	// A link into project code is still a link. The old check let these through for the same reason.
	it( 'is an ERROR on a link into project code', () => {
		const [ issue ] = issuesFor( 'references/code.html' );
		expect( issue.severity ).toBe( 'error' );
		expect( issue.message ).toContain( 'starmind/src/Thing.vue' );
	} );

	// The regression that matters most: a correct vault must still read clean, or the new error is noise and
	// gets skimmed within a week.
	it( 'says nothing at all about correctly-cased links', () => {
		expect( issuesFor( 'references/clean.html' ) ).toEqual( [] );
	} );

	// Absence is not a case fault. A target not written yet is a legal state and stays advisory.
	it( 'leaves a genuinely missing target as a warning', () => {
		const [ issue ] = issuesFor( 'references/unwritten.html' );
		expect( issue.severity ).toBe( 'warn' );
		expect( issue.message ).toContain( 'missing on disk' );
	} );
} );

describe( 'VaultUtilities.health — the whole-vault sweep', () => {

	/** The sweep must report errors; the denominator is asserted first, since a sweep that checked nothing reports nothing wrong. */
	it( 'counts a cased-wrong link as an error, not a warning', () => {
		const { summary, issues } = VaultUtilities.health( vaultOf() );

		expect( summary.checked ).toBeGreaterThan( 0 );
		expect( summary.errors ).toBeGreaterThan( 0 );

		const cased = issues.filter( i => i.message.includes( 'case mismatch' ) );
		expect( cased.length ).toBe( 4 );
		expect( cased.every( i => i.severity === 'error' ) ).toBe( true );
		// Each names the artifact it is in, which is the other half of an actionable report.
		expect( cased.map( i => i.path ).sort() ).toEqual( [
			'references/code.html', 'references/docroot.html', 'references/leaf.html', 'references/middle.html',
		] );
	} );
} );
