import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { Agent, InstallManifest } from '../../core'

/**
 * `Vault.buildAgent` — the vault face's dumb-agent factory.
 *
 * The load-bearing test is the EQUIVALENCE one: an agent built by the factory must compile to the same
 * bytes as one assembled by hand from the same lenses. That is the whole claim of the compiler collapse —
 * that the vault face runs the SAME engine rather than a parallel one — so it is asserted directly rather
 * than inferred from output shape. Everything else here guards a specific way the factory could lie about
 * what it built ( a model it will never run, a name taken from the floor, a floor appended first ).
 *
 * Reads the real project vault, like the ContextAssembly suite: the lens corpus IS the fixture, and a
 * synthetic one would prove the factory works on lenses that don't exist.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

const vault = (): Vault => new Vault( PROJECT_ROOT )

/** A lens that exists in this vault and is NOT the floor — the stand-in for "some authored lens". */
const LENS = 'render'
const SECOND = 'mcp'

describe( 'Vault.buildAgent — the dumb-agent factory', () => {

	it( 'compiles byte-for-byte identically to a hand-built Agent over the same lenses', () => {
		const v = vault()

		const built = v.buildAgent( [ LENS, SECOND ] )

		// The hand-built comparison: the same lens objects, in the same order, floor last — assembled
		// directly through Agent.create with no factory involved.
		const byHand = Agent.create( {
			lenses: [
				v.loadLens( v.lensPath( LENS ) ),
				v.loadLens( v.lensPath( SECOND ) ),
				v.loadLens( InstallManifest.BASE_LENS ),
			],
		} )

		expect( built.compile() ).toBe( byHand.compile() )
	} )

	it( 'carries the named lenses in order, with the floor appended LAST', () => {
		const built = vault().buildAgent( [ LENS, SECOND ] )
		const names = built.lenses.map( l => l.getName() )

		expect( names.slice( 0, 2 ) ).toEqual( [ LENS, SECOND ] )
		// Floor last, never first: a named lens must PRECEDE base for its own habit to win the class.
		expect( InstallManifest.isBaseLens( built.lenses[ built.lenses.length - 1 ].getPath() ) ).toBe( true )
		expect( built.lenses.filter( l => InstallManifest.isBaseLens( l.getPath() ) ) ).toHaveLength( 1 )
	} )

	it( 'does not double-append the floor when it was asked for by name', () => {
		const built = vault().buildAgent( [ LENS, InstallManifest.BASE_LENS ] )
		expect( built.lenses.filter( l => InstallManifest.isBaseLens( l.getPath() ) ) ).toHaveLength( 1 )
	} )

	it( 'is honest about what it is: no model, the reserved id, and a name off the authored lens', () => {
		const built = vault().buildAgent( [ LENS ] )

		// Null, not the default key — this agent compiles context and never dispatches, so naming a model
		// would be a lie a later reader acts on.
		expect( built.model ).toBeNull()
		expect( built.id ).toBe( Agent.VAULT_AGENT_ID )
		// The name comes from the authored lens, never the floor it also carries.
		expect( built.name ).toBe( LENS )
		expect( built.name ).not.toBe( '_lens-base' )
	} )

	it( 'binds no environment — a vault cannot source live tools or memory', () => {
		const built = vault().buildAgent( [ LENS ] )

		expect( built.toolDefs ).toHaveLength( 0 )
		expect( built.memory ).toBe( '' )
		expect( built.rootContext ).toBe( '' )
	} )

	it( 'counts as deployed, not a draft — it wears an authored lens', () => {
		const built = vault().buildAgent( [ LENS ] )

		expect( built.isDraft() ).toBe( false )
		expect( built.primaryLens?.getName() ).toBe( LENS )
		// domainLenses excludes the inherited floor; lenses includes it.
		expect( built.domainLenses ).toHaveLength( 1 )
		expect( built.lenses.length ).toBeGreaterThan( built.domainLenses.length )
	} )

	it( 'throws on an unresolvable lens name rather than compiling a degraded context', () => {
		expect( () => vault().buildAgent( [ 'no-such-lens-exists' ] ) ).toThrow( /no lens found/ )
	} )

	it( 'throws on an empty lens list', () => {
		expect( () => vault().buildAgent( [] ) ).toThrow( /at least one lens/ )
	} )
} )
