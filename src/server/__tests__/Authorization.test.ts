import { describe, it, expect } from 'vitest'
import { Authorization, GRANT_ENV, ACCESS_ENV, type HarnessAuthorization } from '../Authorization'
import { ACCESS_LEVELS, type GrantRef } from '../../session/InjectedItem'
import type { AccessEntry } from '../../core/AccessPolicy'

/**
 * The two carriers a grant crosses on, and the one parse behind both. A grant crosses to a tool server on the
 * `_meta` envelope we write, or in the environment of a per-turn child; a level that survives one and is dropped
 * or defaulted by the other grants a different thing on each tier, and nothing looks broken from either side.
 */

const FILE: GrantRef = { kind: 'file', subject: 'C:\\x\\y.md', level: 'write' }

/** A real project on every authorization built here, so the leak assertions below cannot pass vacuously. */
const PROJECT = 'proj-leak-canary'

/**
 * One authorization, built in ONE place. vitest strips types without checking them, so a field added to the
 * envelope must reach every caller through this builder rather than through a literal at each site.
 */
function auth( grants: GrantRef[], access: AccessEntry[] ): HarnessAuthorization {
	return { grants, access, projectId: PROJECT }
}

/** What the environment carrier actually delivers — published as a real spawn would, then read back. */
function throughEnv( grants: GrantRef[] ): GrantRef[] {
	return Authorization.parseGrants( JSON.parse( Authorization.publishToChild( auth( grants, [] ) )[ GRANT_ENV ] ) )
}

/** What the wire carrier delivers — the envelope built, then read back. */
function throughWire( grants: GrantRef[] ): GrantRef[] {
	return Authorization.grants( Authorization.assertOnCall( grants ) ?? undefined )
}

describe( 'both carriers deliver the same grant', () => {

	it( 'round-trips a grant identically through either one', () => {
		expect( throughWire( [ FILE ] ) ).toEqual( [ FILE ] )
		expect( throughEnv( [ FILE ] ) ).toEqual( [ FILE ] )
	} )

	it( 'agrees at EVERY rung — the assertion that catches a dropped level', () => {
		for( const level of ACCESS_LEVELS ) {
			const grant: GrantRef = { kind: 'file', subject: 'C:\\a', level }
			expect( throughWire( [ grant ] ) ).toEqual( throughEnv( [ grant ] ) )
			expect( throughWire( [ grant ] )[ 0 ]?.level ).toBe( level )
		}
	} )

	it( 'agrees on a payload it must REFUSE, not only on one it accepts', () => {
		const bad = [ { kind: 'file' }, { subject: 'C:\\a' }, { kind: 'wormhole', subject: 'C:\\a' } ]
		expect( Authorization.parseGrants( bad ) ).toEqual( [] )
		expect( Authorization.grants( { starmind: { grants: bad } } ) ).toEqual( [] )
	} )

	it( 'carries an empty list as a real statement on the env side, and as absence on the wire', () => {
		// Deliberately asymmetric: `_meta` is per call, so absent and empty are one statement; the env variable
		// is referenced by a spawn config written before the grants are known, so undefined would dangle.
		expect( Authorization.assertOnCall( [] ) ).toBeNull()
		expect( Authorization.publishToChild( { grants: [], access: [], projectId: '' } )[ GRANT_ENV ] ).toBe( '[]' )
		expect( throughEnv( [] ) ).toEqual( [] )
	} )
} )

describe( 'the two lanes carry different things, on purpose', () => {

	// The project is named in-process and withheld from a spawned child on purpose: the child is handed the
	// resolved answer, never a key it would have to resolve.

	it( 'names the project to the in-process reader', () => {
		expect( Authorization.projectId( Authorization.assertOnCall( [], 'proj-1' ) ?? undefined ) ).toBe( 'proj-1' )
	} )

	it( 'sends an envelope for a project even when the turn holds no grants', () => {
		// A turn with a workspace and no exceptions still has something to say — the floor that governs it.
		expect( Authorization.assertOnCall( [], 'proj-1' ) ).toEqual( { starmind: { projectId: 'proj-1' } } )
	} )

	it( 'says nothing at all when there is neither a grant nor a project', () => {
		expect( Authorization.assertOnCall( [], '' ) ).toBeNull()
		expect( Authorization.assertOnCall( [] ) ).toBeNull()
	} )

	// BROWSE ALL: in-process lane only, emitted only off its secure default 'off'. Absent and 'off' are one
	// statement, so a call without it stays byte-identical.

	it( 'carries Browse All only when it is off its secure default', () => {
		expect( Authorization.assertOnCall( [], 'proj-1', undefined, undefined, undefined, 'allow' ) )
			.toEqual( { starmind: { projectId: 'proj-1', browseAll: 'allow' } } )
		expect( Authorization.assertOnCall( [], 'proj-1', undefined, undefined, undefined, 'ask' ) )
			.toEqual( { starmind: { projectId: 'proj-1', browseAll: 'ask' } } )
		expect( Authorization.assertOnCall( [], 'proj-1', undefined, undefined, undefined, 'off' ) )
			.toEqual( { starmind: { projectId: 'proj-1' } } )
	} )

	it( 'speaks up for Browse All alone, since it is something to say', () => {
		expect( Authorization.assertOnCall( [], '', undefined, undefined, undefined, 'allow' ) )
			.toEqual( { starmind: { browseAll: 'allow' } } )
	} )

	it( 'reads Browse All back as a recognised policy word only', () => {
		expect( Authorization.browseAllOnCall( { starmind: { browseAll: 'allow' } } ) ).toBe( 'allow' )
		expect( Authorization.browseAllOnCall( { starmind: { browseAll: 'ask' } } ) ).toBe( 'ask' )
		// Anything else is off, because the secure answer and the absent answer are the same value — there
		// is no intent a bad value here could be hiding.
		for ( const value of [ 'true', true, 1, {}, null, undefined ] ) {
			expect( Authorization.browseAllOnCall( { starmind: { browseAll: value } } ) ).toBe( 'off' );
		}
		expect( Authorization.browseAllOnCall( {} ) ).toBe( 'off' );
		expect( Authorization.browseAllOnCall() ).toBe( 'off' );
	} )

	it( 'never leaks a project onto the spawn carrier, even with a real one in hand', () => {
		// The env payload is a bare grant list: a project in it means a child was taught to resolve a key.
		// The authorization carries a real project, so this cannot pass vacuously. Key and value are both checked.
		const env = Authorization.publishToChild( auth( [ FILE ], [] ) )
		expect( env[ GRANT_ENV ] ).not.toContain( 'projectId' )
		expect( env[ GRANT_ENV ] ).not.toContain( PROJECT )
		expect( env[ ACCESS_ENV ] ).not.toContain( PROJECT )
		expect( JSON.parse( env[ GRANT_ENV ] ) ).toEqual( [ FILE ] )
	} )

	it( 'reads a project back as empty when the call named none', () => {
		// Empty means "no project on this call" — a sessionless crossing like the inspector's Run button — and
		// resolves to no configured access rather than to whichever project happens to be open.
		expect( Authorization.projectId( undefined ) ).toBe( '' )
		expect( Authorization.projectId( { starmind: { grants: [ FILE ] } } ) ).toBe( '' )
	} )
} )

describe( 'the published floor', () => {

	// The floor is the baseline the grants except from, so the two travel together; a child must never except
	// from a baseline nobody gave it.

	const ROOT: AccessEntry = { path: 'C:\\work', level: 'write' }

	it( 'publishes BOTH variables on every spawn, empty or not', () => {
		// One writer for both. Empty matters most: an unset variable would dangle, not mean none.
		const env = Authorization.publishToChild( { grants: [], access: [], projectId: '' } )
		expect( env[ GRANT_ENV ] ).toBe( '[]' )
		expect( env[ ACCESS_ENV ] ).toBe( '[]' )
	} )

	it( 'round-trips a floor through the carrier a child actually reads', () => {
		const env = Authorization.publishToChild( auth( [], [ ROOT ] ) )
		expect( Authorization.readFloor( env[ ACCESS_ENV ] ) ).toEqual( { entries: [ ROOT ], state: 'published' } )
	} )

	it( 'round-trips a floor through the WIRE carrier with the same verdict', () => {
		// The floor rides the call, so one long-lived server answers several sessions. Asserted against
		// readFloor, not a literal: the two lanes must agree.
		const env  = Authorization.publishToChild( auth( [], [ ROOT ] ) )
		const wire = Authorization.assertOnCall( [], PROJECT, [ ROOT ] )
		expect( Authorization.floorOnCall( wire ?? undefined ) ).toEqual( Authorization.readFloor( env[ ACCESS_ENV ] ) )
	} )

	it( 'tells NOTHING ON THE CALL apart from AN EMPTY FLOOR ON THE CALL', () => {
		// Absent says this lane publishes no floor; empty says this caller reaches nothing.
		// Collapsing them lets a routed call fall back to the other lane's workspace roots.
		expect( Authorization.floorOnCall( undefined ) ).toEqual( { entries: null, state: 'absent' } )
		expect( Authorization.floorOnCall( { starmind: { projectId: 'p' } } ) ).toEqual( { entries: null, state: 'absent' } )
		expect( Authorization.floorOnCall( Authorization.assertOnCall( [], 'p', [] ) ?? undefined ) )
			.toEqual( { entries: [], state: 'published' } )
	} )

	it( 'fails CLOSED and says so when the envelope will not parse', () => {
		// Here we authored the envelope, so unreadable is a defect, not a degraded mode to tolerate quietly.
		// Entries are EMPTY, not null: a floor we cannot read is not one we may substitute for.
		expect( Authorization.floorOnCall( { starmind: { access: 'not-a-list' } } ) )
			.toEqual( { entries: [], state: 'unreadable' } )
		expect( Authorization.floorOnCall( { starmind: { access: { path: 'C:\\work' } } } ) )
			.toEqual( { entries: [], state: 'unreadable' } )
	} )

	it( 'never reports UNEXPANDED on the wire, because no substitution happens there', () => {
		// Unexpanded is a string-carrier failure. A wire envelope holds a parsed value, so the state is
		// unreachable there and is never faked; a literal reference arriving on the wire is simply unreadable.
		expect( Authorization.floorOnCall( { starmind: { access: '${STARMIND_ACCESS}' } } ).state ).toBe( 'unreadable' )
	} )

	it( 'tells NOTHING PUBLISHED apart from PUBLISHED EMPTY — the reason this carrier exists', () => {
		// null means fall back to configuration; [] means this caller reaches nothing. One value for both
		// would silently restore whatever the shared slice held at the exact moment a host meant to deny.
		expect( Authorization.readFloor( undefined ).entries ).toBeNull()
		expect( Authorization.readFloor( '' ).entries ).toBeNull()
		expect( Authorization.readFloor( '[]' ) ).toEqual( { entries: [], state: 'published' } )
	} )

	it( 'reads an unexpanded reference as absent, and NAMES it', () => {
		// A failed substitution is a transport failure, not a statement about access: fall back, and let `state` name it.
		expect( Authorization.readFloor( '${STARMIND_ACCESS}' ) ).toEqual( { entries: null, state: 'unexpanded' } )
	} )

	it( 'grants NOTHING for a payload that arrived and could not be read', () => {
		// Opposite of an unexpanded reference: this floor arrived corrupt, and a corrupt floor is never
		// substituted by a different one.
		for( const raw of [ 'nope', '7', 'true', '{"path":"C:\\\\work"}' ] ) {
			expect( Authorization.readFloor( raw ) ).toEqual( { entries: [], state: 'unreadable' } )
		}
	} )

	it( 'keeps the readable entries in a list that also holds unreadable ones', () => {
		expect( Authorization.readFloor( JSON.stringify( [ ROOT, { nope: true }, null ] ) ).entries ).toEqual( [ ROOT ] )
	} )

	it( 'leaves the GRANT carrier a bare array, so an older child still reads it', () => {
		// Version skew: the child is vendored and promoted on its own schedule. Folding the floor into
		// GRANT_ENV would hand an older bundle an object where it expects an array, and it would assert nothing.
		const env = Authorization.publishToChild( auth( [ FILE ], [ ROOT ] ) )
		expect( JSON.parse( env[ GRANT_ENV ] ) ).toEqual( [ FILE ] )
		expect( Authorization.parseGrants( JSON.parse( env[ GRANT_ENV ] ) ) ).toEqual( [ FILE ] )
	} )
} )

describe( 'the parse fails closed', () => {

	it( 'yields nothing for anything that is not an array of objects', () => {
		for( const raw of [ undefined, null, 'nope', 7, {}, [ 1, 'a', null ] ] ) {
			expect( Authorization.parseGrants( raw ) ).toEqual( [] )
		}
	} )

	it( 'drops a grant with an empty or missing subject', () => {
		expect( Authorization.parseGrant( { kind: 'file', subject: '' } ) ).toBeNull()
		expect( Authorization.parseGrant( { kind: 'file' } ) ).toBeNull()
	} )

	it( 'drops a grant naming a kind that is not in the vocabulary', () => {
		expect( Authorization.parseGrant( { kind: 'shell', subject: 'C:\\a' } ) ).toBeNull()
	} )

	it( 'drops a grant whose level it cannot read, rather than clamping it to something workable', () => {
		expect( Authorization.parseGrant( { kind: 'file', subject: 'C:\\a', level: 'admin' } ) ).toBeNull()
		expect( Authorization.parseGrant( { kind: 'file', subject: 'C:\\a', level: 2 } ) ).toBeNull()
		expect( Authorization.parseGrant( { kind: 'file', subject: 'C:\\a', level: null } ) ).toBeNull()
	} )

	it( 'keeps the readable grants in a list that also holds unreadable ones', () => {
		expect( Authorization.parseGrants( [ { kind: 'file' }, FILE, null ] ) ).toEqual( [ FILE ] )
	} )

	it( 'reads an unexpanded variable reference as no grants', () => {
		// A literal `${STARMIND_GRANTS}` means the harness failed to expand it; JSON.parse rejects it and the caller degrades.
		expect( () => JSON.parse( '${STARMIND_GRANTS}' ) ).toThrow()
	} )
} )

describe( 'the parse REPORTS what it refused', () => {

	// Failing closed and failing silently are different decisions. The count is the only thing that tells an
	// ungranted call from a lost grant set, and the hosts trace on it, so a zero must mean nothing was lost.

	it( 'counts each entry it dropped while keeping the ones it could read', () => {
		const { grants, dropped } = Authorization.parseGrantsCounted( [ { kind: 'file' }, FILE, null, { kind: 'wormhole', subject: 'C:\\a' } ] )
		expect( grants ).toEqual( [ FILE ] )
		expect( dropped ).toBe( 3 )
	} )

	it( 'reports ZERO for an absent payload, because absence is the ordinary case', () => {
		// Every ungranted call in the system lands here. Counting it as a loss would make the warning fire
		// constantly and mean nothing, which is the same as not having it.
		expect( Authorization.parseGrantsCounted( undefined ) ).toEqual( { grants: [], dropped: 0 } )
		expect( Authorization.parseGrantsCounted( null ) ).toEqual( { grants: [], dropped: 0 } )
	} )

	it( 'reports ONE for a payload that is present but unreadable — the largest possible loss', () => {
		// A non-array is not "no grants": it is a grant set that did not survive the crossing.
		for( const raw of [ 'nope', 7, {}, true ] ) {
			expect( Authorization.parseGrantsCounted( raw ) ).toEqual( { grants: [], dropped: 1 } )
		}
	} )

	it( 'is the same parse `parseGrants` and `grants` run — one loop, not a second implementation', () => {
		// One loop, not a second implementation: a counting variant with its own loop would drift again.
		const raw = [ FILE, { kind: 'file' } ]
		expect( Authorization.parseGrants( raw ) ).toEqual( Authorization.parseGrantsCounted( raw ).grants )
		expect( Authorization.grants( { starmind: { grants: raw } } ) ).toEqual( Authorization.grantsCounted( { starmind: { grants: raw } } ).grants )
	} )

	it( 'counts an unexpanded variable reference through the carrier the child actually uses', () => {
		// The worst silent drop, end to end: a literal `${STARMIND_GRANTS}` throws in JSON.parse and the child
		// traces it from its catch. Pins the boundary so the child's two trace lines stay distinct.
		expect( () => JSON.parse( '${STARMIND_GRANTS}' ) ).toThrow()
		expect( Authorization.parseGrantsCounted( '${STARMIND_GRANTS}' ).dropped ).toBe( 1 )
	} )
} )

describe( 'a missing level is a MIGRATION, not a default', () => {

	it( 'resolves to read — what a grant meant before depths existed', () => {
		expect( Authorization.parseGrant( { kind: 'file', subject: 'C:\\a' } ) ).toEqual( { kind: 'file', subject: 'C:\\a', level: 'read' } )
	} )

	it( 'can never resolve to write or delete, so a version skew only ever UNDER-grants', () => {
		// Version skew: an older bundle meeting a newer host is ordinary, so a missing level may only under-grant.
		const migrated = Authorization.parseGrant( { kind: 'file', subject: 'C:\\a' } )
		expect( migrated?.level ).toBe( 'read' )
	} )

	it( 'an older server dropping the field entirely also under-grants, which is the other skew', () => {
		// Simulates a bundle that parses only kind + subject: the level is lost, and the path falls back to
		// whatever configuration allows. Nothing is widened by the loss.
		const stripped = { kind: FILE.kind, subject: FILE.subject }
		expect( Authorization.parseGrant( stripped )?.level ).toBe( 'read' )
	} )
} )

describe( 'the env variable names', () => {

	it( 'are exported so the writer and the reader name them once', () => {
		// Pinned as values: the host stamps `${NAME}` into a config file the child never sees, so nothing else would catch a rename that only half landed.
		expect( GRANT_ENV ).toBe( 'STARMIND_GRANTS' )
		expect( ACCESS_ENV ).toBe( 'STARMIND_ACCESS' )
	} )
} )
