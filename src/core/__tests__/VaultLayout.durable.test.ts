import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { Vault } from '../../node/Vault'
import { VaultDeploy } from '../../node/VaultDeploy'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * DURABLE vs EPHEMERAL — a third exclusion axis. A ledger is durable state inside disposable space, and the
 * pair of claims must not collapse: nothing may link into it, and nothing may delete it. Durability is its own
 * flag, not `indexed`, so the ledger stays uncitable and ungraded.
 */
describe( 'VaultLayout — a ledger is durable state inside disposable space', () => {

	const LEDGER = '_Claude/audits/ledgers/audit-doc-truth.json'

	it( 'declares the ledgers bucket durable, and its parent not', () => {
		expect( VaultLayout.durableDirs() ).toContain( 'audits/ledgers' )
		expect( VaultLayout.durableDirs() ).not.toContain( 'audits' )
	} )

	/** `audits/` stays disposable for everything that is not a ledger, and `scratch` beside it is
	 *  correctly disposable and must stay that way. Protecting one bucket must not protect its parent. */
	it( 'leaves the rest of the disposable space disposable', () => {
		expect( VaultLayout.isDurablePath( '_Claude/audits/some-backup.html' ) ).toBe( false )
		expect( VaultLayout.isDurablePath( '_Claude/audits' ) ).toBe( false )
		expect( VaultLayout.isDurablePath( '_Claude/scratch/anything.json' ) ).toBe( false )
		expect( VaultLayout.isDurablePath( '_Claude/work/studio/AI/notes.md' ) ).toBe( false )
		expect( VaultLayout.durableDirs() ).not.toContain( 'scratch' )
	} )

	it( 'matches the declared directory itself and everything beneath it', () => {
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers' ) ).toBe( true )
		expect( VaultLayout.isDurablePath( LEDGER ) ).toBe( true )
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers/nested/deep.json' ) ).toBe( true )
	} )

	/** Segment-boundary matching, never bare `startsWith`. A sibling whose name merely begins with the
	 *  declared prefix is a different directory. */
	it( 'does not swallow a sibling with a prefix-colliding name', () => {
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers-old/x.json' ) ).toBe( false )
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers-backup.json' ) ).toBe( false )
	} )

	/** Same doc-root anchoring `isEphemeralHref` uses, so every form a caller might hold agrees. */
	it( 'answers alike for href, vault-relative, and absolute forms', () => {
		const abs = path.join( PROJECT_ROOT, '_Claude', 'audits', 'ledgers', 'audit-tests.json' )
		expect( VaultLayout.isDurablePath( LEDGER ) ).toBe( true )
		expect( VaultLayout.isDurablePath( 'audits/ledgers/audit-tests.json' ) ).toBe( true )
		expect( VaultLayout.isDurablePath( abs ) ).toBe( true )
	} )

	/** Flipping `indexed` would trade a deletion bug for a grading and citation bug, so durability stays a separate flag. */
	it( 'is still ephemeral on the link axis — durable did not make it citable', () => {
		expect( VaultLayout.isEphemeralHref( LEDGER ) ).toBe( true )
		expect( VaultLayout.ephemeralDirs() ).toContain( 'audits' )
		expect( VaultLayout.indexedDirs() ).not.toContain( 'audits' )
	} )

	/** And still not graded. `isLibraryPath` is the gate the whole-vault sweep actually calls, so this is
	 *  what proves a ledger is not about to be held to the document standard. */
	it( 'is still outside the graded library', () => {
		const vault = new Vault( PROJECT_ROOT, '_Claude' )
		expect( vault.isLibraryPath( 'audits/ledgers/audit-tests.json' ) ).toBe( false )
	} )

	/** Durability says nothing about identity, so the ledger stays unclassified. */
	it( 'is not a governed artifact', () => {
		expect( VaultLayout.classify( LEDGER ) ).toBe( 'unknown' )
	} )
} )

/**
 * A FENCE against a future reset path, not a proof of a repair: `VaultDeploy.apply` fills and never removes.
 */
describe( 'VaultDeploy.apply — the live path does not remove a ledger', () => {

	const DOC_ROOT = '_Claude'
	const LEDGER   = 'audits/ledgers/audit-doc-truth.json'
	const BODY     = '{"audited":["references/patterns/x.html"],"generated":"2026-09-22"}\n'

	let root = ''

	beforeAll( () => {
		root = mkdtempSync( path.join( tmpdir(), 'kcd-durable-' ) )

		// A ledger written the way an analyzer writes one: machine JSON, under a vault that otherwise
		// does not exist yet, so the deploy has every reason to treat the tree as fresh.
		mkdirSync( path.join( root, DOC_ROOT, 'audits', 'ledgers' ), { recursive: true } )
		writeFileSync( path.join( root, DOC_ROOT, LEDGER ), BODY, 'utf-8' )

		// A scratch file beside the ledger tells "nothing deleted" apart from "ledger spared".
		writeFileSync( path.join( root, DOC_ROOT, 'audits', 'stale-backup.html' ), '<p>scratch</p>', 'utf-8' )

		VaultDeploy.apply( root, { docRoot: DOC_ROOT } )
	} )

	afterAll( () => {
		if( root ) rmSync( root, { recursive: true, force: true } )
	} )

	it( 'leaves the ledger on disk', () => {
		expect( existsSync( path.join( root, DOC_ROOT, LEDGER ) ) ).toBe( true )
	} )

	/** Byte-identical, not merely present: a file re-created empty would pass an existence check and lose its rows. */
	it( 'leaves the ledger\'s contents untouched', () => {
		expect( readFileSync( path.join( root, DOC_ROOT, LEDGER ), 'utf-8' ) ).toBe( BODY )
	} )

	/** The deploy scaffolds the directory from the layout row, so a project that has never run an
	 *  analyzer still has somewhere for the first ledger to land. */
	it( 'scaffolds the ledgers directory from the layout row', () => {
		const report = VaultDeploy.inspect( root, { docRoot: DOC_ROOT } )
		const row    = report.items.find( ( i ) => i.path === 'audits/ledgers' )
		expect( row ).toBeDefined()
		expect( row!.present ).toBe( true )
	} )
} )
