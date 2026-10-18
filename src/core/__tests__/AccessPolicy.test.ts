import { describe, it, expect } from 'vitest'
import {
	parseAccessEntry,
	parseAccessList,
	serializeAccessEntry,
	originOf,
	higherLevel,
	levelMeets,
	operationsFor,
	verbFor,
	ACCESS_ORIGINS,
	AUTHORED_DEFAULT_LEVEL,
	DEFAULT_ORIGIN
} from '../AccessPolicy'
import { ACCESS_LEVELS, type AccessLevel } from '../../session/InjectedItem'
import type { AccessEntry } from '../AccessPolicy'

/**
 * AccessPolicy — the one fold, and THE MIGRATION TABLE. A wrong row fails silently: one rung low refuses
 * work a person configured, one rung high hands out reach nobody granted.
 *
 * Pure. No disk, no config, no processes.
 */

describe( 'the migration table — legacy pair to ladder', () => {

	const CASES: { raw: Record<string, unknown>; level: AccessLevel; why: string }[] = [
		{ raw: { path: 'p' },                                  level: 'read',   why: 'a missing enabled flag reads as ON, as every replaced parse did' },
		{ raw: { path: 'p', enabled: true },                   level: 'read',   why: 'enabled without write is exactly read' },
		{ raw: { path: 'p', enabled: true,  write: true },     level: 'delete', why: 'write:true already permitted DELETE — delete rode the write surface' },
		{ raw: { path: 'p', write: true },                     level: 'delete', why: 'the same, with enabled defaulted on' },
		{ raw: { path: 'p', enabled: false },                  level: 'none',   why: 'disabled reaches nothing' },
		{ raw: { path: 'p', enabled: false, write: true },     level: 'none',   why: 'the pair\'s meaningless state collapses to off, which is what it behaved as' },
		{ raw: { path: 'p', enabled: 0 },                      level: 'read',   why: 'only exactly false is off' },
		{ raw: { path: 'p', enabled: true,  write: 'true' },   level: 'read',   why: 'only exactly true is a write' },
		{ raw: { path: 'p', enabled: true,  write: 1 },        level: 'read',   why: 'the same, for a truthy non-boolean' }
	]

	for( const c of CASES ) {
		it( `${ JSON.stringify( c.raw ) } → ${ c.level } — ${ c.why }`, () => {
			expect( parseAccessEntry( c.raw ) ).toEqual( { path: 'p', level: c.level } )
		} )
	}

	it( 'maps write:true to DELETE and not to write — the correction that preserves meaning', () => {
		// Mapping to `write` would silently revoke deletes a person already had.
		expect( parseAccessEntry( { path: 'p', enabled: true, write: true } )?.level ).toBe( 'delete' )
	} )
} )

describe( 'the new shape', () => {

	it( 'takes an explicit level over any legacy flags beside it', () => {
		expect( parseAccessEntry( { path: 'p', level: 'read', enabled: false, write: true } ) ).toEqual( { path: 'p', level: 'read' } )
	} )

	it( 'accepts every rung on the ladder', () => {
		for( const level of ACCESS_LEVELS ) {
			expect( parseAccessEntry( { path: 'p', level } ) ).toEqual( { path: 'p', level } )
		}
	} )

	it( 'treats an unrecognised level as malformed rather than clamping it', () => {
		// A policy we cannot read is not a policy we may assume is permissive — and clamping would silently
		// turn a typo into a working entry at some other depth.
		expect( parseAccessEntry( { path: 'p', level: 'admin' } ) ).toBeNull()
		expect( parseAccessEntry( { path: 'p', level: 3 } ) ).toBeNull()
	} )

	it( 'round-trips through the serializer', () => {
		for( const level of ACCESS_LEVELS ) {
			expect( parseAccessEntry( serializeAccessEntry( { path: 'p', level } ) ) ).toEqual( { path: 'p', level, origin: 'authored' } )
		}
	} )

	it( 'writes only the new shape, so an edited slice converges', () => {
		expect( serializeAccessEntry( { path: 'p', level: 'read' } ) ).toEqual( { path: 'p', level: 'read', origin: 'authored' } )
	} )
} )

/**
 * THE ORIGIN MARKER — a label, and provably only a label. Origin must never decide which entry wins: that
 * would reintroduce most-specific resolution into a model whose value is highest-wins.
 */
describe( 'the origin marker', () => {

	it( 'carries a stated marker through, on either state', () => {
		for( const origin of ACCESS_ORIGINS ) {
			expect( parseAccessEntry( { path: 'p', level: 'read', origin } ) ).toEqual( { path: 'p', level: 'read', origin } )
		}
	} )

	it( 'reads an entry with NO marker as AUTHORED — the back-compatible direction', () => {
		// Every row stored before this field existed was in fact authored by a person. Reading those as shipped
		// would relabel someone's own configuration as something the product put there.
		expect( DEFAULT_ORIGIN ).toBe( 'authored' )
		expect( originOf( parseAccessEntry( { path: 'p', level: 'read' } )! ) ).toBe( 'authored' )
		expect( originOf( parseAccessEntry( { path: 'p' } )! ) ).toBe( 'authored' )
		expect( originOf( parseAccessEntry( { path: 'p', enabled: true, write: true } )! ) ).toBe( 'authored' )
		const handBuilt: AccessEntry = { path: 'p', level: 'read' }
		expect( originOf( handBuilt ) ).toBe( 'authored' )
	} )

	it( 'leaves an absent marker absent rather than inventing a stored fact', () => {
		// The parse stamps no default, so a silence is never mistaken for a person's explicit answer.
		expect( parseAccessEntry( { path: 'p', level: 'read' } ) ).toEqual( { path: 'p', level: 'read' } )
	} )

	it( 'drops the WHOLE entry on a malformed marker, rather than defaulting it', () => {
		// Same ruling as an unrecognised level: a policy we cannot read is not one we may assume. Here the stake
		// is a surface confidently mislabelling who configured something, which is worse than one row short.
		for( const origin of [ 'vendor', 'SHIPPED', '', 3, true, null, {} ] ) {
			expect( parseAccessEntry( { path: 'p', level: 'read', origin } ) ).toBeNull()
		}
	} )

	it( 'condemns the entry on the LEGACY route too, not only the new shape', () => {
		expect( parseAccessEntry( { path: 'p', write: true, origin: 'vendor' } ) ).toBeNull()
		expect( parseAccessEntry( { path: 'p', enabled: false, origin: 'vendor' } ) ).toBeNull()
	} )

	it( 'drops only the bad row out of a list', () => {
		expect( parseAccessList( [ { path: 'a', level: 'read', origin: 'shipped' }, { path: 'b', level: 'read', origin: 'nope' }, { path: 'c', level: 'read' } ] ) ).toEqual( [
			{ path: 'a', level: 'read', origin: 'shipped' },
			{ path: 'c', level: 'read' }
		] )
	} )

	it( 'round-trips both states through the serializer', () => {
		for( const origin of ACCESS_ORIGINS ) {
			expect( parseAccessEntry( serializeAccessEntry( { path: 'p', level: 'write', origin } ) ) ).toEqual( { path: 'p', level: 'write', origin } )
		}
	} )

	it( 'is WRITTEN even when it is the default — a writer states its answer', () => {
		// A reader tolerates silence; a writer does not keep one. A stored row saying `authored` is one a person
		// reading the slice can tell from a row written before the field existed.
		expect( serializeAccessEntry( { path: 'p', level: 'read' } )[ 'origin' ] ).toBe( 'authored' )
	} )

	it( 'NEVER ENTERS RESOLUTION — two entries differing only in origin resolve identically', () => {
		// The constraint this field is most likely to be broken by a later clever reader. `SdkFileAccess`
		// carries the same assertion over the path resolver, which is the other half of this.
		for( const a of ACCESS_LEVELS ) {
			for( const b of ACCESS_LEVELS ) {
				const shipped:  AccessEntry = { path: 'p', level: a, origin: 'shipped' }
				const authored: AccessEntry = { path: 'p', level: a, origin: 'authored' }
				const bare:     AccessEntry = { path: 'p', level: a }
				for( const entry of [ shipped, authored, bare ] ) {
					expect( higherLevel( entry.level, b ) ).toBe( higherLevel( a, b ) )
					expect( higherLevel( b, entry.level ) ).toBe( higherLevel( b, a ) )
					expect( levelMeets( entry.level, b ) ).toBe( levelMeets( a, b ) )
				}
			}
		}
	} )

	it( 'has exactly two states — a third would be a resolution rule wearing a label\'s clothes', () => {
		expect( [ ...ACCESS_ORIGINS ] ).toEqual( [ 'shipped', 'authored' ] )
	} )
} )

describe( 'malformed input', () => {

	it( 'drops an entry with no usable path', () => {
		for( const raw of [ null, undefined, 42, 'p', [], {}, { path: '' }, { path: 5 } ] ) {
			expect( parseAccessEntry( raw ) ).toBeNull()
		}
	} )

	it( 'reads a list past the entries it had to drop', () => {
		expect( parseAccessList( [ null, { path: '' }, { path: 'a' }, 7, { path: 'b', write: true } ] ) ).toEqual( [
			{ path: 'a', level: 'read' },
			{ path: 'b', level: 'delete' }
		] )
	} )

	it( 'treats a non-array as an EMPTY policy, which denies', () => {
		for( const raw of [ null, undefined, {}, 'nope', 3 ] ) {
			expect( parseAccessList( raw ) ).toEqual( [] )
		}
	} )
} )

describe( 'the ladder primitives', () => {

	it( 'higherLevel is the floor-plus rule, in both argument orders', () => {
		expect( higherLevel( 'read', 'write' ) ).toBe( 'write' )
		expect( higherLevel( 'write', 'read' ) ).toBe( 'write' )
		expect( higherLevel( 'none', 'none' ) ).toBe( 'none' )
		expect( higherLevel( 'delete', 'read' ) ).toBe( 'delete' )
	} )

	it( 'levelMeets is satisfied by the rung itself and by anything deeper, never shallower', () => {
		expect( levelMeets( 'write', 'read' ) ).toBe( true )
		expect( levelMeets( 'write', 'write' ) ).toBe( true )
		expect( levelMeets( 'write', 'delete' ) ).toBe( false )
		expect( levelMeets( 'none', 'read' ) ).toBe( false )
		expect( levelMeets( 'delete', 'delete' ) ).toBe( true )
	} )

	it( 'holds the ordering across every pair on the ladder', () => {
		ACCESS_LEVELS.forEach( ( held, h ) => {
			ACCESS_LEVELS.forEach( ( required, r ) => {
				expect( levelMeets( held, required ) ).toBe( h >= r )
			} )
		} )
	} )

	it( 'none satisfies only none — which is why every guard requires at least read', () => {
		expect( levelMeets( 'none', 'none' ) ).toBe( true )
		for( const required of ACCESS_LEVELS.filter( ( l ) => l !== 'none' ) ) {
			expect( levelMeets( 'none', required ) ).toBe( false )
		}
	} )
} )

describe( 'the authored default', () => {

	it( 'is the TOP of the ladder — a working directory the agent can work in', () => {
		expect( AUTHORED_DEFAULT_LEVEL ).toBe( ACCESS_LEVELS[ ACCESS_LEVELS.length - 1 ] )
	} )

	it( 'is never consulted by the migration, which preserves meaning instead', () => {
		expect( parseAccessEntry( { path: 'p' } )?.level ).not.toBe( AUTHORED_DEFAULT_LEVEL )
	} )
} )

describe( 'the agent-facing vocabulary', () => {

	// What reaches a model about its own permissions IS prompt text, so the wording is the feature.

	it( 'is CUMULATIVE, because the ladder is', () => {
		expect( operationsFor( 'read' ) ).toBe( 'list, read, search' )
		expect( operationsFor( 'write' ) ).toBe( 'list, read, search, write' )
		expect( operationsFor( 'delete' ) ).toBe( 'list, read, search, write, remove' )
	} )

	it( 'never says the word DELETE to an agent — the whole reason it is a lookup', () => {
		// A level named for destruction, reported to a model as a permission it holds, is an invitation
		// nobody wrote on purpose. `remove` is the operation; `delete` is the tier a PERSON picks.
		expect( operationsFor( 'delete' ) ).not.toContain( 'delete' )
		expect( verbFor( 'delete' ) ).toBe( 'remove' )
	} )

	it( 'answers HONESTLY at none, rather than falling through to the shallowest rung', () => {
		// The version this was hoisted from had no `none` case and returned the read list for it. Safe only
		// because its one caller pre-filtered; every new caller would have inherited the trap.
		expect( operationsFor( 'none' ) ).toBe( 'nothing' )
		expect( verbFor( 'none' ) ).toBe( 'reach' )
	} )

	it( 'has an answer for EVERY rung — no level can reach a caller unworded', () => {
		for( const level of ACCESS_LEVELS ) {
			expect( operationsFor( level ).length ).toBeGreaterThan( 0 )
			expect( verbFor( level ).length ).toBeGreaterThan( 0 )
		}
	} )
} )
