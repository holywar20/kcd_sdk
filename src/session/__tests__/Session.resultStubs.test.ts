import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { KEEP_TOOL_RESULT_TURNS, type SessionCompaction, type TranscriptRow } from '../TurnEntry';

/**
 * Tool-result STUBBING — what the wire sends in place of an old result, and whether the itinerary agrees.
 *
 * The model, in one sentence: the turn that ran a tool carries its result whole, every turn after carries a
 * stub naming the LINE of the session's result log where the full output lives. Nothing is stored to say so
 * — position decides, exactly as it does for an attachment.
 *
 * THREE readers consult one rule and the whole design rests on them never disagreeing: the WIRE stubs, the
 * GAUGE prices the stub, and the ITINERARY marks the row. Two of them are unit-testable here and the third
 * is the same call, which is the point of testing this at all — a run-check can see that a conversation got
 * smaller, but not that the number in a stub is the line the result is actually on.
 *
 * The cases below are the ones a conversation would never think to try:
 *
 *  - the BOUNDARY, where turn N and N+1 must not disagree about the same entry;
 *  - IDENTITY, that the string a user reads in the itinerary is character-for-character the string the model
 *    received — anything less and the surface is describing the reduction rather than showing it;
 *  - and the LINE-NUMBER promise across a compaction, which is the one that actually breaks. Which results
 *    stub is a question about the PROJECTION; which line each sits on is a question about ALL of history,
 *    because the log still holds what the compaction dropped. Count the second one on the projection and
 *    every stub is short by however many results the summary replaced — silently, and pointing at real lines
 *    holding the wrong output.
 */

const LOG = 'C:/userData/tool-results/session-1.jsonl';

/** A session with `turns` exchanges, each running exactly one tool. Results are PAIRED with their calls
 *  deliberately: `reconcilePairs` drops an orphaned result at the projection, so an unpaired one would
 *  vanish from the wire and every assertion below would pass against nothing. */
function sessionWithTools( turns: number ): Session {
	const session = Session.create( { id: 'session-1', agentId: 'agent-1' } );
	session.bindResultLog( LOG );
	for ( let i = 0; i < turns; i++ ) {
		const n    = i + 1;
		const turn = session.transcript.openTurn( `turn-${ n }`, i );
		session.transcript.append( { at: i, kind: 'user', text: `ask ${ n }` }, turn );
		session.transcript.append( { at: i, kind: 'tool-call', id: `t${ n }`, name: 'read_file', input: {} }, turn );
		// Long enough that a stub is unambiguously cheaper — a short result could price the same either way
		// and the pricing assertion would prove nothing.
		session.transcript.append( { at: i, kind: 'tool-result', toolUseId: `t${ n }`, content: `RESULT ${ n } `.repeat( 200 ) }, turn );
		session.transcript.append( { at: i, kind: 'assistant', text: `answer ${ n }` }, turn );
	}
	return session;
}

function compactThrough( session: Session, turnId: string ): void {
	const compaction: SessionCompaction = {
		id: 'c1', sessionId: 'session-1', createdAt: 10,
		fromTurnId: 'turn-1', throughTurnId: turnId,
		summary: 'the earlier exchanges', model: 'test', mode: 'on', tokensIn: 0, tokensOut: 0
	};
	session.bindCompactions( [ compaction ] );
	session.transcript.compactThrough( turnId );
}

/** Every itinerary row, flattened out of its turn block. */
function allRows( session: Session ): TranscriptRow[] {
	return session.transcriptTurns().flatMap( ( t ) => t.rows );
}

/** The itinerary row for one tool result, found by its content rather than by an id the row does not
 *  carry — a row is a display projection and deliberately knows nothing about tool_use ids. */
function resultRow( session: Session, n: number ): TranscriptRow {
	const row = allRows( session ).find( ( r ) => r.kind === 'tool-result' && r.text.startsWith( `RESULT ${ n } ` ) );
	if ( !row ) throw new Error( `no itinerary row for RESULT ${ n }` );
	return row;
}

/** Every `tool_result` block the wire actually emits, in order — the ground truth every assertion here is
 *  measured against. */
function wireResults( session: Session ): { id: string; content: string }[] {
	const out: { id: string; content: string }[] = [];
	for ( const message of session.wireMessages() ) {
		if ( typeof message.content === 'string' ) continue;
		for ( const block of message.content ) {
			if ( block.type === 'tool_result' ) out.push( { id: block.tool_use_id, content: block.content } );
		}
	}
	return out;
}

describe( 'Session — which results stub', () => {
	it( 'keeps the last N turns whole and stubs everything older', () => {
		// Five turns, keep three: the first two stub. Written against the constant rather than the number so
		// this test moves with it instead of failing as a false alarm.
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		const stubbed = wireResults( session ).filter( ( r ) => r.content.includes( 'not in context' ) );

		expect( stubbed.map( ( r ) => r.id ) ).toEqual( [ 't1', 't2' ] );
	} );

	it( 'does not disagree with itself at the BOUNDARY', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );

		// t2 is the last stubbed result and t3 the first whole one, and they sit on adjacent turns. An
		// off-by-one here is invisible in a conversation: the model simply loses one more result than it
		// should have, and nothing says so.
		expect( resultRow( session, 2 ).stub ).toBeTruthy();
		expect( resultRow( session, 3 ).stub ).toBeUndefined();
	} );

	it( 'stubs NOTHING when no result log is bound', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		session.bindResultLog( '' );

		// Absence, not failure. A session with nothing spilled behind it has no file to point at, and a stub
		// naming one that does not exist is worse than the result it replaced — so the whole reduction is off
		// rather than degraded. This is also the sessionless-transcript case, which never binds one.
		expect( wireResults( session ).every( ( r ) => r.content.startsWith( 'RESULT' ) ) ).toBe( true );
		expect( allRows( session ).every( ( r ) => r.stub === undefined ) ).toBe( true );
	} );
} );

describe( 'Session — the itinerary and the wire agree', () => {
	it( 'shows the EXACT text the model received, character for character', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		const wire    = wireResults( session );
		const rows    = allRows( session ).filter( ( r ) => r.kind === 'tool-result' );

		// Correlated by ORDER, which is a stronger claim than matching ids would be: nothing is windowed here,
		// so the wire's results and the itinerary's must be the same sequence. If they diverge in count, the
		// projection dropped or duplicated one and that is worth failing on by itself.
		expect( rows ).toHaveLength( wire.length );
		for ( const [ i, row ] of rows.entries() ) {
			// `stub ?? text` is the row's own claim about what rides. A surface that re-worded the stub instead
			// of showing it would pass a "was it stubbed" test and fail this one.
			expect( row.stub ?? row.text ).toBe( wire[ i ].content );
		}
	} );

	it( 'prices a stubbed row as its STUB, so the itinerary and the gauge cannot drift', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );

		expect( resultRow( session, 1 ).tokens ).toBeLessThan( resultRow( session, 5 ).tokens );
		// The invariant, not a sample of it: nothing is windowed or compacted here, so the itinerary's total
		// and the session's own estimate are two projections of the same transcript and must land on the same
		// number. A reduction the wire takes and the gauge does not is a gauge reporting a saving nobody got.
		const itinerary = session.transcriptTurns().reduce( ( sum, t ) => sum + t.tokens, 0 );
		expect( itinerary ).toBe( session.estimateTokens() );
	} );
} );

describe( 'Session — the line number survives a compaction', () => {
	it( 'counts a COMPACTED result in the line map, so later stubs still point at the right line', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		compactThrough( session, 'turn-1' );

		// THE case. The projection is four turns now, so with keep at three only turn-2 stubs — and t2 is the
		// FIRST result that rides while being the SECOND in history. Its line must be 2. Compute the line map
		// on the projection instead of the whole transcript and it reads 1, which is a real line holding a
		// real result that is not this one: a wrong answer delivered confidently, the worst kind.
		expect( resultRow( session, 2 ).stub ).toContain( 'line 2' );
		expect( resultRow( session, 2 ).stub ).toContain( LOG );
	} );

	it( 'does not mark a compacted result as stubbed, because it does not ride at all', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		compactThrough( session, 'turn-1' );

		// A summary stands in for that turn. The row is still in the itinerary — it happened, and the account
		// of what happened is never edited — but calling it "stubbed" would claim it reaches the model in some
		// reduced form, and it does not reach the model at all.
		expect( resultRow( session, 1 ).stub ).toBeUndefined();
		expect( wireResults( session ).map( ( r ) => r.id ) ).not.toContain( 't1' );
	} );
} );
