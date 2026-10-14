import { describe, it, expect } from 'vitest'
import { Agent, type SerializedAgent } from '../Agent'

/**
 * The roleGroups field on an agent record ( TASK-271 ) — ids only, the agent's own, never inherited. No
 * projection happens yet ( the next step ); this file proves only the record shape: it holds, it defaults,
 * and it round-trips through both wire forms. Mirrors Agent.skills.test.ts, which this field is modelled on.
 */

describe( 'Agent.roleGroups', () => {

	it( 'a fresh agent holds none, and an explicit list is held as given', () => {
		const bare = Agent.create( { id: 'a1', name: 'One' } )
		expect( bare.roleGroups ).toEqual( [] )

		const stocked = Agent.create( { id: 'a2', name: 'Two', roleGroups: [ 'frontend', 'outreach' ] } )
		expect( stocked.roleGroups ).toEqual( [ 'frontend', 'outreach' ] )
	} )

	it( 'a record written before this field existed has no `roleGroups` key at all, and loads as an empty list', () => {
		const agent = Agent.create( { id: 'a3', name: 'Three', roleGroups: [ 'whatever' ] } )
		const wire  = agent.serializeForWire()
		// Simulate a pre-existing row: the key is genuinely ABSENT, not present-and-undefined.
		const legacy = { ...wire } as Partial<SerializedAgent>
		delete legacy.roleGroups
		expect( 'roleGroups' in legacy ).toBe( false )

		const reloaded = Agent.fromSerialized( legacy as SerializedAgent )
		expect( reloaded.roleGroups ).toEqual( [] )
	} )

	it( 'round-trips through both wire forms', () => {
		const agent = Agent.create( { id: 'a4', name: 'Four', roleGroups: [ 'frontend' ] } )
		expect( Agent.fromSerialized( agent.serializeForWire() ).roleGroups ).toEqual( [ 'frontend' ] )
		expect( Agent.fromSerialized( agent.serializeRecord() ).roleGroups ).toEqual( [ 'frontend' ] )
	} )

	it( 'an id naming no role group is held harmlessly — the record does not resolve it', () => {
		// This step makes no claim about role group definitions at all: the record is a dumb-string
		// inventory, exactly like `baseHabits` and `skills`, and an id that resolves to nothing in the
		// install-level set is an absence for the next card ( the projection ) to handle, not a fault here.
		const agent = Agent.create( { id: 'a5', name: 'Five', roleGroups: [ 'no-such-group' ] } )
		expect( agent.roleGroups ).toEqual( [ 'no-such-group' ] )
		expect( Agent.fromSerialized( agent.serializeForWire() ).roleGroups ).toEqual( [ 'no-such-group' ] )
	} )

	it( 'does not touch toolModes — the two are separate facts', () => {
		const agent = Agent.create( { id: 'a6', name: 'Six', roleGroups: [ 'frontend' ], toolModes: { 'sm_file.read': 'on' } } )
		expect( agent.toolModes ).toEqual( { 'sm_file.read': 'on' } )
	} )
} )
