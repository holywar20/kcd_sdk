import { describe, it, expect } from 'vitest'
import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'

/**
 * `Agent.summarize` — the roster form a list read answers. It must name what the agent stacks and carry
 * none of what the stack loaded, because a fleet of full wire forms is what a list read must never cost.
 */

function lens( name: string, path: string, body = '' ): LensObject {
	return LensObject.fromSerialized( {
		path,
		type:        'lens',
		frontmatter: { type: 'lens', name },
		sections:    { Know: '', Care: '', Do: '' },
		body,
		links:       [],
		policy:      [],
	} )
}

const base   = (): LensObject => lens( '_lens-base', '/vault/_Claude/lenses/_lens-base.html', 'B'.repeat( 5_000 ) )
const render = (): LensObject => lens( 'render', '/vault/_Claude/lenses/render/render.html', 'R'.repeat( 5_000 ) )
const mcp    = (): LensObject => lens( 'mcp', '/vault/_Claude/lenses/mcp/mcp.html' )

describe( 'Agent.summarize — the roster form', () => {

	it( 'names the identity, the project, the model and the authored stack in order', () => {
		const agent = Agent.create( { id: 'a1', projectId: 'p1', name: 'Render', model: 'test.lorem', lenses: [ render(), mcp() ] } )

		expect( agent.summarize() ).toEqual( {
			id:        'a1',
			projectId: 'p1',
			name:      'Render',
			model:     'test.lorem',
			lensPaths: [ '/vault/_Claude/lenses/render/render.html', '/vault/_Claude/lenses/mcp/mcp.html' ],
		} )
	} )

	it( 'leaves the auto-appended base lens out of the stack it names', () => {
		const agent = Agent.create( { id: 'a1', lenses: Agent.withFloor( [ render() ], base() ) } )

		expect( agent.summarize().lensPaths ).toEqual( [ '/vault/_Claude/lenses/render/render.html' ] )
	} )

	it( 'carries no lens content, however much the stack loaded', () => {
		const agent = Agent.create( { id: 'a1', lenses: Agent.withFloor( [ render() ], base() ) } )

		expect( JSON.stringify( agent.serializeForWire() ).length ).toBeGreaterThan( 10_000 )
		expect( JSON.stringify( agent.summarize() ).length ).toBeLessThan( 200 )
	} )

	it( 'keeps a null model null — a vault agent that never dispatches is not handed a default', () => {
		const agent = Agent.create( { id: 'a1', model: null } )

		expect( agent.summarize().model ).toBeNull()
		expect( agent.summarize().lensPaths ).toEqual( [] )
	} )
} )
