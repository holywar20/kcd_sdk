import { describe, it, expect } from 'vitest'
import { Authorization, GRANT_ENV, ACCESS_ENV, type HarnessAuthorization } from '../Authorization'
import { ACCESS_LEVELS, type GrantRef } from '../../session/InjectedItem'
import type { AccessEntry } from '../../core/AccessPolicy'

/**
 * The two CARRIERS, and the one parse behind both.
 *
 * A grant crosses to a tool server two ways: the `_meta` envelope we write on a call we own, and the
 * environment of a per-turn child a foreign harness spawned. The failure mode this suite exists for is the
 * one that stays invisible longest — a level that survives one carrier and is dropped or defaulted by the
 * other grants a different thing on each tier, and nothing looks broken from either side.
 *
 * It is not hypothetical. Before this parse was hoisted the two had ALREADY drifted: the environment side
 * validated every field and dropped what it could not read, while the wire side did an unchecked cast, so
 * a malformed assertion reached the guards as a grant-shaped object with undefined fields.
 */

const FILE: GrantRef = { kind: 'file', subject: 'C:\\x\\y.md', level: 'write' }

/** A project that is REALLY THERE on every authorization this file builds. The leak assertions below are
 *  worth nothing against an empty one: "no project appears in the payload" is trivially true when there was
 *  no project to appear, and the rule being defended is that a project is never published even when one
 *  EXISTS. */
const PROJECT = 'proj-leak-canary'

/**
 * One authorization, built in ONE place.
 *
 * Four call sites below each constructed this literal independently, and all four went stale in the same
 * moment when the envelope gained a required field — invisibly, because vitest strips types without
 * checking them, so only `tsc` at build time ever objected. A shared builder is why the next field costs
 * one edit rather than four silent ones.
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
		// Deliberately asymmetric. `_meta` is authored per call, so omitting it and having nothing to say are
		// the same statement; the env variable is REFERENCED from a spawn config written before any turn's
		// grants are known, so leaving it undefined is a dangling reference rather than a "no grants".
		expect( Authorization.assertOnCall( [] ) ).toBeNull()
		expect( Authorization.publishToChild( { grants: [], access: [], projectId: '' } )[ GRANT_ENV ] ).toBe( '[]' )
		expect( throughEnv( [] ) ).toEqual( [] )
	} )
} )

describe( 'the two lanes carry different things, on purpose', () => {

	// The PROJECT is named to an in-process reader and withheld from a spawned one, and the asymmetry is a
	// ruling rather than an oversight: a spawned server is POINTED at its project by the host publishing the
	// resolved policy, so what crosses that boundary is always the answer and never a lookup key it would
	// have to trust a table it cannot see to resolve. Pinned here because the two writers sit side by side,
	// and adjacency is exactly what makes a deliberate omission look like a missing line.

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

	it( 'never leaks a project onto the spawn carrier, even with a real one in hand', () => {
		// The env payload is a bare grant list. If a project ever appears in this string, someone has taught a
		// spawned child to resolve a key instead of being handed an answer.
		//
		// THE AUTHORIZATION CARRIES A REAL PROJECT, which is what makes this an assertion rather than a
		// tautology. It used to be built with an empty one, so "no project appears" was trivially true of a
		// payload that had no project to publish — the test would have passed just as happily against a writer
		// that leaked every project it was ever given. Both the KEY and the VALUE are checked, because a
		// payload could name one without the other.
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

	// The floor is the BASELINE and the grants are exceptions to it, so the two travel together or the child
	// ends up excepting from a baseline nobody gave it. On this lane it used to read that baseline from a
	// package-store slice shared with the in-process lane — one file, two publishers, and whichever wrote
	// last won regardless of which workspace the reader belonged to.

	const ROOT: AccessEntry = { path: 'C:\\work', level: 'write' }

	it( 'publishes BOTH variables on every spawn, empty or not', () => {
		// One writer for both. The empty case is the one that matters: the spawn config stamps both `${…}`
		// references unconditionally, so a variable left unset is a dangling reference, not a "none".
		const env = Authorization.publishToChild( { grants: [], access: [], projectId: '' } )
		expect( env[ GRANT_ENV ] ).toBe( '[]' )
		expect( env[ ACCESS_ENV ] ).toBe( '[]' )
	} )

	it( 'round-trips a floor through the carrier a child actually reads', () => {
		const env = Authorization.publishToChild( auth( [], [ ROOT ] ) )
		expect( Authorization.readFloor( env[ ACCESS_ENV ] ) ).toEqual( { entries: [ ROOT ], state: 'published' } )
	} )

	it( 'round-trips a floor through the WIRE carrier with the same verdict', () => {
		// The third carrier, and the one that lets a single long-lived server answer for several sessions at
		// once: the floor rides the call rather than the process. Asserted against `readFloor`'s own result
		// rather than a literal, because the property is that the two lanes AGREE — a wire floor that parsed
		// correctly but differently from the env floor would pass a literal comparison and still put two
		// readers of one policy on different answers.
		const env  = Authorization.publishToChild( auth( [], [ ROOT ] ) )
		const wire = Authorization.assertOnCall( [], PROJECT, [ ROOT ] )
		expect( Authorization.floorOnCall( wire ?? undefined ) ).toEqual( Authorization.readFloor( env[ ACCESS_ENV ] ) )
	} )

	it( 'tells NOTHING ON THE CALL apart from AN EMPTY FLOOR ON THE CALL', () => {
		// The same distinction `readFloor` draws one lane over, and the whole reason `access` is optional on
		// the envelope rather than always emitted. Absent says "this lane publishes no floor, use your own
		// configuration"; empty says "this caller reaches nothing". Collapsing them lets a routed call fall
		// back to a slice the OTHER lane writes, which is a different workspace's roots.
		expect( Authorization.floorOnCall( undefined ) ).toEqual( { entries: null, state: 'absent' } )
		expect( Authorization.floorOnCall( { starmind: { projectId: 'p' } } ) ).toEqual( { entries: null, state: 'absent' } )
		expect( Authorization.floorOnCall( Authorization.assertOnCall( [], 'p', [] ) ?? undefined ) )
			.toEqual( { entries: [], state: 'published' } )
	} )

	it( 'fails CLOSED and says so when the envelope will not parse', () => {
		// `unreadable` means something different here than on the env lane, and callers are required to treat
		// it differently: there a harness mis-expanded a variable, which is someone else's bug and a degraded
		// mode to tolerate quietly. HERE we authored the envelope and we wrote the server, so there is no third
		// party and no retry that helps — it is a defect, and the host is expected to shout. Either way the
		// entries are EMPTY rather than null: a floor we cannot read is not one we may substitute for.
		expect( Authorization.floorOnCall( { starmind: { access: 'not-a-list' } } ) )
			.toEqual( { entries: [], state: 'unreadable' } )
		expect( Authorization.floorOnCall( { starmind: { access: { path: 'C:\\work' } } } ) )
			.toEqual( { entries: [], state: 'unreadable' } )
	} )

	it( 'never reports UNEXPANDED on the wire, because no substitution happens there', () => {
		// The literal `${…}` that a harness failed to expand is a STRING-carrier failure. A wire envelope holds
		// a parsed value, so the state is unreachable by construction and is deliberately never faked to look
		// symmetrical with the env lane — a diagnosis nobody can act on is worse than an absent one. A literal
		// reference arriving here is simply not a list, which is the honest reading: unreadable.
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
		// A failed string substitution is a transport failure, not a statement about access — and it has
		// happened before on the grant carrier. Refusing every path over one would take file access down for
		// a reason nobody could see, so it falls back; `state` is what stops that being silent.
		expect( Authorization.readFloor( '${STARMIND_ACCESS}' ) ).toEqual( { entries: null, state: 'unexpanded' } )
	} )

	it( 'grants NOTHING for a payload that arrived and could not be read', () => {
		// The opposite direction from an unexpanded reference, deliberately. That one is the variable failing
		// to arrive; this one is a floor arriving corrupt, and a floor we cannot read is not a floor we may
		// quietly substitute a different one for.
		for( const raw of [ 'nope', '7', 'true', '{"path":"C:\\\\work"}' ] ) {
			expect( Authorization.readFloor( raw ) ).toEqual( { entries: [], state: 'unreadable' } )
		}
	} )

	it( 'keeps the readable entries in a list that also holds unreadable ones', () => {
		expect( Authorization.readFloor( JSON.stringify( [ ROOT, { nope: true }, null ] ) ).entries ).toEqual( [ ROOT ] )
	} )

	it( 'leaves the GRANT carrier a bare array, so an older child still reads it', () => {
		// The version-skew guarantee, and the reason this is a second variable rather than a wider payload.
		// The child is vendored into the host's plugin directory and promoted on its own schedule, so a newer
		// host meeting an older bundle is ordinary. Fold the floor into GRANT_ENV and that bundle parses an
		// object where it expects an array, counts one drop, and asserts nothing.
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
		// A spawn config stamps `${STARMIND_GRANTS}` and relies on the harness to expand it. Arriving
		// literally is a real failure that has happened; JSON.parse rejects it and the caller degrades.
		expect( () => JSON.parse( '${STARMIND_GRANTS}' ) ).toThrow()
	} )
} )

describe( 'the parse REPORTS what it refused', () => {

	// Failing closed and failing silently are two decisions, and only the first one was ever wanted. Every
	// case above yields an empty array; so does a call that was simply never granted anything. The count is
	// the only thing that separates them, and the hosts trace on it — main to CAPABILITY, the child to its
	// own trace file. Get this wrong and the instrumentation reports "all fine" at precisely the moment it
	// is not.

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
		// A non-array is not "no grants", it is a grant set that did not survive the crossing. Reporting zero
		// here would say nothing was lost about the case where everything was.
		for( const raw of [ 'nope', 7, {}, true ] ) {
			expect( Authorization.parseGrantsCounted( raw ) ).toEqual( { grants: [], dropped: 1 } )
		}
	} )

	it( 'is the same parse `parseGrants` and `grants` run — one loop, not a second implementation', () => {
		// The whole point of hoisting this file was that two readers of one payload had already drifted.
		// A counting variant that walked its own loop would be that mistake again, one layer down.
		const raw = [ FILE, { kind: 'file' } ]
		expect( Authorization.parseGrants( raw ) ).toEqual( Authorization.parseGrantsCounted( raw ).grants )
		expect( Authorization.grants( { starmind: { grants: raw } } ) ).toEqual( Authorization.grantsCounted( { starmind: { grants: raw } } ).grants )
	} )

	it( 'counts an unexpanded variable reference through the carrier the child actually uses', () => {
		// The end-to-end shape of the worst silent drop: `${STARMIND_GRANTS}` arrives literally, JSON.parse
		// throws, and the child traces `grant.unreadable` from its catch rather than reporting a count. This
		// pins the boundary between the two failure modes so the child's two trace lines stay distinct.
		expect( () => JSON.parse( '${STARMIND_GRANTS}' ) ).toThrow()
		expect( Authorization.parseGrantsCounted( '${STARMIND_GRANTS}' ).dropped ).toBe( 1 )
	} )
} )

describe( 'a missing level is a MIGRATION, not a default', () => {

	it( 'resolves to read — what a grant meant before depths existed', () => {
		expect( Authorization.parseGrant( { kind: 'file', subject: 'C:\\a' } ) ).toEqual( { kind: 'file', subject: 'C:\\a', level: 'read' } )
	} )

	it( 'can never resolve to write or delete, so a version skew only ever UNDER-grants', () => {
		// The child is vendored into the host's plugin directory and promoted on its own schedule, so an
		// older bundle meeting a newer host is ordinary. Both skews have to be safe; this is the one that
		// could have been unsafe.
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
		// A string literal duplicated across a process boundary is a silent no-grant the first time one side
		// is edited. Pinned as values because the host stamps `${NAME}` into a config file the child never
		// sees — nothing else would catch a rename that only half landed.
		expect( GRANT_ENV ).toBe( 'STARMIND_GRANTS' )
		expect( ACCESS_ENV ).toBe( 'STARMIND_ACCESS' )
	} )
} )
