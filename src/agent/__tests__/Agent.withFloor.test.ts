import { describe, it, expect } from 'vitest'
import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'

/**
 * `Agent.withFloor` — THE base-floor policy, now shared by both compiler faces.
 *
 * Node-free by construction ( it takes an already-loaded base rather than reaching for disk ), so the whole
 * rule is testable without a vault. That is the point of putting it here: the rule that the two faces used
 * to spell separately — and silently stopped agreeing on — is now one function with its own tests.
 */

function lens( name: string, path: string ): LensObject {
	return LensObject.fromSerialized( {
		path,
		type:        'lens',
		frontmatter: { type: 'lens', name },
		sections:    { Know: '', Care: '', Do: '' },
		body:        '',
		links:       [],
		policy:      [],
	} )
}

const base    = (): LensObject => lens( '_lens-base', '/vault/_Claude/lenses/_lens-base.html' )
const render  = (): LensObject => lens( 'render', '/vault/_Claude/lenses/render/render.html' )
const mcp     = (): LensObject => lens( 'mcp', '/vault/_Claude/lenses/mcp/mcp.html' )

describe( 'Agent.withFloor — the shared base-floor policy', () => {

	it( 'appends the floor LAST, so an authored lens outranks it in a contended slot', () => {
		const out = Agent.withFloor( [ render(), mcp() ], base() )

		expect( out.map( l => l.getName() ) ).toEqual( [ 'render', 'mcp', '_lens-base' ] )
	} )

	it( 'applies once — a stack already carrying a floor is returned untouched', () => {
		const already = [ render(), base() ]
		const out     = Agent.withFloor( already, base() )

		expect( out ).toBe( already )                                   // same array, not a rebuilt copy
		expect( out.filter( l => l.getName() === '_lens-base' ) ).toHaveLength( 1 )
	} )

	it( 'tolerates a missing floor rather than failing the compile', () => {
		const stack = [ render() ]
		const out   = Agent.withFloor( stack, null )

		expect( out ).toBe( stack )
	} )

	it( 'floors a LENSLESS stack — the case that caused the divergence', () => {
		// A draft agent has no authored lens, but still stands on the floor. The Starmind copy of this rule
		// used to bail here ( `isDraft()` read the whole lens count ), so a fresh draft compiled with no
		// project stance and none of the universal habits.
		const out = Agent.withFloor( [], base() )

		expect( out.map( l => l.getName() ) ).toEqual( [ '_lens-base' ] )
	} )

	it( 'does not mutate the caller\'s array', () => {
		const stack = [ render() ]
		Agent.withFloor( stack, base() )

		expect( stack ).toHaveLength( 1 )
	} )

	it( 'leaves a floored draft still reading as a draft — inherited is not composed', () => {
		// The invariant the original bug violated in the other direction: gaining the floor must not make a
		// draft look deployed. `isDraft()`/`primaryLens` read the AUTHORED stack, so the floor is invisible
		// to both.
		const agent = Agent.create( { lenses: Agent.withFloor( [], base() ) } )

		expect( agent.isDraft() ).toBe( true )
		expect( agent.primaryLens ).toBeNull()
		expect( agent.domainLenses ).toHaveLength( 0 )
		expect( agent.lenses ).toHaveLength( 1 )
		expect( agent.name ).toBe( 'agent' )        // named from the authored lens, never the floor
	} )
} )
