import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { Vault } from '../../node/Vault'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * ARCHIVAL vs EPHEMERAL — two exclusions that look alike and must never collapse into one.
 *
 * Both stop a directory being graded on a whole-vault sweep, which is why the temptation to merge them
 * is real. They differ on the axis that matters: an ephemeral directory is never installed into a user's
 * vault, so protocol §1.1 forbids linking into it; an archival one SHIPS, and live artifacts link to it
 * for provenance. Merging them would make 85 existing links illegal, 50 of those in the plans nav-index
 * whose entire job is linking to plans.
 *
 * That is the regression these tests exist to catch. Nothing else in the system would notice: the merge
 * compiles, the sweep still reports clean, and the damage surfaces as a validator suddenly rejecting
 * documents that were correct yesterday.
 */
describe( 'VaultLayout — archival space is graded-exempt but still shippable', () => {

	const ARCHIVAL = '_Claude/plans/plans_complete/some-retired-plan.html'

	it( 'declares the retired-plan bucket archival, and its parent not', () => {
		expect( VaultLayout.archivalDirs() ).toContain( 'plans/plans_complete' )
		expect( VaultLayout.archivalDirs() ).not.toContain( 'plans' )
	} )

	it( 'matches the declared directory itself and everything beneath it', () => {
		expect( VaultLayout.isArchivalPath( '_Claude/plans/plans_complete' ) ).toBe( true )
		expect( VaultLayout.isArchivalPath( ARCHIVAL ) ).toBe( true )
		expect( VaultLayout.isArchivalPath( '_Claude/plans/plans_complete/nested/deep.html' ) ).toBe( true )
	} )

	it( 'leaves the live plan surface graded — the nested row must not archive its parent', () => {
		expect( VaultLayout.isArchivalPath( '_Claude/plans/live-plan.html' ) ).toBe( false )
		expect( VaultLayout.isArchivalPath( '_Claude/plans/nav-index.html' ) ).toBe( false )
		expect( VaultLayout.isArchivalPath( '_Claude/plans/capability/capability-action.html' ) ).toBe( false )
	} )

	/** BOTH plan buckets are archival, and for opposite reasons: `plans_complete` outlived the standard,
	 *  `plans_deferred` has not met it yet. Ruled 2026-08-15, reversing the 2026-08-13 ruling that kept
	 *  deferred plans graded — a draft in churn is held to the standard when it is promoted OUT, which is
	 *  the moment before it authorizes anything. Both are declared, never derived from the folder names. */
	it( 'archives the deferred bucket too', () => {
		expect( VaultLayout.archivalDirs() ).toContain( 'plans/plans_deferred' )
		expect( VaultLayout.isArchivalPath( '_Claude/plans/plans_deferred/x.html' ) ).toBe( true )
	} )

	/** Segment-boundary matching, never bare `startsWith` — a sibling whose name merely begins with a
	 *  declared prefix is a different directory and must stay graded. */
	it( 'does not swallow a sibling with a prefix-colliding name', () => {
		expect( VaultLayout.isArchivalPath( '_Claude/plans/plans_completed-notes/x.html' ) ).toBe( false )
		expect( VaultLayout.isArchivalPath( '_Claude/plans/plans_complete-archive.html' ) ).toBe( false )
	} )

	/** Same doc-root anchoring `isEphemeralHref` uses, so every form a caller might hold agrees. */
	it( 'answers alike for href, vault-relative, and absolute forms', () => {
		const abs = path.join( PROJECT_ROOT, '_Claude', 'plans', 'plans_complete', 'x.html' )
		expect( VaultLayout.isArchivalPath( ARCHIVAL ) ).toBe( true )
		expect( VaultLayout.isArchivalPath( 'plans/plans_complete/x.html' ) ).toBe( true )
		expect( VaultLayout.isArchivalPath( abs ) ).toBe( true )
	} )

	/**
	 * THE LOAD-BEARING ONE. If archival is ever folded into `indexed: false`, this flips and every
	 * provenance link into a retired plan becomes an `ephemeral-link` validation error.
	 */
	it( 'is NOT ephemeral — a link into a retired plan stays legal', () => {
		expect( VaultLayout.isEphemeralHref( ARCHIVAL ) ).toBe( false )
		expect( VaultLayout.ephemeralDirs() ).not.toContain( 'plans' )
	} )

	it( 'still classifies and accepts as a plan — archival changes grading, not identity', () => {
		expect( VaultLayout.classify( ARCHIVAL ) ).toBe( 'plan' )
		expect( VaultLayout.accepts( ARCHIVAL, 'plan' ) ).toBe( true )
		expect( VaultLayout.accepts( ARCHIVAL, 'lens' ) ).toBe( false )
	} )
} )

/**
 * The gate the whole-vault sweep actually calls. `VaultUtilities.health` and `Vault.referenceIssues`
 * both filter through `isLibraryPath`, so this one predicate is what keeps retired plans out of a
 * drift report — and what must keep letting an explicitly-named file through.
 */
describe( 'Vault.isLibraryPath — what a whole-vault sweep grades', () => {

	const vault = new Vault( PROJECT_ROOT, '_Claude' )

	it( 'excludes both exclusions', () => {
		expect( vault.isLibraryPath( 'plans/plans_complete/x.html' ) ).toBe( false )   // archival
		expect( vault.isLibraryPath( 'plans/plans_deferred/x.html' ) ).toBe( false )   // archival
		expect( vault.isLibraryPath( 'audits/x.html' ) ).toBe( false )                 // ephemeral
		expect( vault.isLibraryPath( 'work/x.html' ) ).toBe( false )                   // ephemeral
	} )

	it( 'still grades the live library', () => {
		expect( vault.isLibraryPath( 'plans/live-plan.html' ) ).toBe( true )
		expect( vault.isLibraryPath( 'references/domain/x.html' ) ).toBe( true )
		expect( vault.isLibraryPath( 'lenses/some-lens/some-lens.html' ) ).toBe( true )
	} )
} )
