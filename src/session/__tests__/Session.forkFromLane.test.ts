import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { isGrant, type Attachment, type TurnEntry } from '../TurnEntry';

/**
 * `forkFromLane()` opens a child as though fresh: the parent's history of becoming (injections,
 * revocations, compaction state) stays behind, while the facts those events established come along.
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

	/** The child is told each grant once, as a fact with no story about when it arrived, so it cannot learn the same grant several times or the wrong one last. */
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

	/** Not-promoting executes a revocation, as the compactor does: a revoked grant still authorizes on the parent, and a fresh child has nothing for it to survive into. */
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
