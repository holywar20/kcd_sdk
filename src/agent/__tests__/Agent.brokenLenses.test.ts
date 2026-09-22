import { describe, it, expect } from 'vitest'
import { Agent, type BrokenLens } from '../Agent'

/** A lens the record names that did not load rides the wire with the agent, so every surface can say which. */

describe( 'Agent.brokenLenses', () => {

	it( 'crosses the wire both ways, and a fresh agent has none', () => {
		const broken: BrokenLens[] = [ { id: 'l2', name: 'tester', position: 1, reason: 'missing' } ]
		const agent = Agent.create( { id: 'a1', name: 'One' } )
		expect( agent.brokenLenses ).toEqual( [] )

		agent.brokenLenses = broken
		expect( Agent.fromSerialized( agent.serializeForWire() ).brokenLenses ).toEqual( broken )
		expect( Agent.fromSerialized( agent.serializeRecord() ).brokenLenses ).toEqual( broken )
	} )
} )
