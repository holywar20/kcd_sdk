import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Vault } from '../Vault'
import { InstallManifest } from '../../core'

/**
 * The LANE floor — the inheritance base a compile rides when nobody is in the session.
 *
 * Two floors exist because one document cannot address both readers. `_lens-base` tells its reader to
 * state a path and wait for clearance, which is sound advice beside a person and an empty instruction to
 * an agent running overnight — and an instruction whose escalation route does not exist is one an agent
 * learns to discount whole, including the parts that did apply.
 *
 * What is asserted here is the SUBSTITUTION, not a suppression: exactly one floor, always, and the lane
 * gets a different one rather than none. The failure this suite exists to catch is a lane compile that
 * quietly rides the session floor — it would produce clean output, correct token counts, and an agent
 * holding a protocol addressed to somebody who is not there.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )

/** A vault on disk holding both floors and one authored lens, built from the real corpus so the fixture
 *  cannot pass on documents the parser would reject. */
function twoFloorVault(): { root: string, clean: () => void } {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'lane-' ) )
	const src  = new Vault( PROJECT_ROOT )
	const dst  = path.join( root, '_Claude', 'lenses' )
	fs.mkdirSync( dst, { recursive: true } )

	const base = fs.readFileSync( path.join( PROJECT_ROOT, '_Claude', InstallManifest.BASE_LENS ), 'utf8' )
	fs.writeFileSync( path.join( dst, '_lens-base.html' ), base )
	// The lane floor is the same document under a different name and identity — enough for a floor-choice
	// test, which is about WHICH file rides, not about what either one says.
	fs.writeFileSync( path.join( dst, '_lane-base.html' ), base.replace( /_lens-base/g, '_lane-base' ) )

	const lensRel = src.lensPath( 'render' )
	const lensAbs = path.join( PROJECT_ROOT, '_Claude', lensRel )
	fs.mkdirSync( path.join( root, '_Claude', path.dirname( lensRel ) ), { recursive: true } )
	fs.copyFileSync( lensAbs, path.join( root, '_Claude', lensRel ) )

	return { root, clean: () => fs.rmSync( root, { recursive: true, force: true } ) }
}

const floors = ( names: string[] ): string[] => names.filter( n => n.endsWith( '-base' ) )

describe( 'the lane floor', () => {

	it( 'rides instead of the session floor, never beside it', () => {
		const { root, clean } = twoFloorVault()
		try {
			const v = new Vault( root )

			const session = v.buildAgent( [ 'render' ] ).lenses.map( l => l.getName() )
			const lane    = v.buildAgent( [ 'render' ], { lane: true } ).lenses.map( l => l.getName() )

			expect( floors( session ) ).toEqual( [ '_lens-base' ] )
			expect( floors( lane ) ).toEqual( [ '_lane-base' ] )

			// The whole point: one floor each way. Two floors in one context is the contradiction the lane
			// exists to prevent, and it is what a naive `isBaseLens` ( matching only the session filename )
			// would produce — `withFloor` would fail to see the lane floor already in the stack.
			expect( floors( lane ) ).toHaveLength( 1 )
			expect( lane ).not.toContain( '_lens-base' )
		} finally { clean() }
	} )

	it( 'leaves the authored stack untouched — only the floor differs', () => {
		const { root, clean } = twoFloorVault()
		try {
			const v = new Vault( root )
			const authored = ( lane: boolean ) => v.buildAgent( [ 'render' ], { lane } )
				.lenses.map( l => l.getName() ).filter( n => !n.endsWith( '-base' ) )

			expect( authored( true ) ).toEqual( authored( false ) )
		} finally { clean() }
	} )

	it( 'THROWS when asked for and absent, rather than falling back to the session floor', () => {
		const { root, clean } = twoFloorVault()
		try {
			fs.rmSync( path.join( root, '_Claude', 'lenses', '_lane-base.html' ) )
			const v = new Vault( root )

			// A missing session floor is tolerated ( a person is there to notice ); a missing lane floor is
			// not, because both available fallbacks compile cleanly and look like a working run: the session
			// floor hands an unattended agent an escalation route that does not exist, and no floor hands it
			// no guardrails at all.
			expect( () => v.buildAgent( [ 'render' ], { lane: true } ) ).toThrow( /lane floor/ )
			expect( () => v.buildAgent( [ 'render' ] ) ).not.toThrow()
		} finally { clean() }
	} )

	it( 'is absent by default — asking for nothing still gets the session floor', () => {
		const { root, clean } = twoFloorVault()
		try {
			const v = new Vault( root )
			expect( floors( v.buildAgent( [ 'render' ], {} ).lenses.map( l => l.getName() ) ) ).toEqual( [ '_lens-base' ] )
			expect( floors( v.buildAgent( [ 'render' ], { lane: false } ).lenses.map( l => l.getName() ) ) ).toEqual( [ '_lens-base' ] )
		} finally { clean() }
	} )

	it( 'counts both floors as base lenses, so neither reads as an authored lens', () => {
		expect( InstallManifest.isBaseLens( 'lenses/_lens-base.html' ) ).toBe( true )
		expect( InstallManifest.isBaseLens( 'lenses/_lane-base.html' ) ).toBe( true )
		expect( InstallManifest.isBaseLens( 'C:\\v\\_Claude\\lenses\\_lane-base.html' ) ).toBe( true )
		expect( InstallManifest.isBaseLens( 'lenses/render/render.html' ) ).toBe( false )
		// A name that merely ends in the same characters is not a floor.
		expect( InstallManifest.isBaseLens( 'lenses/my_lane-base.html' ) ).toBe( false )
		expect( InstallManifest.isBaseLens( null ) ).toBe( false )
	} )

} )
