import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultDeploy } from '../VaultDeploy';
import { VaultUtilities } from '../VaultUtilities';
import { VaultLayout } from '../../core';
import { KcdValidate } from '../../core/html/KcdValidate';

/**
 * The vault name here is deliberately not `_Claude`, so a fix that hardcodes the default cannot pass.
 * Every assertion checks for the wrong name as well as the right one: emitting both would satisfy a
 * check for the right one alone.
 */

const DOC_ROOT = '_kcd';
let root = '';
let substrate = '';

/** A minimal seed carrier: one §10 payload whose subject IS where the vault lives. */
const ROOT_CONTEXT =
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>root-context</title></head><body>\n`
	+ `<article data-kcd="framework">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">root-context</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">Seed carrier.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">framework</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>root-context</h1>\n`
	+ `<section data-kcd-section="seed-claude"><h2>Seed — claude</h2>\n`
	+ `<script type="text/kcd-md" data-kcd-seed="claude" data-kcd-target="CLAUDE.md" data-kcd-mode="prepend">\n`
	+ `KCD tool paths resolve against \`_Claude/\`, not the project root.\n`
	+ `If the server is unavailable, read \`_Claude/root.html\` directly instead.\n`
	+ `</script>\n</section>\n`
	+ `</article>\n</body></html>\n`;

beforeAll( () => {
	root      = mkdtempSync( join( tmpdir(), 'kcd-docroot-' ) );
	substrate = mkdtempSync( join( tmpdir(), 'kcd-substrate-' ) );
	writeFileSync( join( substrate, 'root-context.html' ), ROOT_CONTEXT );
	mkdirSync( join( substrate, 'habits', 'nested' ), { recursive: true } );
	writeFileSync( join( substrate, 'habits', 'nested', 'linked.html' ),
		`<p>see <a href="_Claude/references/x.html">x</a> and <code>_Claude/logs/</code></p>` );
	writeFileSync( join( substrate, 'habits', 'logo.bin' ), Buffer.from( [ 0xff, 0xfe, 0x00, 0x5f ] ) );

	VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate } );

	// The substrate here carries only the seed carrier, so place it the way a real deploy would.
	mkdirSync( join( root, DOC_ROOT ), { recursive: true } );
	if ( !existsSync( join( root, DOC_ROOT, 'root-context.html' ) ) )
		writeFileSync( join( root, DOC_ROOT, 'root-context.html' ), ROOT_CONTEXT );
} );

afterAll( () => {
	if ( root )      rmSync( root,      { recursive: true, force: true } );
	if ( substrate ) rmSync( substrate, { recursive: true, force: true } );
} );

describe( 'a vault installed under a non-default doc root', () => {

	it( 'builds the vault under the name it was given', () => {
		expect( existsSync( join( root, DOC_ROOT, 'lenses' ) ) ).toBe( true );
		expect( existsSync( join( root, '_Claude' ) ) ).toBe( false );
	} );

	// ── The generated entry map ───────────────────────────────────────────────

	it( 'generates a nav-index naming the real vault, never the default', () => {
		const html = readFileSync( join( root, DOC_ROOT, VaultLayout.NAV_INDEX_FILE ), 'utf-8' );
		expect( html ).toContain( `${ DOC_ROOT }/lenses/` );
		expect( html ).not.toContain( '_Claude' );
	} );

	/** The generated index must pass the validator: it once linked into `work/` and `logs/`, which §1.1 forbids. */
	it( 'generates a nav-index that validates clean', () => {
		const html   = readFileSync( join( root, DOC_ROOT, VaultLayout.NAV_INDEX_FILE ), 'utf-8' );
		const report = KcdValidate.validate( html, { docRoot: '_Claude', path: `${ DOC_ROOT }/${ VaultLayout.NAV_INDEX_FILE }` } );
		expect( report.errors ).toEqual( [] );
	} );

	/** Asserted by presence, not absence: a generator that emitted `_Claude/work/` would also have no link to `_kcd/work/`. */
	it( 'still lists the ephemeral directories — as addresses, not links', () => {
		const html = readFileSync( join( root, DOC_ROOT, VaultLayout.NAV_INDEX_FILE ), 'utf-8' );
		for ( const dir of VaultLayout.ephemeralDirs() ) {
			expect( html ).toContain( `data-kcd-type="address">${ DOC_ROOT }/${ dir }/<` );
			expect( html ).not.toContain( `href="${ DOC_ROOT }/${ dir }/"` );
		}
	} );

	/** …and the indexed directories stay real links — the two forms must not collapse into one. */
	it( 'keeps the indexed directories as links', () => {
		const html = readFileSync( join( root, DOC_ROOT, VaultLayout.NAV_INDEX_FILE ), 'utf-8' );
		expect( html ).toContain( `href="${ DOC_ROOT }/lenses/"` );
		expect( html ).toContain( `href="${ DOC_ROOT }/references/"` );
	} );

	// ── The host seed ─────────────────────────────────────────────────────────

	/** The payload is agent-facing prose naming where the vault lives, so it is rewritten for this vault. */
	it( 'rewrites the seed payload for the vault it is installed beside', () => {
		const [ seed ] = VaultUtilities.parseSeeds( new Vault( root, DOC_ROOT ) );
		expect( seed.payload ).toContain( `${ DOC_ROOT }/root.html` );
		expect( seed.payload ).not.toContain( '_Claude' );
		expect( seed.target ).toBe( 'CLAUDE.md' );   // the TARGET is a filename, unaffected
	} );

	it( 'leaves a default-rooted payload exactly as authored', () => {
		const [ seed ] = VaultUtilities.parseSeedsFrom( ROOT_CONTEXT, '_Claude' );
		expect( seed.payload ).toContain( '_Claude/root.html' );
		expect( seed.payload ).not.toContain( DOC_ROOT );
	} );

} );


/** The bundled corpus hardcodes `_Claude/` in its links, so a verbatim copy is not portable to another vault. */
describe( 'the bundled corpus, filled into a non-default vault', () => {

	it( 'retargets links inside copied documents', () => {
		const html = readFileSync( join( root, DOC_ROOT, 'habits', 'nested', 'linked.html' ), 'utf-8' );
		expect( html ).toContain( `href="${ DOC_ROOT }/references/x.html"` );
		expect( html ).not.toContain( '_Claude' );
	} );

	it( 'reaches nested directories, not just the top level', () => {
		expect( existsSync( join( root, DOC_ROOT, 'habits', 'nested', 'linked.html' ) ) ).toBe( true );
	} );

	/** Non-text files are copied, never decoded: rewriting a binary as UTF-8 corrupts it. Allowlist, not blocklist. */
	it( 'copies a non-text file byte-for-byte', () => {
		const bytes = readFileSync( join( root, DOC_ROOT, 'habits', 'logo.bin' ) );
		expect( [ ...bytes ] ).toEqual( [ 0xff, 0xfe, 0x00, 0x5f ] );
	} );

	// The default vault must be untouched by any of this — the retarget is the identity function
	// there, so the ordinary install copies exactly what it always did.
	it( 'leaves a default-rooted install byte-identical', () => {
		const plain = mkdtempSync( join( tmpdir(), 'kcd-docroot-default-' ) );
		try {
			VaultDeploy.apply( plain, { docRoot: '_Claude', substrateSource: substrate } );
			const html = readFileSync( join( plain, '_Claude', 'habits', 'nested', 'linked.html' ), 'utf-8' );
			expect( html ).toBe( readFileSync( join( substrate, 'habits', 'nested', 'linked.html' ), 'utf-8' ) );
		} finally {
			rmSync( plain, { recursive: true, force: true } );
		}
	} );
} );


/** `fill` is also called with a destination that does not exist yet; the caller creates only the parent. */
describe( 'VaultDeploy.fill — the second caller', () => {

	it( 'creates a destination that does not exist yet', () => {
		const to = mkdtempSync( join( tmpdir(), 'kcd-fill-' ) );
		try {
			const dest = join( to, 'does', 'not', 'exist' );
			VaultDeploy.fill( join( substrate, 'habits' ), dest, DOC_ROOT );
			expect( existsSync( join( dest, 'nested', 'linked.html' ) ) ).toBe( true );
		} finally {
			rmSync( to, { recursive: true, force: true } );
		}
	} );
} );
