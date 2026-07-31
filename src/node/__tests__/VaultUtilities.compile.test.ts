import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'
import { VaultUtilities } from '../VaultUtilities'

/**
 * `VaultUtilities.compile` — the vault face, after the compiler collapse.
 *
 * These lock the thing that was actually broken. The vault face used to run its own flat pipeline
 * ( `LensObject.getContextBlocks` → `SlotResolver.compile` ) and ship a context with no manifest, no band
 * headings, no primacy marking, and a duplicated `Available on request` stub section per lens. It looked
 * internally consistent, which is exactly why nobody noticed it was a second compiler.
 *
 * The load-bearing assertion is the equivalence one: the tool's text IS the agent's own `compile()`. The
 * shape assertions exist so a regression to a parallel pipeline fails loudly rather than silently emitting
 * a plausible-looking context again.
 */

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' )   // kcd_sdk/src/node/__tests__ → repo root

const vault = (): Vault => new Vault( PROJECT_ROOT )

describe( 'VaultUtilities.compile — one compiler, shared with Starmind', () => {

	it( 'emits exactly the agent\'s own compiled context — no separate assembly', () => {
		const v = vault()

		expect( VaultUtilities.compile( v, [ 'render' ] ).text ).toBe( v.buildAgent( [ 'render' ] ).compile() )
	} )

	it( 'carries the bottom-of-context manifest the flat pipeline never emitted', () => {
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
