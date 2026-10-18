import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Vault } from '../Vault'

/**
 * A vault holding no floor file compiles only the named lenses: `buildAgent` stacks nothing under them, whatever
 * `_lens-base` or `_lane-base` files it still holds.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )

/** A vault on disk holding one real lens, plus a leftover file under each old floor name. */
function leftoverVault(): { root: string, clean: () => void } {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'no-floor-' ) )
	const src  = new Vault( PROJECT_ROOT )

	// A live package lens, copied out of the real vault: superseded lenses get renamed, so a package lens is the pin.
	const LENS    = 'starmind-studio'
	const lensRel = src.lensPath( LENS )
	fs.mkdirSync( path.join( root, '_Claude', path.dirname( lensRel ) ), { recursive: true } )
	const body = fs.readFileSync( path.join( PROJECT_ROOT, '_Claude', lensRel ), 'utf8' )
	fs.writeFileSync( path.join( root, '_Claude', lensRel ), body )
	for( const floor of [ '_lens-base', '_lane-base' ] )
		fs.writeFileSync( path.join( root, '_Claude', 'lenses', `${ floor }.html` ), body.replace( `data-kcd-type="slug">${ LENS }<`, `data-kcd-type="slug">${ floor }<` ) )

	return { root, clean: () => fs.rmSync( root, { recursive: true, force: true } ) }
}

describe( 'Vault.buildAgent — no floor', () => {

	it( 'stacks nothing under the named lens, whatever old floor files the vault still holds', () => {
		const { root, clean } = leftoverVault()
		try {
			const built = new Vault( root ).buildAgent( [ 'starmind-studio' ] )
			expect( built.lenses.map( l => l.getName() ) ).toEqual( [ 'starmind-studio' ] )
		} finally { clean() }
	} )
} )
