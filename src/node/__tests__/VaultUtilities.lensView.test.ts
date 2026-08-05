import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { VaultUtilities } from '../VaultUtilities'

/**
 * `VaultUtilities.lensView` — the composition chart behind `daedalus show`.
 *
 * What this view is FOR: seeing what an object is built from, file by file, so the edit-then-inspect loop
 * works from the command line. So the assertions here are about composition, not about text: every file
 * carries a real cost, inheritance is visible, and the rows still reconcile against the compile.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )

const vault = (): Vault => new Vault( PROJECT_ROOT )
const view  = () => VaultUtilities.lensView( vault(), 'render' )

describe( 'VaultUtilities.lensView — the composition of a compiled object', () => {

	it( 'rows sum EXACTLY to the reported total', () => {
		const v = view()

		expect( v.slots.reduce( ( sum, s ) => sum + s.tokens, 0 ) ).toBe( v.tokens )
	} )

	it( 'reports the same total `compile` reports for the same lens', () => {
		expect( view().tokens ).toBe( VaultUtilities.compile( vault(), [ 'render' ] ).tokens )
	} )

	it( 'prices an `on` file by its real routing row, not zero', () => {
		// THE point of the composition view. An `on` file contributes a pointer rather than a body, and that
		// row is real text in the compiled output — so it has a cost. Pooling those weights into an aggregate
		// manifest row would make every `on` file read as free.
		const on = view().slots.filter( s => s.state === 'on' )

		expect( on.length ).toBeGreaterThan( 0 )
		for ( const s of on ) expect( s.tokens ).toBeGreaterThan( 0 )
	} )

	it( 'has no aggregate manifest row — routing costs belong to the files that cause them', () => {
		expect( view().slots.find( s => s.what === 'manifest' ) ).toBeUndefined()
	} )

	it( 'makes the inherited floor visible with a real weight', () => {
		// The floor contributes no body of its own — base is care prose plus routing tables — so its cost is
		// only legible once its share of the merged care band lands on its own row.
		const floor = view().slots.find( s => s.source === '_lens-base' && s.kind === 'lens' )

		expect( floor ).toBeDefined()
		expect( floor!.tokens ).toBeGreaterThan( 0 )
	} )

	it( 'lists the WHOLE declared inventory — one row per policy entry, plus the lens itself', () => {
		// No lens in this vault currently declares an `off` slot or an unfilled placeholder, so asserting such
		// a row EXISTS would only test the corpus. What matters is that nothing gets dropped: every policy
		// entry a lens declares reaches the chart, whatever its mode.
		const lens = vault().buildAgent( [ 'render' ] ).domainLenses[ 0 ]
		const own  = view().slots.filter( s => s.source === 'render' )

		expect( own.length ).toBe( lens.getPolicy().length + 1 )      // + the lens's own row
	} )

	it( 'prices a declined row at zero if the corpus has one', () => {
		for ( const s of view().slots.filter( s => s.state === 'off' || s.state === 'empty' ) )
			expect( s.tokens ).toBe( 0 )
	} )

	it( 'groups rows by kind, lenses first', () => {
		const kinds = view().slots.filter( s => s.what !== 'structure' ).map( s => s.kind )
		const firstOf = ( k: string ): number => kinds.indexOf( k )

		expect( kinds[ 0 ] ).toBe( 'lens' )
		// Each kind occupies one contiguous run — no interleaving.
		for ( const k of new Set( kinds ) )
			expect( kinds.lastIndexOf( k ) - firstOf( k ) + 1 ).toBe( kinds.filter( x => x === k ).length )
	} )

	it( 'reports the mutual-exclusion slot on the files that declare one', () => {
		// Habits are what use slots today. Two rows sharing a slot means only one reached the compile.
		const slotted = view().slots.filter( s => s.slot !== '' )

		expect( slotted.length ).toBeGreaterThan( 0 )
		for ( const s of slotted ) expect( s.kind ).toBe( 'habit' )
	} )

	it( 'names a source on every row', () => {
		for ( const s of view().slots ) expect( s.source.length ).toBeGreaterThan( 0 )
	} )

	it( 'carries a positive structure remainder, never a negative one', () => {
		// `structure` absorbs band headings, dividers, block joins and estimator rounding. Negative would mean
		// the file rows over-count the compile.
		const structure = view().slots.find( s => s.what === 'structure' )

		expect( structure ).toBeDefined()
		expect( structure!.tokens ).toBeGreaterThan( 0 )
	} )

	it( 'lists each file once, even when several lenses declare it', () => {
		const v     = VaultUtilities.lensView( vault(), 'render' )
		const files = v.slots.filter( s => s.what !== 'structure' ).map( s => `${ s.source }:${ s.what }` )

		expect( new Set( files ).size ).toBe( files.length )
	} )
} )
