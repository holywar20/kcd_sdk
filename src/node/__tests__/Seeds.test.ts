import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { Vault } from '../Vault'
import { VaultUtilities } from '../VaultUtilities'
import { KcdContext } from '../../core/html/KcdContext'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

/**
 * §10 SEEDS: the three claims the protocol makes in prose, pinned so the prose cannot quietly stop being true.
 * (1) A payload is carried verbatim. (2) Seeds never compile, so a payload written for an unread vault never reaches one that has.
 * (3) Seed targets are the install's file registry, so an uninstall removes exactly what the install added.
 * Each fails silently; none of them announce.
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

	/** The claim that matters: an escaped `>` here would be a literal `&gt;` in a real project's CLAUDE.md. */
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
 * Claim 2: a seed is deploy input written for an agent that has not read the vault, so it must never compile.
 * Leaking it would also multiply `root-context` on the wire, once per host.
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
 * Claim 3: `installedPaths` is derived from the seed declarations, not written beside them, so no second list can drift.
 * Asserted as an invariant over whatever the vault declares, so a fourth host does not fail it.
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
