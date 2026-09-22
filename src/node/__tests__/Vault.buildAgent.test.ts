import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { Agent } from '../../core'

/**
 * `Vault.buildAgent` — the vault face's dumb-agent factory.
 *
 * The load-bearing test is the EQUIVALENCE one: an agent built by the factory must compile to the same
 * bytes as one assembled by hand from the same lenses. That is the whole claim of the compiler collapse —
 * that the vault face runs the SAME engine rather than a parallel one — so it is asserted directly rather
 * than inferred from output shape. Everything else here guards a specific way the factory could lie about
 * what it built ( a model it will never run, a lens it was not asked for ).
 *
 * Reads the real project vault, like the ContextAssembly suite: the lens corpus IS the fixture, and a
 * synthetic one would prove the factory works on lenses that don't exist.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

const vault = (): Vault => new Vault( PROJECT_ROOT )

/** Lenses that exist in this vault — the stand-ins for "some authored lens". */
const LENS = 'render'
const SECOND = 'mcp'

describe( 'Vault.buildAgent — the dumb-agent factory', () => {

	it( 'compiles byte-for-byte identically to a hand-built Agent over the same lenses', () => {
		const v = vault()

		const built = v.buildAgent( [ LENS, SECOND ] )

		// The hand-built comparison: the same lens objects, loaded the SAME WAY, in the same order —
		// assembled directly through Agent.create with no factory involved.
		//
		// EAGER here too, and it is not boilerplate ( ruled 2026-09-17 ). The LOADER is part of what the
		// factory does: `buildAgent` dredges eagerly because anything that compiles must ( see
		// `LensLoadOptions.eager` ), so a lazy hand-build compares eager against lazy and reports a loader
		// difference as an engine one — which is the opposite of what this test is for. It is also the wrong
		// comparison to want: a non-eager lens dredges nothing, so a `load`-mode slot contributes only its
		// routing row and loses the whole meaning the 2026-09-12 ruling gave it. The lazy form read clean
		// only while no lens in the corpus carried a `load` row; a js-style-guide `load` row is what
		// surfaced the asymmetry, as ~15KB of style guide present on one side and absent on the other.
		const byHand = Agent.create( {
			lenses: [
				v.loadLens( v.lensPath( LENS ),   { eager: true } ),
				v.loadLens( v.lensPath( SECOND ), { eager: true } ),
			],
		} )

		expect( built.compile() ).toBe( byHand.compile() )
	} )

	it( 'dredges EAGERLY — the loader is part of the factory, not a detail of the caller', () => {
		const built = vault().buildAgent( [ LENS, SECOND ] )

		// Said outright rather than left to the equivalence test above, which can only catch a lazy factory
		// while some lens in the corpus happens to carry a `load`-mode row. A non-eager load returns a lens
		// with NO children at all, so this is the difference in one assertion: the factory hands back dredged
		// lenses, which is what gives a `load` slot a body to ride and what keeps this face compiling the same
		// object Starmind does ( every Starmind load path passes eager — see `Agents`).
		for ( const lens of built.lenses ) expect( lens.getNodes().length ).toBeGreaterThan( 0 )
	} )

	it( 'carries the named lenses in order, and nothing else', () => {
		const built = vault().buildAgent( [ LENS, SECOND ] )

		expect( built.lenses.map( l => l.getName() ) ).toEqual( [ LENS, SECOND ] )
	} )

	it( 'is honest about what it is: no model, the reserved id, and a name off the authored lens', () => {
		const built = vault().buildAgent( [ LENS ] )

		// Null, not the default key — this agent compiles context and never dispatches, so naming a model
		// would be a lie a later reader acts on.
		expect( built.model ).toBeNull()
		expect( built.id ).toBe( Agent.VAULT_AGENT_ID )
		expect( built.name ).toBe( LENS )
	} )

	it( 'binds no environment — a vault cannot source live tools or injections', () => {
		const built = vault().buildAgent( [ LENS ] )

		expect( built.toolDefs ).toHaveLength( 0 )
		expect( built.contributions ).toHaveLength( 0 )
		expect( built.rootContext ).toBe( '' )
	} )

	it( 'counts as deployed, not a draft — it wears an authored lens', () => {
		const built = vault().buildAgent( [ LENS ] )

		expect( built.isDraft() ).toBe( false )
		expect( built.primaryLens?.getName() ).toBe( LENS )
	} )

	it( 'throws on an unresolvable lens name rather than compiling a degraded context', () => {
		expect( () => vault().buildAgent( [ 'no-such-lens-exists' ] ) ).toThrow( /no lens found/ )
	} )

	it( 'throws on an empty lens list', () => {
		expect( () => vault().buildAgent( [] ) ).toThrow( /at least one lens/ )
	} )
} )
