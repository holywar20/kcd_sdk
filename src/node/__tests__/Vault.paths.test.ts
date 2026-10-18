import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { Vault } from '../Vault'

/**
 * Vault path math. An href inside a document is vault-root-relative (`_Claude/plans/x.html`); a tool
 * parameter is vault-relative (`plans/x.html`). Both must resolve to the same artifact, so a link copied
 * from a document works as a tool argument.
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

		// Both spellings name one file: the second is what every href in every document says.
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
		// The jail's real job, which the normalization must not weaken. `_Claude/../..` is still outside.
		expect( vault().isInside( '../../etc/passwd' ) ).toBe( false )
		expect( vault().isInside( '_Claude/../../../etc/passwd' ) ).toBe( false )
	} )
} )

describe( 'Vault.toVaultRel', () => {
	it( 'answers the SAME relative path for either spelling', () => {
		const v = vault()

		// Vault-relative is the canonical form, and forward-slash on every platform.
		expect( v.toVaultRel( '_Claude/plans/x.html' ) ).toBe( v.toVaultRel( 'plans/x.html' ) )
		expect( v.toVaultRel( 'plans/x.html' ) ).toBe( 'plans/x.html' )
	} )
} )
