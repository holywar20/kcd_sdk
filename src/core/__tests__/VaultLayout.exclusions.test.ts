import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { Vault } from '../../node/Vault'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * EPHEMERAL IS THE ONLY WAY A DIRECTORY DROPS OUT OF A GRADING SWEEP, and this file is what says so.
 *
 * It replaces `VaultLayout.archival.test.ts`, whose whole subject no longer exists. There were TWO
 * exclusions: ephemeral ( never installed, so protocol §1.1 forbids linking into it ) and ARCHIVAL
 * ( shipped and linkable, but no longer held to the current standard ). That suite's load-bearing case
 * pinned them apart, because folding archival into ephemeral would have made every provenance link into
 * a retired plan an `ephemeral-link` error — a regression with no symptom until a validator started
 * rejecting documents that were correct the day before.
 *
 * Archival's only occupants were ever `plans/plans_complete` and `plans/plans_deferred`. Those buckets
 * existed because a plan WAS a document: completing or retiring one filed its file, and the folder was
 * the plan's status. A plan is a database record now, nothing files a document anywhere, and both folders
 * were emptied by hand ( Bryan, 2026-10-14 ) — so the flag, its three readers and that suite went with
 * them rather than staying as a mechanism with no occupant.
 *
 * What this file guards is the OPPOSITE mistake to the one it replaces: that the removal did not quietly
 * take `plans/` out of the graded library along with its buckets, and did not leave a second exclusion
 * behind under another name.
 */
describe( 'VaultLayout — ephemeral is the only exclusion', () => {

	/** The old archival bucket paths. Nothing is on disk at either any more; the question is how a path
	 *  THERE is judged, since a stale export or a hand-made folder could still put one back. */
	const WAS_ARCHIVAL = '_Claude/plans/plans_complete/some-retired-plan.html'

	it( 'carries no archival predicate at all — the mechanism is gone, not merely unoccupied', () => {
		const layout = VaultLayout as unknown as Record<string, unknown>
		expect( layout[ 'archivalDirs' ] ).toBeUndefined()
		expect( layout[ 'isArchivalPath' ] ).toBeUndefined()
	} )

	it( 'declares no row carrying the retired `archival` flag', () => {
		for ( const entry of VaultLayout.all() ) {
			expect( ( entry as unknown as Record<string, unknown> )[ 'archival' ] ).toBeUndefined()
		}
	} )

	/** `plans/` is NOT ephemeral, and that is the half most worth pinning: it is unscaffolded, which is a
	 *  different question, and conflating the two would make an exported plan illegal to link to. */
	it( 'keeps plans/ graded and linkable, though a deploy never creates it', () => {
		expect( VaultLayout.isEphemeralHref( '_Claude/plans/exported.html' ) ).toBe( false )
		expect( VaultLayout.ephemeralDirs() ).not.toContain( 'plans' )
		expect( VaultLayout.scaffoldDirs().map( e => e.dir ) ).not.toContain( 'plans' )
	} )

	/** Classification is what the export depends on, and it is independent of both other questions. */
	it( 'still classifies and accepts a plan document, wherever under plans/ it sits', () => {
		expect( VaultLayout.classify( '_Claude/plans/exported.html' ) ).toBe( 'plan' )
		expect( VaultLayout.classify( WAS_ARCHIVAL ) ).toBe( 'plan' )
		expect( VaultLayout.accepts( '_Claude/plans/exported.html', 'plan' ) ).toBe( true )
		expect( VaultLayout.accepts( '_Claude/plans/exported.html', 'lens' ) ).toBe( false )
	} )
} )

/**
 * The gate the whole-vault sweep actually calls. `VaultUtilities.health` and `Vault.referenceIssues`
 * both filter through `isLibraryPath`, so this one predicate is what decides the denominator.
 */
describe( 'Vault.isLibraryPath — what a whole-vault sweep grades', () => {

	const vault = new Vault( PROJECT_ROOT, '_Claude' )

	it( 'excludes ephemeral space, and nothing else', () => {
		expect( vault.isLibraryPath( 'audits/x.html' ) ).toBe( false )
		expect( vault.isLibraryPath( 'work/x.html' ) ).toBe( false )
	} )

	/** THE BEHAVIOUR CHANGE, stated as a test rather than left to a comment: a document under either old
	 *  bucket is now GRADED. Both are empty, so this costs nothing today — and it is the honest reading of
	 *  removing the exemption, rather than a surprise the next person has to discover from a drift report. */
	it( 'grades a document under the old archival buckets', () => {
		expect( vault.isLibraryPath( 'plans/plans_complete/x.html' ) ).toBe( true )
		expect( vault.isLibraryPath( 'plans/plans_deferred/x.html' ) ).toBe( true )
	} )

	it( 'still grades the live library', () => {
		expect( vault.isLibraryPath( 'plans/exported.html' ) ).toBe( true )
		expect( vault.isLibraryPath( 'references/domain/x.html' ) ).toBe( true )
		expect( vault.isLibraryPath( 'lenses/some-lens/some-lens.html' ) ).toBe( true )
	} )
} )
