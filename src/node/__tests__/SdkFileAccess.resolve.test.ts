import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { SdkFileAccess } from '../SdkFileAccess'
import type { AccessEntry } from '../../core/AccessPolicy'
import type { GrantRef } from '../../session/InjectedItem'

/**
 * The RESOLVER — one question, asked by every guard in three processes.
 *
 * Split from the main SdkFileAccess suite because that one touches real disk by contract and this one must
 * not: resolution is pure path math over configuration, and it deliberately never stats. A test that
 * created files here would be asserting something the resolver does not do — and would hide the property
 * that makes a refusal safe, namely that it can disclose the RULE without disclosing whether a file exists.
 *
 * Paths hang off `tmpdir()` so they are absolute on both platforms without ever being created. A literal
 * will not do: `join( 'C:', 'x' )` is drive-RELATIVE, and a POSIX literal resolves against the current
 * drive on Windows — either way the comparison would not be the one the test reads like.
 */

const BASE   = join( tmpdir(), 'starmind-resolve' )
const ROOT   = join( BASE, 'proj' )
const INSIDE = join( ROOT, 'src', 'app.ts' )
const DEEP   = join( ROOT, 'src', 'nested', 'deep.ts' )
const NEAR   = join( BASE, 'project-x', 'a.ts' )   // shares ROOT's prefix, is NOT inside it
const OUT    = join( BASE, 'elsewhere', 'notes.md' )
const LOOSE  = join( BASE, 'loose' )
const FILE   = join( LOOSE, 'b.ts' )

function at( path: string, level: AccessEntry[ 'level' ] ): AccessEntry {
	return { path, level }
}

function fileGrant( subject: string, level: GrantRef[ 'level' ] = 'read' ): GrantRef {
	return { kind: 'file', subject, level }
}

describe( 'a single entry', () => {

	it( 'gives its level to the root itself and to what sits under it', () => {
		const entries = [ at( ROOT, 'write' ) ]
		expect( SdkFileAccess.resolveLevel( ROOT, entries ).level ).toBe( 'write' )
		expect( SdkFileAccess.resolveLevel( INSIDE, entries ).level ).toBe( 'write' )
		expect( SdkFileAccess.resolveLevel( DEEP, entries ).level ).toBe( 'write' )
	} )

	it( 'gives none to a path it does not contain', () => {
		expect( SdkFileAccess.resolveLevel( OUT, [ at( ROOT, 'delete' ) ] ).level ).toBe( 'none' )
	} )

	it( 'stops at the separator — a shared prefix is not containment', () => {
		expect( SdkFileAccess.resolveLevel( NEAR, [ at( ROOT, 'delete' ) ] ).level ).toBe( 'none' )
	} )

	it( 'collapses .. before comparing', () => {
		expect( SdkFileAccess.resolveLevel( join( ROOT, '..', 'elsewhere', 'x.md' ), [ at( ROOT, 'write' ) ] ).level ).toBe( 'none' )
	} )

	it( 'reports an entry at none as none rather than as containment', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'none' ) ] ).level ).toBe( 'none' )
	} )

	it( 'resolves to none against no configuration at all', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [] ) ).toEqual( { level: 'none', via: null, granted: 'none' } )
	} )
} )

describe( 'FLOOR PLUS — overlapping entries take the highest, never the nearest', () => {

	it( 'a deeper NESTED entry raises the tree around it', () => {
		const entries = [ at( ROOT, 'read' ), at( join( ROOT, 'src' ), 'delete' ) ]
		expect( SdkFileAccess.resolveLevel( INSIDE, entries ).level ).toBe( 'delete' )
	} )

	it( 'a shallower nested entry does NOT carve a pocket — most-specific was rejected outright', () => {
		// This is the rule in one assertion. Under most-specific-wins the answer here would be `read`; the
		// model is deliberately less expressive so that a person looking at two rows can predict the answer
		// without tracing anything.
		const entries = [ at( ROOT, 'delete' ), at( join( ROOT, 'src' ), 'read' ) ]
		expect( SdkFileAccess.resolveLevel( INSIDE, entries ).level ).toBe( 'delete' )
	} )

	it( 'an entry at none cannot close a tree another entry opened', () => {
		const entries = [ at( ROOT, 'write' ), at( join( ROOT, 'src' ), 'none' ) ]
		expect( SdkFileAccess.resolveLevel( INSIDE, entries ).level ).toBe( 'write' )
	} )

	it( 'does not depend on the order the entries are listed in', () => {
		const a = [ at( ROOT, 'read' ), at( join( ROOT, 'src' ), 'write' ) ]
		expect( SdkFileAccess.resolveLevel( INSIDE, a ).level ).toBe( SdkFileAccess.resolveLevel( INSIDE, [ ...a ].reverse() ).level )
	} )

	it( 'takes the highest across two UNRELATED entries that both contain the path', () => {
		const entries = [ at( BASE, 'read' ), at( ROOT, 'delete' ) ]
		expect( SdkFileAccess.resolveLevel( INSIDE, entries ).level ).toBe( 'delete' )
	} )
} )

describe( 'grants', () => {

	it( 'reach the depth they were authored at', () => {
		expect( SdkFileAccess.resolveLevel( FILE, [], [ fileGrant( FILE, 'read' ) ] ).level ).toBe( 'read' )
		expect( SdkFileAccess.resolveLevel( FILE, [], [ fileGrant( FILE, 'write' ) ] ).level ).toBe( 'write' )
	} )

	it( 'cover a folder subtree at the folder grant\'s own depth', () => {
		const grant: GrantRef = { kind: 'folder', subject: LOOSE, level: 'write' }
		expect( SdkFileAccess.resolveLevel( join( LOOSE, 'deep', 'x.md' ), [], [ grant ] ).level ).toBe( 'write' )
	} )

	it( 'take the DEEPEST of two grants covering one path', () => {
		const grants = [ fileGrant( FILE, 'read' ), fileGrant( FILE, 'write' ) ]
		expect( SdkFileAccess.resolveLevel( FILE, [], grants ).level ).toBe( 'write' )
		expect( SdkFileAccess.resolveLevel( FILE, [], [ ...grants ].reverse() ).level ).toBe( 'write' )
	} )

	it( 'a TOOL grant says nothing about a path, whatever its subject resolves to', () => {
		// Skipped by kind rather than left to its level. A qualified tool id is a string, and `jail` would
		// resolve it as a relative directory name — improbable is not a containment argument.
		const tool: GrantRef = { kind: 'tool', subject: 'starmind_file.read', level: 'delete' }
		expect( SdkFileAccess.resolveLevel( FILE, [], [ tool ] ).level ).toBe( 'none' )
		expect( SdkFileAccess.scope( [], [ tool ], 'read' ) ).toEqual( [] )
	} )

	it( 'cannot be stretched past the separator', () => {
		expect( SdkFileAccess.resolveLevel( `${ FILE }.bak`, [], [ fileGrant( FILE ) ] ).level ).toBe( 'none' )
	} )

	it( 'raise a path configuration left closed', () => {
		expect( SdkFileAccess.resolveLevel( OUT, [ at( ROOT, 'delete' ) ], [ fileGrant( OUT, 'write' ) ] ).level ).toBe( 'write' )
	} )

	it( 'never LOWER a path configuration already opened deeper', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'delete' ) ], [ fileGrant( INSIDE, 'read' ) ] ).level ).toBe( 'delete' )
	} )
} )

describe( 'granted — the explicit hand-over, reported apart from the verdict', () => {

	it( 'reports the depth grants alone give, with no configuration at all', () => {
		expect( SdkFileAccess.resolveLevel( FILE, [], [ fileGrant( FILE, 'write' ) ] ).granted ).toBe( 'write' )
	} )

	it( 'reports it EVEN WHEN configuration already covered the path deeper', () => {
		// The whole reason this field exists apart from `via`. Keyed off `via`, the same drop would relax the
		// write surface on a file outside the project and not on one inside it — invisibly, at the gesture.
		const verdict = SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'delete' ) ], [ fileGrant( INSIDE, 'write' ) ] )
		expect( verdict.level ).toBe( 'delete' )
		expect( verdict.via ).toBe( 'config' )
		expect( verdict.granted ).toBe( 'write' )
	} )

	it( 'is none when nothing was handed over, however open the configuration', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'delete' ) ] ).granted ).toBe( 'none' )
	} )

	it( 'ignores a grant that does not cover this path', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'read' ) ], [ fileGrant( OUT, 'write' ) ] ).granted ).toBe( 'none' )
	} )
} )

describe( 'via — the audit line, and when it names a grant', () => {

	it( 'names config when the configured floor is what permitted the path', () => {
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'read' ) ] ).via ).toBe( 'config' )
	} )

	it( 'names the GRANT when the grant is what lifted the verdict', () => {
		const grant = fileGrant( OUT )
		expect( SdkFileAccess.resolveLevel( OUT, [ at( ROOT, 'read' ) ], [ grant ] ).via ).toBe( grant )
	} )

	it( 'does NOT name a grant that only duplicates access already configured', () => {
		// An exception that changed nothing is not an exception. Reporting it would train people to ignore
		// the one line that says a capability was widened.
		expect( SdkFileAccess.resolveLevel( INSIDE, [ at( ROOT, 'read' ) ], [ fileGrant( INSIDE ) ] ).via ).toBe( 'config' )
	} )

	it( 'is null exactly when the answer is none', () => {
		expect( SdkFileAccess.resolveLevel( OUT, [ at( ROOT, 'read' ) ] ) ).toEqual( { level: 'none', via: null, granted: 'none' } )
	} )

	it( 'names the grant even with no configuration at all', () => {
		const grant = fileGrant( FILE )
		expect( SdkFileAccess.resolveLevel( FILE, [], [ grant ] ).via ).toBe( grant )
	} )
} )

describe( 'scope — the witness, filtered by the level the caller needs', () => {

	const entries = [ at( ROOT, 'delete' ), at( LOOSE, 'read' ), at( OUT, 'none' ) ]

	it( 'lists everything readable, and never an entry closed to none', () => {
		expect( SdkFileAccess.scope( entries, [], 'read' ).sort() ).toEqual( [ LOOSE, ROOT ].sort() )
	} )

	it( 'drops read-only roots when the caller needs to WRITE', () => {
		// A refusal for a write that pointed at read-only roots is the same fiction one rung down: the agent
		// retries there and is refused again, having been told where to go.
		expect( SdkFileAccess.scope( entries, [], 'write' ) ).toEqual( [ ROOT ] )
	} )

	it( 'includes grant subjects at read and excludes them deeper, matching what a grant reaches', () => {
		const grants = [ fileGrant( FILE ) ]
		expect( SdkFileAccess.scope( entries, grants, 'read' ) ).toContain( FILE )
		expect( SdkFileAccess.scope( entries, grants, 'write' ) ).not.toContain( FILE )
	} )

	it( 'dedupes a granted path that already sits inside a configured root', () => {
		expect( SdkFileAccess.scope( [ at( ROOT, 'read' ) ], [ fileGrant( ROOT ) ], 'read' ) ).toEqual( [ ROOT ] )
	} )

	it( 'defaults to read, which is what the existing callers mean', () => {
		expect( SdkFileAccess.scope( entries ) ).toEqual( SdkFileAccess.scope( entries, [], 'read' ) )
	} )
} )

describe( 'the witness agrees with the verdict', () => {

	it( 'never advertises a path the resolver would refuse at that level', () => {
		const entries = [ at( ROOT, 'write' ), at( LOOSE, 'read' ), at( OUT, 'none' ) ]
		for( const required of [ 'read', 'write', 'delete' ] as const ) {
			for( const path of SdkFileAccess.scope( entries, [], required ) ) {
				const verdict = SdkFileAccess.resolveLevel( path, entries )
				expect( verdict.level ).not.toBe( 'none' )
			}
		}
	} )
} )

describe( 'the refusal — WHY, WHERE, and now HOW DEEP', () => {

	// ONE AUTHOR, and these assert the thing that makes that worth having: the same three facts, worded the
	// same way, whichever door refused. Both doors call this; neither writes its own.

	const scopeAt = ( entries: AccessEntry[], required: 'read' | 'write' | 'delete' ): string[] =>
		SdkFileAccess.scope( entries, [], required )

	it( 'names the DEPTH when the path is reachable but not deeply enough', () => {
		// The refusal the graded ladder created — the boolean pair could not express it. Its next move is ASK
		// FOR MORE HERE, which is the opposite of the out-of-scope refusal's GO SOMEWHERE ELSE.
		const entries = [ at( ROOT, 'read' ) ]
		const line = SdkFileAccess.refusal( SdkFileAccess.resolveLevel( INSIDE, entries ), 'write', scopeAt( entries, 'write' ) )

		expect( line ).toContain( 'within reach' )
		expect( line ).toContain( 'list, read, search' )   // what it HAS
		expect( line ).toContain( 'write' )                // what it NEEDS
		expect( line ).toContain( 'raise' )                // what would change it
	} )

	it( 'does NOT send a too-shallow caller somewhere else', () => {
		// The silent failure this branch exists to prevent: handed the out-of-scope advice, an agent
		// relocates a file it should have asked about, and the relocation looks like success.
		const entries = [ at( ROOT, 'read' ) ]
		const line = SdkFileAccess.refusal( SdkFileAccess.resolveLevel( INSIDE, entries ), 'write', scopeAt( entries, 'write' ) )

		expect( line ).not.toContain( 'sits outside' )
		expect( line ).not.toContain( 'Work inside one of those' )
	} )

	it( 'points at the SCOPE when the path is outside every root, as it always has', () => {
		const entries = [ at( ROOT, 'read' ) ]
		const line = SdkFileAccess.refusal( SdkFileAccess.resolveLevel( OUT, entries ), 'read', scopeAt( entries, 'read' ) )

		expect( line ).toContain( 'outside' )
		expect( line ).toContain( ROOT )
	} )

	it( 'still says NO FILE ACCESS AT ALL when that is the whole truth', () => {
		expect( SdkFileAccess.refusal( SdkFileAccess.resolveLevel( OUT, [] ), 'read', [] ) )
			.toContain( 'no file access at all' )
	} )

	it( 'does NOT claim no access at a deeper rung — the lie the generalization could have introduced', () => {
		// An agent that may read a dozen roots, refused a WRITE, must not be told it has no file access.
		// Empty scope means different things at different rungs and the sentence has to know which.
		const entries = [ at( ROOT, 'read' ), at( LOOSE, 'read' ) ]
		const line = SdkFileAccess.refusal( SdkFileAccess.resolveLevel( OUT, entries ), 'write', scopeAt( entries, 'write' ) )

		expect( scopeAt( entries, 'write' ) ).toEqual( [] )
		expect( line ).not.toContain( 'no file access at all' )
		expect( line ).toContain( 'write' )
	} )

	it( 'speaks OPERATIONS at every rung, never the tier name for destruction', () => {
		const entries = [ at( ROOT, 'write' ) ]
		const line = SdkFileAccess.refusal( SdkFileAccess.resolveLevel( INSIDE, entries ), 'delete', scopeAt( entries, 'delete' ) )

		expect( line ).toContain( 'remove' )
		expect( line ).not.toContain( 'delete' )
	} )

	it( 'says a blacklist refusal is not worth retrying — the one advice that must not vary', () => {
		expect( SdkFileAccess.blacklistLine() ).toContain( 'not something a retry' )
	} )
} )

describe( 'the witness carries DEPTH, so a boundary can be read before it is tripped', () => {

	it( 'reports each path with the level it actually resolves at', () => {
		const entries = [ at( ROOT, 'write' ), at( LOOSE, 'read' ) ];
		expect( SdkFileAccess.scopeEntries( entries ) ).toEqual( [
			{ path: ROOT,  level: 'write' },
			{ path: LOOSE, level: 'read' }
		] );
	} );

	it( 'is the SAME list the bare-path form answers with — one composer, one field wider', () => {
		const entries = [ at( ROOT, 'write' ), at( LOOSE, 'read' ), at( OUT, 'none' ) ];
		for( const required of [ 'read', 'write', 'delete' ] as const ) {
			expect( SdkFileAccess.scopeEntries( entries, [], required ).map( ( e ) => e.path ) )
				.toEqual( SdkFileAccess.scope( entries, [], required ) );
		}
	} );

	it( 'reports FLOOR PLUS when a grant and a configured entry name one path', () => {
		// It must agree with `resolveLevel`, which is the boundary. A witness that reported the configured
		// level while the resolver admitted at the granted one would be a permission model made of prose.
		const entries = [ at( ROOT, 'read' ) ];
		const grants  = [ { kind: 'file', subject: ROOT, level: 'write' } as GrantRef ];
		expect( SdkFileAccess.scopeEntries( entries, grants ) ).toEqual( [ { path: ROOT, level: 'write' } ] );
	} );
} );
