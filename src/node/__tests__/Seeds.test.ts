import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { Vault } from '../Vault'
import { VaultUtilities } from '../VaultUtilities'
import { KcdContext } from '../../core/html/KcdContext'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

/**
 * §10 SEEDS — the three claims the protocol and the Daedalus README both make in prose, pinned so the
 * prose cannot quietly stop being true. Written 2026-08-13 alongside the §10 documentation pass, whose
 * whole premise is that prose alone is what drifted last time.
 *
 * The claims:
 *   1. A payload is carried VERBATIM. Script content is raw text and needs no escaping, so what an
 *      author writes is what lands in CLAUDE.md.
 *   2. Seeds NEVER COMPILE. The context projector strips them, so a payload written for an agent that
 *      has not read the vault never reaches one that has — and three host blocks do not triple the wire.
 *   3. Seed targets ARE the install's file registry. `installedPaths` derives from the declarations, so
 *      an uninstall removes exactly what the install added and no second list can drift.
 *
 * Each is load-bearing and each fails SILENTLY: a corrupted payload still writes a file, a leaked seed
 * still compiles, and a missed target just leaves litter behind on uninstall. None of them announce.
 */
const SEED_BLOCK = [
	'<script type="text/kcd-md" data-kcd-seed="claude" data-kcd-target="CLAUDE.md" data-kcd-mode="prepend">',
	'# Heading',
	'',
	'> A blockquote, which is markdown\'s `>` character.',
	'Prose with A & B, a <tag>, and 5 < 10.',
	'</script>'
].join( '\n' )

describe( 'parseSeedsFrom — a payload is carried verbatim', () => {

	it( 'reads host, target and mode off the declaration', () => {
		const [ seed ] = VaultUtilities.parseSeedsFrom( SEED_BLOCK )
		expect( seed.host ).toBe( 'claude' )
		expect( seed.target ).toBe( 'CLAUDE.md' )
		expect( seed.mode ).toBe( 'prepend' )
	} )

	/** The claim that matters. Every one of these characters is what `serialize` used to escape, and an
	 *  escaped `>` here is a literal `&gt;` in a real project's CLAUDE.md. */
	it( 'keeps <, & and > exactly as authored', () => {
		const [ seed ] = VaultUtilities.parseSeedsFrom( SEED_BLOCK )
		expect( seed.payload ).toContain( '> A blockquote' )
		expect( seed.payload ).toContain( 'A & B' )
		expect( seed.payload ).toContain( '<tag>' )
		expect( seed.payload ).toContain( '5 < 10' )
		expect( seed.payload ).not.toContain( '&gt;' )
		expect( seed.payload ).not.toContain( '&amp;' )
		expect( seed.payload ).not.toContain( '&lt;' )
	} )

	it( 'defaults an absent mode to prepend rather than failing', () => {
		const html = '<script type="text/kcd-md" data-kcd-seed="x" data-kcd-target="X.md">body</script>'
		expect( VaultUtilities.parseSeedsFrom( html )[ 0 ].mode ).toBe( 'prepend' )
	} )

	/** root-context may legitimately grow other script content; only the kcd-md type is a seed. */
	it( 'skips a script that is not a seed, and says nothing about it', () => {
		const html = '<script type="text/kcd-js" data-entry="go">var a = 1</script>'
		expect( VaultUtilities.parseSeedsFrom( html ) ).toEqual( [] )
	} )

	it( 'skips a block missing either protocol-required attribute', () => {
		expect( VaultUtilities.parseSeedsFrom( '<script type="text/kcd-md" data-kcd-seed="x">b</script>' ) ).toEqual( [] )
		expect( VaultUtilities.parseSeedsFrom( '<script type="text/kcd-md" data-kcd-target="X.md">b</script>' ) ).toEqual( [] )
	} )
} )

/**
 * Claim 2. A seed is deploy input, not agent context — it is prose written FOR an agent that has not
 * read the vault, which is precisely the wrong thing to hand one that has. Leaking it would also triple
 * `root-context` on the wire, since one document carries a block per host.
 */
describe( 'seeds never compile', () => {

	const BODY = `<p>Before the seed.</p>${ SEED_BLOCK }<p>After the seed.</p>`

	it( 'strips the payload out of projected context entirely', () => {
		const text = KcdContext.body( BODY )
		expect( text ).not.toContain( 'A blockquote' )
		expect( text ).not.toContain( '# Heading' )
		expect( text ).not.toContain( 'kcd-md' )
	} )

	it( 'strips the block, not the section around it', () => {
		const text = KcdContext.body( BODY )
		expect( text ).toContain( 'Before the seed.' )
		expect( text ).toContain( 'After the seed.' )
	} )
} )

/**
 * Claim 3. `installedPaths` is the one answer to "what did we put in this repository", derived from the
 * seed declarations rather than written down beside them. Asserted as an INVARIANT over whatever the
 * vault declares, not against a literal list — a project that adds a fourth host must not fail this.
 */
describe( 'installedPaths — the seed set IS the install registry', () => {

	const vault = new Vault( PROJECT_ROOT, '_Claude' )

	it( 'always names the Model Context Protocol registration file', () => {
		expect( VaultUtilities.installedPaths( vault ) ).toContain( '.mcp.json' )
	} )

	it( 'names every declared seed target, whatever the vault declares', () => {
		const declared = VaultUtilities.parseSeeds( vault ).map( s => s.target )
		const reported = VaultUtilities.installedPaths( vault )
		expect( declared.length ).toBeGreaterThan( 0 )          // a vault with no seeds proves nothing
		for ( const target of declared ) expect( reported ).toContain( target )
	} )

	/** Absence is not failure: a half-built vault has seeded nothing, so there is nothing to name. */
	it( 'tolerates a vault with no seed carrier yet', () => {
		const tmp = fs.mkdtempSync( path.join( os.tmpdir(), 'kcd-seed-' ) )
		try {
			expect( VaultUtilities.installedPaths( new Vault( tmp, '_Claude' ) ) ).toEqual( [ '.mcp.json' ] )
		} finally {
			fs.rmSync( tmp, { recursive: true, force: true } )
		}
	} )
} )
