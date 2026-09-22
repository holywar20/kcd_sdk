import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Vault } from '../Vault'

/**
 * No floor on the vault face either ( plan agents-own-behaviour, "Retire _lens-base" ). There used to be two —
 * `_lens-base` for a session and `_lane-base` for an unattended run — and `buildAgent` stacked one under every
 * compile. Both are gone: a vault that still holds either file compiles the named lenses and nothing else.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )

/** A vault on disk holding one real lens, plus a leftover file under each old floor name. */
function leftoverVault(): { root: string, clean: () => void } {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'no-floor-' ) )
	const src  = new Vault( PROJECT_ROOT )

	const lensRel = src.lensPath( 'render' )
	fs.mkdirSync( path.join( root, '_Claude', path.dirname( lensRel ) ), { recursive: true } )
	const render = fs.readFileSync( path.join( PROJECT_ROOT, '_Claude', lensRel ), 'utf8' )
	fs.writeFileSync( path.join( root, '_Claude', lensRel ), render )
	for( const floor of [ '_lens-base', '_lane-base' ] )
		fs.writeFileSync( path.join( root, '_Claude', 'lenses', `${ floor }.html` ), render.replace( /data-kcd-type="slug">render</, `data-kcd-type="slug">${ floor }<` ) )

	return { root, clean: () => fs.rmSync( root, { recursive: true, force: true } ) }
}

describe( 'Vault.buildAgent — no floor', () => {

	it( 'stacks nothing under the named lens, whatever old floor files the vault still holds', () => {
		const { root, clean } = leftoverVault()
		try {
			const built = new Vault( root ).buildAgent( [ 'render' ] )
			expect( built.lenses.map( l => l.getName() ) ).toEqual( [ 'render' ] )
		} finally { clean() }
	} )
} )
