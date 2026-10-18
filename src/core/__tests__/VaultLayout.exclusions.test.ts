import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { Vault } from '../../node/Vault'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * Ephemeral is the only exclusion from a grading sweep. The archival exclusion is gone, so this file guards
 * the opposite mistake: that removing it did not take `plans/` out of the graded library, nor leave a second
 * exclusion behind under another name.
 */
describe( 'VaultLayout — ephemeral is the only exclusion', () => {

	/** A path under a retired archival bucket, which a stale export could still put back. */
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

	/** Removing the exemption grades documents under the old archival buckets; both are empty today. */
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
