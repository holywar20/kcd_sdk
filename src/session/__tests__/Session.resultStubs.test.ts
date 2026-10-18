import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { KEEP_TOOL_RESULT_TURNS, type SessionCompaction, type TranscriptRow } from '../TurnEntry';

/**
 * Tool-result stubbing: the turn that ran a tool carries its result whole; every later turn carries a stub
 * naming the LINE of the session's result log where the full output lives. Position decides, not storage.
 * The wire, gauge and itinerary must never disagree. The line number counts all of history, compacted turns
 * included: counting the projection alone points at real lines holding the wrong output.
 */

const LOG = 'C:/userData/tool-results/session-1.jsonl';

/** Each turn runs one tool with its result paired to the call: an orphan is dropped at projection, and every assertion below would pass against nothing. */
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
		summary: 'the earlier exchanges', model: 'test', tokensIn: 0, tokensOut: 0
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

/**
 * Every `tool_result` the wire emits, in order: the ground truth. Content narrows to text on purpose. An
 * image result rides as blocks, and a cast or a stringify would turn a fixture gap into a stubbing failure.
 */
function wireResults( session: Session ): { id: string; content: string }[] {
	const out: { id: string; content: string }[] = [];
	for ( const message of session.wireMessages() ) {
		if ( typeof message.content === 'string' ) continue;
		for ( const block of message.content ) {
			if ( block.type !== 'tool_result' ) continue;
			if ( typeof block.content !== 'string' ) {
				throw new Error(
					`wireResults: ${ block.tool_use_id } carries ${ block.content.length } content block( s ), not text. `
					+ 'A fixture here now returns an image; assert on its blocks explicitly rather than through this helper.'
				);
			}
			out.push( { id: block.tool_use_id, content: block.content } );
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

		// t2 is the last stub and t3 the first whole result; an off-by-one here loses one result silently.
		expect( resultRow( session, 2 ).stub ).toBeTruthy();
		expect( resultRow( session, 3 ).stub ).toBeUndefined();
	} );

	it( 'stubs NOTHING when no result log is bound', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		session.bindResultLog( '' );

		// No bound log means no file to point at; a stub naming a missing file is worse than none, so the reduction is off whole.
		expect( wireResults( session ).every( ( r ) => r.content.startsWith( 'RESULT' ) ) ).toBe( true );
		expect( allRows( session ).every( ( r ) => r.stub === undefined ) ).toBe( true );
	} );
} );

describe( 'Session — the itinerary and the wire agree', () => {
	it( 'shows the EXACT text the model received, character for character', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		const wire    = wireResults( session );
		const rows    = allRows( session ).filter( ( r ) => r.kind === 'tool-result' );

		// Correlated by order: nothing is windowed here, so the wire and itinerary sequences must match exactly.
		expect( rows ).toHaveLength( wire.length );
		for ( const [ i, row ] of rows.entries() ) {
			// `stub ?? text` is the row's own claim about what rides; a re-worded stub would pass a presence test and fail this one.
			expect( row.stub ?? row.text ).toBe( wire[ i ].content );
		}
	} );

	it( 'prices a stubbed row as its STUB, so the itinerary and the gauge cannot drift', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );

		expect( resultRow( session, 1 ).tokens ).toBeLessThan( resultRow( session, 5 ).tokens );
		// Nothing is windowed or compacted here, so the itinerary total must equal the session estimate; a gauge reporting a saving nobody got is the drift.
		const itinerary = session.transcriptTurns().reduce( ( sum, t ) => sum + t.tokens, 0 );
		expect( itinerary ).toBe( session.estimateTokens() );
	} );
} );

describe( 'Session — the line number survives a compaction', () => {
	it( 'counts a COMPACTED result in the line map, so later stubs still point at the right line', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		compactThrough( session, 'turn-1' );

		// t2 is the first result that rides but the second in history: its line must be 2, not the projection's 1.
		expect( resultRow( session, 2 ).stub ).toContain( 'line 2' );
		expect( resultRow( session, 2 ).stub ).toContain( LOG );
	} );

	it( 'does not mark a compacted result as stubbed, because it does not ride at all', () => {
		const session = sessionWithTools( KEEP_TOOL_RESULT_TURNS + 2 );
		compactThrough( session, 'turn-1' );

		// The row stays in the itinerary, but a compacted result reaches the model in no form, so it is not "stubbed".
		expect( resultRow( session, 1 ).stub ).toBeUndefined();
		expect( wireResults( session ).map( ( r ) => r.id ) ).not.toContain( 't1' );
	} );
} );
