import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { isGrant, type Attachment, type TurnEntry } from '../TurnEntry';

/**
 * `forkFromLane()` — a child session, written as though somebody had opened it fresh.
 *
 * THE CASES THAT MATTER ARE ABOUT WHAT IT REFUSES TO CARRY. A duplicate is easy; what makes this a
 * re-authoring rather than a copy is that the parent's HISTORY OF BECOMING — the injection events, the
 * revocations, the compaction state — does not come along, while the FACTS those events established do.
 * Every case below is one half of that trade.
 */

function file( name: string, removed?: boolean ): Attachment {
	return { at: 1, kind: 'injected-file', path: `C:/repo/${ name }`, name, mediaType: 'text/plain', bytes: 40, removed };
}

/** A parent with `n` complete turns, each one message. `decorate` drops extra entries onto a given turn. */
function parent( n: number, decorate: Record<number, TurnEntry[]> = {} ): Session {
	const session = Session.create( { id: 'parent-1', agentId: 'agent-1', projectId: 'p1' } );
	for ( let i = 1; i <= n; i++ ) {
		const turn = session.transcript.openTurn( `turn-${ i }`, i );
		for ( const entry of decorate[ i ] ?? [] ) session.transcript.append( entry, turn );
		session.transcript.append( { at: i, kind: 'user', text: `message ${ i }` }, turn );
		session.transcript.append( { at: i, kind: 'assistant', text: `reply ${ i }` }, turn );
	}
	return session;
}

const texts = ( s: Session ): string[] =>
	s.transcript.allTurns().flatMap( ( t ) => t.entries.filter( ( e ) => e.kind === 'user' ).map( ( e ) => e.text ) );

const subjects = ( entries: TurnEntry[] ): string[] =>
	entries.filter( isGrant ).map( ( e ) => ( 'name' in e ? e.name : '' ) );


describe( 'what a fork from a lane carries', () => {

	/** Told once, in the conversation, ahead of everything else it is handed — so it rides the first send and
	 *  is history after, with nothing on the session remembering that it is a fork. */
	it( 'opens by reorienting the agent, ahead of the grants', () => {
		const child = parent( 3, { 1: [ file( 'kept.ts' ) ] } ).forkFromLane();
		const [ first, ...rest ] = child.pendingEntries;

		expect( child.id ).not.toBe( 'parent-1' );
		expect( first ).toMatchObject( { kind: 'user' } );
		expect( first.kind === 'user' && first.text ).toContain( 'not working a lane' );
		expect( rest.every( isGrant ) ).toBe( true );
		expect( child.frame ).toBe( '' );
	} );

	it( 'carries the LAST turns and no more, keeping their text exactly', () => {
		const child = parent( 8 ).forkFromLane( { keepTurns: 3 } );
		expect( texts( child ) ).toEqual( [ 'message 6', 'message 7', 'message 8' ] );
	} );

	it( 'carries the agent, project and policies, and takes a new identity', () => {
		const src   = parent( 1 );
		src.policies.chat.enabled = false;
		const child = src.forkFromLane();

		expect( child.agentId ).toBe( 'agent-1' );
		expect( child.projectId ).toBe( 'p1' );
		expect( child.policies.chat.enabled ).toBe( false );
	} );
} );


describe( 'what it deliberately leaves behind', () => {

	/** A failed turn never landed and an empty one holds nothing — carrying either spends the child's
	 *  window on something that was not part of the conversation. */
	it( 'skips turns that never completed', () => {
		const src = parent( 3 );
		src.transcript.failTurn( 'turn-2' );

		expect( texts( src.forkFromLane( { keepTurns: 5 } ) ) ).toEqual( [ 'message 1', 'message 3' ] );
	} );

	/**
	 * THE RE-AUTHORING, in one case. The parent learned about `kept.ts` as an EVENT on turn 1; the child
	 * is told it as a FACT, once, with no story about when it arrived — which is what stops it learning
	 * the same thing several times and the wrong one last.
	 */
	it( 'strips grant events from the history and states the grant once instead', () => {
		const child = parent( 3, { 1: [ file( 'kept.ts' ) ] } ).forkFromLane();

		expect( child.transcript.allTurns().flatMap( ( t ) => t.entries ).filter( isGrant ) ).toEqual( [] );
		expect( subjects( child.pendingEntries ) ).toEqual( [ 'kept.ts' ] );
	} );

	/** Re-injection is the user pointing at a file a second time, not a second grant. */
	it( 'states a re-injected grant once, not once per injection', () => {
		const child = parent( 3, { 1: [ file( 'same.ts' ) ], 3: [ file( 'same.ts' ) ] } ).forkFromLane();
		expect( subjects( child.pendingEntries ) ).toEqual( [ 'same.ts' ] );
	} );

	/**
	 * NOT-PROMOTING IS THE EXECUTION — the same rule the compactor uses, applied at the other moment a
	 * prefix gets rewritten. A revoked grant still shows and still authorizes on the PARENT until its
	 * compaction; on a child being written fresh there is nothing for it to survive into.
	 */
	it( 'drops a revoked grant rather than carrying the revocation', () => {
		const child = parent( 3, { 1: [ file( 'gone.ts' ) ], 2: [ file( 'gone.ts', true ) ], 3: [ file( 'stays.ts' ) ] } ).forkFromLane();
		expect( subjects( child.pendingEntries ) ).toEqual( [ 'stays.ts' ] );
	} );

	/** A grant attached but not yet sent is still a grant the person made. */
	it( 'carries a grant that was pending on the parent', () => {
		const src = parent( 1 );
		src.pendingEntries.push( file( 'unsent.ts' ) );
		expect( subjects( src.forkFromLane().pendingEntries ) ).toEqual( [ 'unsent.ts' ] );
	} );

	/** NO SCARS. The child is not a session that has been through something. */
	it( 'carries no compaction state at all', () => {
		const child = parent( 8 ).forkFromLane( { keepTurns: 2 } );

		expect( child.compactions ).toEqual( [] );
		expect( child.transcript.allTurns().every( ( t ) => !t.compacted ) ).toBe( true );
		expect( child.transcript.allTurns().every( ( t ) => t.include ) ).toBe( true );
	} );
} );
