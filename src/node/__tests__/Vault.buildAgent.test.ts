import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { Agent } from '../../core'

/**
 * `Vault.buildAgent`, the vault face's dumb-agent factory. The equivalence test is the load-bearing one: the factory
 * runs the same engine as a hand-built Agent, so it must compile the same bytes. Reads the real project vault.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

const vault = (): Vault => new Vault( PROJECT_ROOT )

/** Package lenses in this vault; superseded lenses get renamed away, so one-per-package is the stable roster. */
const LENS = 'starmind-studio'
const SECOND = 'starmind-mcp'

describe( 'Vault.buildAgent — the dumb-agent factory', () => {

	it( 'compiles byte-for-byte identically to a hand-built Agent over the same lenses', () => {
		const v = vault()

		const built = v.buildAgent( [ LENS, SECOND ] )

		// The hand-built comparison: the same lens objects, loaded the SAME WAY, in the same order —
		// assembled directly through Agent.create with no factory involved.
		//
		// EAGER here too: the loader is part of what the factory does. A lazy hand-build would compare eager against lazy,
		// and a non-eager lens dredges nothing, so a `load` slot would lose its body and the comparison would miss it.
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

		// Asserted outright: the equivalence test only catches a lazy factory while some lens carries a `load` row.
		// A non-eager load returns a lens with no children, so a `load` slot would have no body to ride.
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
	} )

	it( 'counts as deployed, not a draft — it wears an authored lens', () => {
		const built = vault().buildAgent( [ LENS ] )

		expect( built.isDraft() ).toBe( false )
		expect( built.firstLens?.getName() ).toBe( LENS )
	} )

	it( 'throws on an unresolvable lens name rather than compiling a degraded context', () => {
		expect( () => vault().buildAgent( [ 'no-such-lens-exists' ] ) ).toThrow( /no lens found/ )
	} )

	it( 'throws on an empty lens list', () => {
		expect( () => vault().buildAgent( [] ) ).toThrow( /at least one lens/ )
	} )
} )
