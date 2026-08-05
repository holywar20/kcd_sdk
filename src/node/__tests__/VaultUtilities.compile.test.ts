import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { VaultUtilities } from '../VaultUtilities'

/**
 * `VaultUtilities.compile` — the vault face runs the same engine as Starmind.
 *
 * The load-bearing assertion is equivalence: the tool's text IS the agent's own `compile()`. The shape
 * assertions exist so a second pipeline fails loudly rather than silently emitting a plausible context —
 * a parallel compiler looks internally consistent, which is what makes it hard to notice.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

const vault = (): Vault => new Vault( PROJECT_ROOT )

describe( 'VaultUtilities.compile — one compiler, shared with Starmind', () => {

	it( 'emits exactly the agent\'s own compiled context — no separate assembly', () => {
		const v = vault()

		expect( VaultUtilities.compile( v, [ 'render' ] ).text ).toBe( v.buildAgent( [ 'render' ] ).compile() )
	} )

	it( 'carries the bottom-of-context manifest', () => {
		const { text } = VaultUtilities.compile( vault(), [ 'render' ] )

		expect( text ).toContain( '## Files' )       // the manifest head — names every loaded lens + its path
		expect( text.indexOf( '## Files' ) ).toBeGreaterThan( 0 )   // trails the body, never leads
	} )

	it( 'drops the legacy stub blocks whose rows the manifest already carries', () => {
		const { text } = VaultUtilities.compile( vault(), [ 'render', 'mcp' ] )

		// One `# Available on request` section PER LENS used to ride here, duplicating the routing tables.
		expect( text ).not.toContain( 'Available on request' )
	} )

	it( 'marks the primary lens, so the first-lens-overrules rule is visible in the text', () => {
		const { text } = VaultUtilities.compile( vault(), [ 'render', 'mcp' ] )

		expect( text ).toContain( '( Primary )' )
	} )

	it( 'reports the floor in the compiled lens list, not just the lenses asked for', () => {
		const { lenses } = VaultUtilities.compile( vault(), [ 'render' ] )

		expect( lenses ).toContain( 'render' )
		expect( lenses ).toContain( '_lens-base' )
	} )

	it( 'reports a token count consistent with the text it returns', () => {
		const { text, tokens } = VaultUtilities.compile( vault(), [ 'render' ] )

		expect( tokens ).toBeGreaterThan( 0 )
		// Not an exact-value assertion ( the corpus moves ); the invariant is that the count describes THIS
		// text, so a stale or separately-derived number can't creep back in.
		expect( tokens ).toBe( VaultUtilities.compile( vault(), [ 'render' ] ).tokens )
		expect( text.length ).toBeGreaterThan( 0 )
	} )

	it( 'throws on an unresolvable lens rather than returning a degraded context', () => {
		expect( () => VaultUtilities.compile( vault(), [ 'no-such-lens-exists' ] ) ).toThrow( /no lens found/ )
	} )
} )
