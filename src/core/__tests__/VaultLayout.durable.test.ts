import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { Vault } from '../../node/Vault'
import { VaultDeploy } from '../../node/VaultDeploy'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * DURABLE vs EPHEMERAL — a third exclusion axis, and the one nothing was tracking ( TASK-732 ).
 *
 * Seven analyzers ( audit-backlog, audit-dead-code, audit-defects, audit-doc-truth,
 * audit-renderer-defects, audit-renderer-perf, audit-tests ) each declare a ledger under
 * `audits/ledgers` as a durable Input/Output, loaded in Phase 1 and rewritten as each unit finishes.
 * `audits/` is `indexed: false`, and `VaultLayout.ephemeralDirs()` DERIVES ephemeral from `indexed` —
 * so the vault said "disposable" about a directory holding durable coverage state, and nothing
 * distinguished a ledger from scratch to whoever cleaned up next. `audit-doc-truth.json` went missing
 * between a 2026-09-22 run and the next one.
 *
 * THE PAIR OF CLAIMS IS THE WHOLE POINT, and these tests exist to stop them collapsing in either
 * direction. *Nothing validates links into here* and *this may be deleted at will* are independent:
 * a ledger wants the first and emphatically not the second. So the fix had to protect it from deletion
 * WITHOUT making it indexed, graded or citable — and the second half is the easier one to break while
 * believing you have fixed the first, which is why it is asserted as loudly as the protection is.
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

	/** Segment-boundary matching, never bare `startsWith` — the same rule `isArchivalPath` follows. A
	 *  sibling whose name merely begins with the declared prefix is a different directory. */
	it( 'does not swallow a sibling with a prefix-colliding name', () => {
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers-old/x.json' ) ).toBe( false )
		expect( VaultLayout.isDurablePath( '_Claude/audits/ledgers-backup.json' ) ).toBe( false )
	} )

	/** Same doc-root anchoring the other two predicates use, so every form a caller might hold agrees. */
	it( 'answers alike for href, vault-relative, and absolute forms', () => {
		const abs = path.join( PROJECT_ROOT, '_Claude', 'audits', 'ledgers', 'audit-tests.json' )
		expect( VaultLayout.isDurablePath( LEDGER ) ).toBe( true )
		expect( VaultLayout.isDurablePath( 'audits/ledgers/audit-tests.json' ) ).toBe( true )
		expect( VaultLayout.isDurablePath( abs ) ).toBe( true )
	} )

	/**
	 * THE LOAD-BEARING ONE, and it guards the opposite mistake to the archival suite's.
	 *
	 * The cheap way to make a ledger survive a sweep would have been to flip `indexed` — and that would
	 * trade a data-loss bug for a validation bug: a ledger would become graded as a KCD document ( it is
	 * machine-written JSON and would fail ), and linking into it would become legal, which §1.1 forbids
	 * because nothing can promise occupancy in there. Durability is a SEPARATE flag precisely so this
	 * stays false.
	 */
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

	/** Durability says nothing about identity or grading, so the two flags it sits beside are untouched. */
	it( 'is neither archival nor a governed artifact', () => {
		expect( VaultLayout.isArchivalPath( LEDGER ) ).toBe( false )
		expect( VaultLayout.classify( LEDGER ) ).toBe( 'unknown' )
	} )
} )

/**
 * THE THING THAT ACTUALLY FAILED, fenced. `audit-doc-truth.json` disappeared with no test under it,
 * which is why nobody knew until a run came back with no history.
 *
 * `VaultDeploy.apply` is the live deploy-and-repair path and it FILLS: `force: false`, an existing file
 * is never overwritten, and there is no `rmSync`, `unlinkSync` or `rm` anywhere in it. So this passes
 * today without any change to that file, and that is the honest statement of it — the test is a FENCE
 * against a future reset path, not the proof of a repair. It is worth its six seconds because the whole
 * failure mode here is a cleanup that nobody wrote a test for.
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

		// And a genuine scratch file beside it, so the case can tell "nothing was deleted" apart from
		// "the ledger specifically was spared" — today both survive, and if a sweep ever lands only the
		// first assertion below may change.
		writeFileSync( path.join( root, DOC_ROOT, 'audits', 'stale-backup.html' ), '<p>scratch</p>', 'utf-8' )

		VaultDeploy.apply( root, { docRoot: DOC_ROOT } )
	} )

	afterAll( () => {
		if( root ) rmSync( root, { recursive: true, force: true } )
	} )

	it( 'leaves the ledger on disk', () => {
		expect( existsSync( path.join( root, DOC_ROOT, LEDGER ) ) ).toBe( true )
	} )

	/** BYTE-IDENTICAL, not merely present. A deploy that re-created the file empty would satisfy an
	 *  existence check and still have destroyed every row of coverage the ledger carried — which is
	 *  exactly the shape of the 2026-09-22 loss as it was experienced: a run that came back with no
	 *  history. */
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
