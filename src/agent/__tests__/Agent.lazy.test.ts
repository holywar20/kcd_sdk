import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'
import { PendingRead } from '../../primitives/framework/PendingRead'
import { loadLensFromDisk } from '../../node/io'
import type { ReaderFn } from '../../primitives/types'

/**
 * A lens that reads on access must compile EXACTLY as a lens loaded whole, once nothing is pending.
 *
 * The renderer's agent compiles itself, but it cannot read disk: its reader fetches, answers "not yet" for what
 * has not arrived, and fills in over a round or two. Main's agent reads disk and is complete at once. The two
 * are one compiler over one vault, so any difference in the text they produce is the renderer's preview lying
 * about what the model will receive.
 *
 * Run against the REAL vault rather than a fixture: the habits with their classes, the load and on slots, the
 * sentinel whys and the contracts are exactly what a hand-built fixture would simplify away. Both agents read
 * the same files in the same run, so the comparison holds whatever the vault says today.
 */

const ROOT  = resolve( __dirname, '../../../..' )
// TWO LIVE LENSES. `STACKED` was `render` until 2026-09-25, when the package realignment renamed every
// superseded lens to `retire-*` — and this suite did not fail, it SKIPPED, which is how it would have gone
// quiet indefinitely. If that matters more than the convenience of skipping, turn `skipIf` below into a
// hard failure; the guard is kept only because a consumer may vendor this SDK without the vault beside it.
const HOUSE   = join( ROOT, '_Claude', 'lenses', 'house', 'house.html' )
const STACKED = join( ROOT, '_Claude', 'lenses', 'starmind-studio', 'starmind-studio.html' )
const VAULT   = existsSync( STACKED ) && existsSync( HOUSE )

/** The renderer's cache, in miniature: it answers from what it has been handed, and records anything else as
 *  asked for and "not yet". `land` hands over everything asked for, as a round of fetches would. */
class LateReader {
	readonly read: ReaderFn
	readonly everRead = new Set<string>()
	private readonly have  = new Map<string, string>()
	private readonly asked = new Set<string>()

	constructor() {
		this.read = ( abs: string ): string => this.answer( abs )
	}

	land(): void {
		for( const path of this.asked ) this.have.set( path, readFileSync( path, 'utf-8' ) )
		this.asked.clear()
	}

	private answer( abs: string ): string {
		const text = this.have.get( abs )
		if( text === undefined ) {
			this.asked.add( abs )
			throw new PendingRead( abs )
		}
		this.everRead.add( abs )
		return text
	}
}

function eagerAgent(): Agent {
	const house  = loadLensFromDisk( HOUSE,  { projectRoot: ROOT, eager: true } )
	const render = loadLensFromDisk( STACKED, { projectRoot: ROOT, eager: true } )
	return Agent.create( { id: 'probe', name: 'probe', lenses: [ house, render ] } )
}

function lazyAgent( reader: LateReader ): Agent {
	const house  = LensObject.lazy( HOUSE,  { projectRoot: ROOT, eager: true, read: reader.read } )
	const render = LensObject.lazy( STACKED, { projectRoot: ROOT, eager: true, read: reader.read } )
	return Agent.create( { id: 'probe', name: 'probe', lenses: [ house, render ] } )
}

/** Compose, ask what is missing, hand it over, and go again until nothing is. Answers the rounds it took. */
function settle( agent: Agent, reader: LateReader ): number {
	let rounds = 0
	agent.compose()
	while( agent.pending().length ) {
		reader.land()
		agent.compose()
		rounds += 1
		if( rounds > 4 ) throw new Error( 'the lazy agent never settled' )
	}
	return rounds
}

describe.skipIf( !VAULT )( 'a lens that reads on access', () => {

	it( 'compiles byte-for-byte what the same lenses loaded whole compile, once nothing is pending', () => {
		const reader = new LateReader()
		const lazy   = lazyAgent( reader )

		settle( lazy, reader )

		expect( lazy.wireSystem() ).toBe( eagerAgent().wireSystem() )
	} )

	it( 'reads its own document first, then its children — two rounds, and names what it waits on meanwhile', () => {
		const reader = new LateReader()
		const lazy   = lazyAgent( reader )

		expect( lazy.pending().sort() ).toEqual( [ STACKED, HOUSE ].sort() )
		expect( settle( lazy, reader ) ).toBe( 2 )
		expect( lazy.pending() ).toEqual( [] )
	} )

	it( 'never reads a child whose routing row is its whole contribution', () => {
		const reader = new LateReader()
		settle( lazyAgent( reader ), reader )

		// What the eager dredge read that the lazy one did not: the non-habit `on` children with a real why.
		const skipped = eagerAgent().lenses.flatMap( ( l ) => l.getNodes() )
			.filter( ( n ) => !n.included && n.getType() !== 'habit' )
			.map( ( n ) => n.getPath() )
			.filter( ( p ) => !reader.everRead.has( p ) )

		expect( skipped.length ).toBeGreaterThan( 0 )
		for( const p of skipped ) expect( reader.everRead.has( p ) ).toBe( false )
	} )

	it( 'keeps every child on the graph — a stub still answers its path and type, just not its body', () => {
		const reader = new LateReader()
		const lazy   = lazyAgent( reader )
		settle( lazy, reader )

		const paths = ( a: Agent ): string[] => a.lenses.flatMap( ( l ) => l.getNodes().map( ( n ) => n.getPath() ) ).sort()
		expect( paths( lazy ) ).toEqual( paths( eagerAgent() ) )
	} )

	it( 'crosses as a RECORD carrying none of what its lenses say, and compiles the same once it is read', () => {
		const eager  = eagerAgent()
		const record = eager.serializeRecord()

		expect( JSON.stringify( record ).length ).toBeLessThan( JSON.stringify( eager.serializeForWire() ).length / 20 )
		for( const l of record.lenses ?? [] ) expect( [ l.body, Object.keys( l.sections ).length, l.nodes.length ] ).toEqual( [ '', 0, 0 ] )

		const back = Agent.fromSerialized( record )
		// PENDING, NOT EMPTY, before anybody hands it a reader — an empty lens would compile a quietly wrong agent.
		expect( back.pending().length ).toBeGreaterThan( 0 )

		const reader = new LateReader()
		for( const lens of back.lenses ) lens.setReader( reader.read )
		settle( back, reader )

		expect( back.wireSystem() ).toBe( eager.wireSystem() )
	} )

	it( 'reads again after it is invalidated, and settles at once from what the reader already holds', () => {
		const reader = new LateReader()
		const lazy   = lazyAgent( reader )
		settle( lazy, reader )

		for( const lens of lazy.lenses ) lens.invalidate()

		expect( lazy.pending() ).toEqual( [] )
		expect( lazy.wireSystem() ).toBe( eagerAgent().wireSystem() )
	} )
} )
