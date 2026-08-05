import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'

/**
 * Vault path math — the ONE place two path currencies are reconciled.
 *
 * The vault speaks two by design, and neither is wrong. An href INSIDE a document is vault-ROOT-relative
 * ( `_Claude/plans/x.html` ) because a browser opening that file from the project root has to follow it.
 * A tool PARAMETER is vault-relative ( `plans/x.html` ) because it resolves against the root itself.
 *
 * The regression that earned this file: an agent read a link out of a document and passed it verbatim to
 * `kcd_get`. `toAbs` produced `…/_Claude/_Claude/lenses/…`, the path jail PASSED it ( a doubled path is
 * still inside the vault, so the one guard positioned to catch it could not see it ), and it died as a raw
 * ENOENT with an absolute path the caller never wrote. Copying a link into a tool call is the obvious
 * thing to do; it has to work.
 */

const PROJECT_ROOT = path.resolve( 'C:/repo' )

function vault(): Vault {
	return new Vault( PROJECT_ROOT, '_Claude' )
}

describe( 'Vault.toAbs', () => {
	it( 'resolves a vault-relative path against the root', () => {
		expect( vault().toAbs( 'plans/x.html' ) ).toBe( path.join( PROJECT_ROOT, '_Claude', 'plans', 'x.html' ) )
	} )

	it( 'treats a DOC-ROOT-PREFIXED path as the same artifact', () => {
		const v = vault()

		// THE regression. Both spellings name one file, because both spellings appear in the system: the
		// second is what every href in every document says.
		expect( v.toAbs( '_Claude/plans/x.html' ) ).toBe( v.toAbs( 'plans/x.html' ) )
	} )

	it( 'strips the prefix however it is spelled', () => {
		const v = vault()
		const want = v.toAbs( 'plans/x.html' )

		// Backslashes come from a Windows caller pasting a path; a leading `./` comes from a link written
		// relatively. Neither is a different question.
		expect( v.toAbs( '_Claude\\plans\\x.html' ) ).toBe( want )
		expect( v.toAbs( './_Claude/plans/x.html' ) ).toBe( want )
	} )

	it( 'leaves a path that merely STARTS with the same letters alone', () => {
		const v = vault()

		// The strip is on a whole SEGMENT, not a prefix match. `_Claudius/` is a directory name, not the
		// doc root wearing a suffix.
		expect( v.toAbs( '_Claudius/x.html' ) ).toBe( path.join( PROJECT_ROOT, '_Claude', '_Claudius', 'x.html' ) )
	} )

	it( 'normalizes an absolute path as-is', () => {
		const abs = path.join( PROJECT_ROOT, '_Claude', 'plans', 'x.html' )

		// Callers that already hold an absolute path keep working regardless of process cwd; `isInside`
		// stays the thing that rejects one pointing out of the vault.
		expect( vault().toAbs( abs ) ).toBe( abs )
	} )
} )

describe( 'Vault.isInside — the path jail', () => {
	it( 'admits both spellings of an in-vault path', () => {
		const v = vault()

		expect( v.isInside( 'plans/x.html' ) ).toBe( true )
		expect( v.isInside( '_Claude/plans/x.html' ) ).toBe( true )
	} )

	it( 'still refuses a traversal out of the vault', () => {
		// The jail's real job, and the thing the normalization must not weaken: `_Claude/../..` is still
		// outside, and reads through the same `toAbs` the strip now lives in.
		expect( vault().isInside( '../../etc/passwd' ) ).toBe( false )
		expect( vault().isInside( '_Claude/../../../etc/passwd' ) ).toBe( false )
	} )
} )

describe( 'Vault.toVaultRel', () => {
	it( 'answers the SAME relative path for either spelling', () => {
		const v = vault()

		// The return currency is vault-relative, so a caller handing in a doc-root-prefixed path gets back
		// the canonical form rather than its own spelling echoed.
		expect( v.toVaultRel( '_Claude/plans/x.html' ) ).toBe( v.toVaultRel( 'plans/x.html' ) )
		expect( v.toVaultRel( 'plans/x.html' ) ).toBe( path.join( 'plans', 'x.html' ) )
	} )
} )
