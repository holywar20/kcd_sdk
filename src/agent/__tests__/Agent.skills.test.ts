import { describe, it, expect } from 'vitest'
import { Agent, type SerializedAgent } from '../Agent'

/**
 * The skills field on an agent record ( TASK-317 ) — slugs only, the agent's own, never inherited. No
 * compile happens yet ( that is the next card ); this file proves only the record shape: it holds, it
 * defaults, and it round-trips through both wire forms.
 */

describe( 'Agent.skills', () => {

	it( 'a fresh agent holds none, and an explicit list is held as given', () => {
		const bare = Agent.create( { id: 'a1', name: 'One' } )
		expect( bare.skills ).toEqual( [] )

		const stocked = Agent.create( { id: 'a2', name: 'Two', skills: [ 'pdf-fill', 'commit-helper' ] } )
		expect( stocked.skills ).toEqual( [ 'pdf-fill', 'commit-helper' ] )
	} )

	it( 'a record written before this field existed has no `skills` key at all, and loads as an empty list', () => {
		const agent = Agent.create( { id: 'a3', name: 'Three', skills: [ 'whatever' ] } )
		const wire  = agent.serializeForWire()
		// Simulate a pre-existing row: the key is genuinely ABSENT, not present-and-undefined.
		const legacy = { ...wire } as Partial<SerializedAgent>
		delete legacy.skills
		expect( 'skills' in legacy ).toBe( false )

		const reloaded = Agent.fromSerialized( legacy as SerializedAgent )
		expect( reloaded.skills ).toEqual( [] )
	} )

	it( 'round-trips through both wire forms', () => {
		const agent = Agent.create( { id: 'a4', name: 'Four', skills: [ 'release-notes' ] } )
		expect( Agent.fromSerialized( agent.serializeForWire() ).skills ).toEqual( [ 'release-notes' ] )
		expect( Agent.fromSerialized( agent.serializeRecord() ).skills ).toEqual( [ 'release-notes' ] )
	} )

	it( 'a slug naming no skill in the library is held harmlessly — the record does not resolve it', () => {
		// This step makes no claim about library membership at all: the record is a dumb-string inventory,
		// exactly like `baseHabits`, and a slug that resolves to nothing in the library is an absence for
		// the NEXT card ( the compiler ) to handle, not a fault this one detects or repairs.
		const agent = Agent.create( { id: 'a5', name: 'Five', skills: [ 'no-such-skill' ] } )
		expect( agent.skills ).toEqual( [ 'no-such-skill' ] )
		expect( Agent.fromSerialized( agent.serializeForWire() ).skills ).toEqual( [ 'no-such-skill' ] )
	} )
} )
