import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { grantSubject, type Grant } from '../TurnEntry';

/**
 * THE HOIST — what survives a compaction, and what a compaction quietly executes.
 *
 * `Session.ts` states the rule in prose at the three-readers comment block and nothing checked it. The
 * whole model turns on one sentence: *a grant that survives compaction is canonized, and a grant marked
 * removed simply is not* — so the pass that rewrites the prefix settles both deferred decisions at once,
 * and not-promoting IS the execution of a revocation. Two different bugs hide behind that, and both are
 * silent:
 *
 *   • a compacted grant that fails to hoist is a permission the user granted and the system forgot,
 *     revoked by a summarisation nobody asked for and cannot see;
 *   • a REMOVED grant that hoists anyway is a revocation that did not happen, and there is no second
 *     mechanism to catch it — not-promoting was the only one.
 *
 * Beside those, the structural claim the comment block makes about the three readers: `hoistedGrants()`
 * is a SUBSET of `grants()` and DISJOINT from `attachments()` by construction. That is what makes the
 * hoist a move between tiers rather than a copy, and it is the invariant a merge of any two of the three
 * would break — quietly, by drawing compacted files in the gutter or by expiring a permission.
 */

/** One file grant. `removed` is the pending revocation — an intent, until a compaction executes it. */
function fileGrant( name: string, removed?: boolean ): Grant {
	return { at: 1, kind: 'injected-file', path: `C:/repo/${ name }`, name, mediaType: 'text/plain', bytes: 40, removed };
}

/** A tool grant, whose subject is DERIVED from the server/name pair rather than being a path. Present so
 *  the hoist is pinned on both subject shapes — a hoist keyed on `path` alone would drop every tool. */
function toolGrant( server: string, name: string, removed?: boolean ): Grant {
	return { at: 1, kind: 'injected-tool', server, name, removed };
}

function newSession(): Session {
	return Session.create( { id: 'session-1', agentId: 'agent-1' } );
}

/** Open one turn carrying these grants plus a user line, as a real exchange would. */
function turnWith( session: Session, id: string, at: number, ...grants: Grant[] ): void {
	const turn = session.transcript.openTurn( id, at );
	for ( const grant of grants ) session.transcript.append( grant, turn );
	session.transcript.append( { at, kind: 'user', text: id }, turn );
}

const subjects = ( refs: { subject: string }[] ): string[] => refs.map( ( r ) => r.subject ).sort();

describe( 'Session grants across a compaction', () => {

	/** A COMPACTED GRANT SURVIVES. The deck stops showing it — its turn is no longer context — and the
	 *  authorization is untouched, because a permission does not expire because its turn got summarised. */
	it( 'canonizes a grant whose turn was compacted, and keeps it authorized', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'a.ts' ), toolGrant( 'sm_file', 'read' ) );
		session.transcript.compactThrough( 'turn-1' );

		expect( subjects( session.hoistedGrants() ) ).toEqual( [ 'C:/repo/a.ts', 'sm_file.read' ] );
		// Still AUTHORIZED — this is the arm whose failure is a silent revocation.
		expect( subjects( session.grants() ) ).toEqual( [ 'C:/repo/a.ts', 'sm_file.read' ] );
		// …and off the DECK, which is the other half of the move: the gutter must not draw a compacted file.
		expect( session.attachments() ).toEqual( [] );
		// The manifest rows are the wire form of exactly this set.
		expect( session.grantRows().map( ( r ) => r.where ).sort() ).toEqual( [ 'C:/repo/a.ts', 'sm_file.read' ] );
	} );

	/** A REVOKED GRANT ENDS AT COMPACTION, by simply not being promoted. Nothing else runs — which is
	 *  precisely why nothing else would catch it if this stopped working. */
	it( 'executes a pending revocation at the compaction, dropping the grant from both readers', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'a.ts', true ), fileGrant( 'b.ts' ) );
		session.transcript.compactThrough( 'turn-1' );

		expect( subjects( session.hoistedGrants() ) ).toEqual( [ 'C:/repo/b.ts' ] );
		expect( subjects( session.grants() ) ).toEqual( [ 'C:/repo/b.ts' ] );
		expect( session.grantRows().map( ( r ) => r.where ) ).toEqual( [ 'C:/repo/b.ts' ] );
	} );

	/** …AND NOT ONE MOMENT SOONER. A revocation is pending on both axes until the compaction that executes
	 *  it, so a removed grant on a live turn still shows and still authorizes. Honouring it instantly would
	 *  buy a re-prefill for a distinction nobody asked for. */
	it( 'still authorizes a grant marked removed while its turn is live', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'a.ts', true ) );

		expect( subjects( session.grants() ) ).toEqual( [ 'C:/repo/a.ts' ] );
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
		// Nothing is canonized yet: its line is still riding, so a manifest row would say it twice.
		expect( session.hoistedGrants() ).toEqual( [] );
	} );

	/** A RE-INJECTION ON A LIVE TURN UN-HOISTS. The reference line is riding again, so a manifest row beside
	 *  it would be the duplicate `hoistedGrants()` exists to avoid — and the grant appears ONCE, not twice. */
	it( 'un-hoists a grant re-injected on a live turn, and counts it once', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'a.ts' ) );
		session.transcript.compactThrough( 'turn-1' );
		turnWith( session, 'turn-2', 2, fileGrant( 'a.ts' ) );

		expect( session.hoistedGrants() ).toEqual( [] );
		expect( session.grantRows() ).toEqual( [] );
		expect( session.grants().filter( ( g ) => g.subject === 'C:/repo/a.ts' ) ).toHaveLength( 1 );
		expect( session.attachments().filter( ( a ) => a.name === 'a.ts' ) ).toHaveLength( 1 );
	} );

	/** ORDER DOES NOT SAVE IT EITHER. The live set is collected across the WHOLE transcript before anything
	 *  is removed, so a grant compacted AFTER its re-injection is still un-hoisted — a hoist that walked and
	 *  decided in one pass would promote this one and duplicate the reference. */
	it( 'un-hoists even when the compacted turn comes after the live one', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'a.ts' ) );
		turnWith( session, 'turn-2', 2, fileGrant( 'a.ts' ) );
		session.transcript.compactThrough( 'turn-2' );                // both turns summarised…
		const later = session.transcript.openTurn( 'turn-3', 3 );
		session.transcript.append( fileGrant( 'a.ts' ), later );      // …and here it is again, live

		expect( session.hoistedGrants() ).toEqual( [] );
		expect( session.grants().filter( ( g ) => g.subject === 'C:/repo/a.ts' ) ).toHaveLength( 1 );
	} );

	/** THE STRUCTURAL CLAIM, asserted rather than read: hoisted ⊆ grants, and hoisted ∩ attachments = ∅.
	 *  Collapse any two of the three readers and one of these two stops holding. */
	it( 'keeps the hoisted set a subset of grants and disjoint from the deck', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, fileGrant( 'gone.ts' ), fileGrant( 'revoked.ts', true ) );
		turnWith( session, 'turn-2', 2, fileGrant( 'here.ts' ) );
		session.transcript.compactThrough( 'turn-1' );
		session.pendingEntries.push( fileGrant( 'pending.ts' ) );

		const hoisted  = subjects( session.hoistedGrants() );
		const granted  = subjects( session.grants() );
		const onTheDeck = session.attachments().map( grantSubject );

		expect( hoisted ).toEqual( [ 'C:/repo/gone.ts' ] );
		expect( hoisted.every( ( s ) => granted.includes( s ) ) ).toBe( true );
		expect( hoisted.some( ( s ) => onTheDeck.includes( s ) ) ).toBe( false );
		// The deck is the live turn plus what is attached but unsent — never the compacted pair.
		expect( onTheDeck.sort() ).toEqual( [ 'C:/repo/here.ts', 'C:/repo/pending.ts' ] );
		expect( granted ).toEqual( [ 'C:/repo/gone.ts', 'C:/repo/here.ts', 'C:/repo/pending.ts' ] );
	} );

	/** Every canonized row says WHO authorized it, in the shape the manifest merge reads. The merge
	 *  re-renders from structured rows and never parses rendered text, which is why a prose return shipped
	 *  an empty `## Grants` heading — the rows are the section. */
	it( 'renders a canonized grant as a manifest row carrying kind, subject and why', () => {
		const session = newSession();
		turnWith( session, 'turn-1', 1, toolGrant( 'sm_file', 'write' ) );
		session.transcript.compactThrough( 'turn-1' );

		expect( session.grantRows() ).toEqual( [
			{ what: 'tool', where: 'sm_file.write', why: 'granted by the user for this session' }
		] );
	} );
} );
