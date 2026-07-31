import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { VaultLayout } from '../VaultLayout'
import { KcdAddress } from '../html/KcdAddress'
import { Vault } from '../../node/Vault'
import type { ArtifactType } from '../../primitives/types'

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/core/__tests__ → repo root

/**
 * The seam between two closed sets that have no reason to agree unless something checks: the types a
 * document may DECLARE ( KcdAddress.TYPES ) and the types a directory will ACCEPT ( VaultLayout ).
 *
 * They drifted once already. `how-to` sat in the declarable set for months while the write path refused
 * it in the one folder named after it — legal to author, legal on disk, impossible to save. Nothing
 * caught it because no single file was wrong; only the pair was.
 *
 * HOMES is the fixture and the point. Every declarable type names the canonical path where it lives, so
 * adding a type to the vocabulary forces you to say where it goes — and a type with nowhere to land
 * fails here rather than failing an agent later.
 */
const HOMES: Record<string, string> = {
	lens:        '_Claude/lenses/some-lens/some-lens.html',
	plan:        '_Claude/plans/some-plan.html',
	reference:   '_Claude/references/domain/some-note.html',
	framework:   '_Claude/kcd_framework.html',
	template:    '_Claude/templates/_some_template.html',
	'nav-index': '_Claude/references/nav-index.html',
	habit:       '_Claude/habits/unslotted/some-habit.html',
	contract:    '_Claude/contracts/some-contract.html',
	generator:   '_Claude/generators/some-gen/some-gen.html',
	analyzer:    '_Claude/analyzers/some-an/some-an.html',
	audit:       '_Claude/audits/some-audit.html',
}

describe( 'VaultLayout.accepts — the declarable/acceptable seam', () => {

	it( 'every declarable type has a home that accepts it', () => {
		const homeless = KcdAddress.TYPES.filter(
			t => !HOMES[ t ] || !VaultLayout.accepts( HOMES[ t ], t as ArtifactType )
		)
		expect( homeless ).toEqual( [] )
	} )

	it( 'HOMES covers the vocabulary exactly — no stale entry, no missing one', () => {
		expect( Object.keys( HOMES ).sort() ).toEqual( [ ...KcdAddress.TYPES ].sort() )
	} )

	/** Every reference CATEGORY is a folder and none of them has a type of its own — that is the whole
	 *  point of retiring `note`/`how-to`. A category folder takes a plain `reference` and nothing else. */
	it( 'every reference category folder takes a plain reference', () => {
		for ( const cat of [ 'how-to', 'notes', 'domain', 'architecture', 'patterns', 'ops' ] )
			expect( VaultLayout.accepts( `_Claude/references/${ cat }/x.html`, 'reference' ) ).toBe( true )
	} )

	it( 'the retired types are gone from the vocabulary, not merely unused', () => {
		expect( KcdAddress.TYPES ).not.toContain( 'how-to' )
		expect( KcdAddress.TYPES ).not.toContain( 'note' )
	} )

	/** `utilities/` is the one row that still needs `accepts`: it implies `utility`, which is not a
	 *  document type, so without the column no document could land there at all. */
	it( 'a utilities directory takes the document that belongs in it', () => {
		expect( VaultLayout.accepts( '_Claude/utilities/registry.html', 'reference' ) ).toBe( true )
		expect( VaultLayout.accepts( '_Claude/utilities/registry.html', 'lens' ) ).toBe( false )
	} )

	it( 'still refuses a real category error', () => {
		expect( VaultLayout.accepts( '_Claude/references/domain/x.html', 'lens' ) ).toBe( false )
		expect( VaultLayout.accepts( '_Claude/lenses/x/x.html', 'reference' ) ).toBe( false )
		expect( VaultLayout.accepts( '_Claude/plans/x.html', 'habit' ) ).toBe( false )
	} )

	it( 'untyped space accepts anything — scratch that refused writes would be useless', () => {
		expect( VaultLayout.acceptedTypes( '_Claude/work/x.html' ) ).toEqual( [] )
		expect( VaultLayout.accepts( '_Claude/work/x.html', 'lens' ) ).toBe( true )
	} )

	it( 'the accepted set always contains what classify returns', () => {
		for ( const p of Object.values( HOMES ) ) {
			const implied = VaultLayout.classify( p )
			const allowed = VaultLayout.acceptedTypes( p )
			if ( allowed.length === 0 ) continue          // untyped space
			expect( allowed ).toContain( implied )
		}
	} )

	it( 'names the accepted set so a refusal can be acted on', () => {
		expect( VaultLayout.acceptedTypes( '_Claude/references/domain/x.html' ) ).toEqual( [ 'reference' ] )
	} )

	/**
	 * The one type whose home is a FILENAME rather than a folder. A nav-index is accepted anywhere under
	 * that name and nowhere else — the name is what makes it one, so accepting it under another name would
	 * mint a document no index will ever read as an index. Found by probing the real guard, not by unit
	 * test: the first version of this suite asserted the canonical filename and missed the case entirely.
	 */
	it( 'accepts a nav-index in any directory, under its own name', () => {
		expect( VaultLayout.accepts( `_Claude/references/${ VaultLayout.NAV_INDEX_FILE }`, 'nav-index' ) ).toBe( true )
		expect( VaultLayout.accepts( `_Claude/lenses/${ VaultLayout.NAV_INDEX_FILE }`, 'nav-index' ) ).toBe( true )
		expect( VaultLayout.accepts( `_Claude/plans/${ VaultLayout.NAV_INDEX_FILE }`, 'nav-index' ) ).toBe( true )
	} )

	it( 'refuses a nav-index under any other filename', () => {
		expect( VaultLayout.accepts( '_Claude/references/probe-nav.html', 'nav-index' ) ).toBe( false )
		expect( VaultLayout.accepts( '_Claude/plans/index.html', 'nav-index' ) ).toBe( false )
	} )
} )

/**
 * The facade passes both entry points through one path normalisation, and the guard calls it with the
 * vault-relative form a tool received. Absolute and vault-relative must land on the same answer — that
 * conversion is the only logic the passthrough adds, so it is the only place it can be wrong.
 */
describe( 'Vault.accepts — the currency the write guard actually calls', () => {

	const vault = new Vault( PROJECT_ROOT, '_Claude' )

	it( 'takes the vault-relative form a tool param carries', () => {
		expect( vault.accepts( 'references/how-to/some-guide.html', 'reference' ) ).toBe( true )
		expect( vault.accepts( 'references/how-to/some-guide.html', 'lens' ) ).toBe( false )
	} )

	it( 'agrees with itself on the absolute form of the same path', () => {
		const rel = 'references/how-to/some-guide.html'
		const abs = path.join( PROJECT_ROOT, '_Claude', rel )
		expect( vault.acceptedTypes( abs ) ).toEqual( vault.acceptedTypes( rel ) )
	} )

	it( 'reports the single accepted type for a references path', () => {
		expect( vault.acceptedTypes( 'references/domain/x.html' ) ).toEqual( [ 'reference' ] )
	} )
} )
