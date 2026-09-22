import { describe, it, expect } from 'vitest'
import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'

/**
 * No base floor ( plan agents-own-behaviour, "Retire _lens-base" ). An agent wears exactly the lenses it was
 * given: nothing is appended under them, and a lens that happens to be called `_lens-base` is an ordinary lens.
 * What the floor used to carry is the shipped agents' system prompt now.
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

const render = (): LensObject => lens( 'render', '/vault/_Claude/lenses/render/render.html' )
const mcp    = (): LensObject => lens( 'mcp', '/vault/_Claude/lenses/mcp/mcp.html' )

describe( 'Agent — no base floor', () => {

	it( 'wears exactly the lenses it was given, in order', () => {
		const agent = Agent.create( { lenses: [ render(), mcp() ] } )

		expect( agent.lenses.map( l => l.getName() ) ).toEqual( [ 'render', 'mcp' ] )
		expect( agent.primaryLens?.getName() ).toBe( 'render' )
		expect( agent.name ).toBe( 'render' )
	} )

	it( 'treats a lens named like the old floor as an ordinary, primary lens', () => {
		const agent = Agent.create( { lenses: [ lens( '_lens-base', '/vault/_Claude/lenses/_lens-base.html' ) ] } )

		expect( agent.isDraft() ).toBe( false )
		expect( agent.primaryLens?.getName() ).toBe( '_lens-base' )
	} )

	it( 'is a draft with no lens, and compiles to nothing', () => {
		const agent = Agent.create( {} )

		expect( agent.isDraft() ).toBe( true )
		expect( agent.primaryLens ).toBeNull()
		expect( agent.name ).toBe( 'agent' )
		expect( agent.compile() ).toBe( '' )
	} )
} )
