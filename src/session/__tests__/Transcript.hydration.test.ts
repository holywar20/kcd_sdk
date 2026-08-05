import { describe, it, expect } from 'vitest';
import { Transcript, type TurnEntry } from '../TurnEntry';

/**
 * Hydration — parsing a stored payload, and the tool-pair invariant the projection enforces.
 *
 * Two properties, both of which used to hold only by luck:
 *
 *   1. `parseEntry` is TOTAL. It returns a typed entry or an `unreadable` one, never nothing. The version
 *      it replaced returned `[]` on any failure and said nothing, so a corrupt row — or a kind written by
 *      a newer build, which is what branch-switching produces — silently shortened the conversation. The
 *      transcript is the account of what happened; a load path that drops rows makes it disagree.
 *   2. Orphaned tool entries never reach the wire. An orphaned `tool_result` is not a smaller request, it
 *      is an INVALID one, and turn atomicity does not prevent it: that protects pairs against WINDOWING,
 *      where a whole turn rides or does not, and says nothing about an entry going missing from inside a
 *      turn that rides. Hydration does exactly that whenever a payload lands unreadable.
 */

const AT = 1234;

function parse( payload: unknown, rowId?: number ): TurnEntry {
	return Transcript.parseEntry( typeof payload === 'string' ? payload : JSON.stringify( payload ), AT, rowId );
}

/** A transcript of one turn holding the given entries — the shape `wireMessages` walks. */
function turnOf( ...entries: TurnEntry[] ): Transcript {
	const t = new Transcript();
	const turn = t.openTurn( 'turn-1', 0 );
	for ( const e of entries ) t.append( e, turn );
	return t;
}

describe( 'Transcript.parseEntry — the valid path', () => {
	it( 'rebuilds a well-formed entry', () => {
		const entry = parse( { kind: 'user', text: 'hello' } );

		expect( entry.kind ).toBe( 'user' );
		expect( ( entry as Extract<TurnEntry, { kind: 'user' }> ).text ).toBe( 'hello' );
	} );

	it( 'takes `at` from the COLUMN, never the payload', () => {
		// The column is where `at` actually lives. A payload carrying a different one must not win.
		expect( parse( { kind: 'user', text: 'x', at: 999 } ).at ).toBe( AT );
	} );

	it( 'takes `rowId` from the COLUMN and ignores a stale one in the payload', () => {
		// `copyTurns` duplicates payload text into rows with DIFFERENT ids, so a payload-borne id is a
		// second answer to a question the row already owns.
		expect( parse( { kind: 'user', text: 'x', rowId: 111 }, 222 ).rowId ).toBe( 222 );
	} );

	it( 'leaves rowId absent when the row has none', () => {
		expect( parse( { kind: 'user', text: 'x' } ).rowId ).toBeUndefined();
	} );

	it( 'accepts an optional field being absent', () => {
		// `isError` is optional on tool-result; requiring it would reject ordinary rows.
		expect( parse( { kind: 'tool-result', toolUseId: 'a', content: 'ok' } ).kind ).toBe( 'tool-result' );
	} );

	it( 'accepts an attachment, which stores a HANDLE and no body', () => {
		const entry = parse( { kind: 'injected-file', path: 'C:/x/a.ts', name: 'a.ts', mediaType: 'text/plain', bytes: 40 } );
		expect( entry.kind ).toBe( 'injected-file' );
	} );

	it( 'rejects an attachment missing its byte count, because the gauge needs it', () => {
		// `bytes` is what lets a live injection be priced without opening the file. Absent, the entry cannot
		// answer what it costs — so it is not a valid attachment.
		const entry = parse( { kind: 'injected-file', path: 'C:/x/a.ts', name: 'a.ts', mediaType: 'text/plain' } );
		expect( entry.kind ).toBe( 'unreadable' );
	} );
} );

describe( 'Transcript.parseEntry — never returns nothing', () => {
	it( 'lands unreadable on invalid JSON', () => {
		const entry = parse( '{ not json' );

		expect( entry.kind ).toBe( 'unreadable' );
		expect( entry.at ).toBe( AT );
	} );

	it( 'lands unreadable when there is no kind discriminant', () => {
		expect( parse( { text: 'orphaned' } ).kind ).toBe( 'unreadable' );
	} );

	it( 'lands unreadable on a REQUIRED field of the wrong type, and says which', () => {
		const entry = parse( { kind: 'tool-call', name: 'read' } ) as Extract<TurnEntry, { kind: 'unreadable' }>;

		// The exact case that used to reach the provider as a 400 with nothing pointing back at the row.
		expect( entry.kind ).toBe( 'unreadable' );
		expect( entry.originalKind ).toBe( 'tool-call' );
		expect( entry.reason ).toContain( 'id' );
	} );

	it( 'names an unknown kind as possibly newer rather than calling it corrupt', () => {
		const entry = parse( { kind: 'document', path: 'x.pdf' } ) as Extract<TurnEntry, { kind: 'unreadable' }>;

		// Branch-switching, not corruption: a build reading a database a later build wrote.
		expect( entry.originalKind ).toBe( 'document' );
		expect( entry.reason ).toContain( 'newer build' );
	} );

	it( 'keeps the raw payload and the rowId, so the row stays repairable', () => {
		const raw = JSON.stringify( { kind: 'tool-call', name: 'read' } );
		const entry = Transcript.parseEntry( raw, AT, 412 ) as Extract<TurnEntry, { kind: 'unreadable' }>;

		// Rejection never deletes. The bytes ride along and the id IS the repair path.
		expect( entry.payload ).toBe( raw );
		expect( entry.rowId ).toBe( 412 );
	} );
} );

describe( 'the unreadable contract — recorded, displayed, never ridden', () => {
	const bad = () => parse( { kind: 'tool-call', name: 'read' }, 412 );

	it( 'never reaches the wire', () => {
		const wire = JSON.stringify( turnOf( { at: 0, kind: 'user', text: 'hi' }, bad() ).wireMessages() );

		expect( wire ).not.toContain( 'unreadable' );
		expect( wire ).not.toContain( 'read' );
	} );

	it( 'DOES reach the itinerary, naming the row so it can be repaired', () => {
		const rows = turnOf( bad() ).turnRows()[ 0 ].rows;

		expect( rows[ 0 ].label ).toContain( '412' );
		expect( rows[ 0 ].text ).toContain( 'tool-call' );
		expect( rows[ 0 ].displayOnly ).toBe( true );
	} );

	it( 'costs nothing', () => {
		// Not a wire kind, so it cannot charge the next turn for something that never rides.
		expect( turnOf( bad() ).estimateTokens() ).toBe( 0 );
		expect( turnOf( bad() ).turnRows()[ 0 ].rows[ 0 ].tokens ).toBe( 0 );
	} );

	it( 'does not take the whole projection down with it', () => {
		// The reason this kind exists rather than a skip: Assert.never THROWS, so an uninterpretable entry
		// reaching a projection would cost the entire wire rather than one row.
		const t = turnOf( { at: 0, kind: 'user', text: 'hi' }, bad(), { at: 2, kind: 'assistant', text: 'bye' } );

		expect( () => t.wireMessages() ).not.toThrow();
		expect( () => t.turnRows() ).not.toThrow();
		expect( t.wireMessages() ).toHaveLength( 2 );
	} );
} );

describe( 'Transcript.reconcilePairs', () => {
	const call   = ( id: string ): TurnEntry => ( { at: 1, kind: 'tool-call',   id, name: 'read', input: {} } );
	const result = ( id: string ): TurnEntry => ( { at: 2, kind: 'tool-result', toolUseId: id, content: 'ok' } );

	it( 'keeps a matched pair', () => {
		expect( Transcript.reconcilePairs( [ call( 'a' ), result( 'a' ) ] ) ).toHaveLength( 2 );
	} );

	it( 'drops a result whose call is missing', () => {
		const kept = Transcript.reconcilePairs( [ result( 'a' ) ] );

		expect( kept ).toEqual( [] );
	} );

	it( 'drops a call whose result is missing', () => {
		expect( Transcript.reconcilePairs( [ call( 'a' ) ] ) ).toEqual( [] );
	} );

	it( 'leaves unpaired kinds completely alone', () => {
		const entries: TurnEntry[] = [ { at: 0, kind: 'user', text: 'hi' }, { at: 3, kind: 'assistant', text: 'bye' } ];

		expect( Transcript.reconcilePairs( entries ) ).toEqual( entries );
	} );

	it( 'reconciles per turn at the PROJECTION — an unreadable call takes its result off the wire', () => {
		// The end-to-end case this exists for: the call hydrated unreadable, so its result would otherwise
		// answer a tool_use that is not in the request.
		const t = turnOf(
			{ at: 0, kind: 'user', text: 'hi' },
			parse( { kind: 'tool-call', name: 'read' }, 412 ),
			result( 'a' )
		);

		expect( JSON.stringify( t.wireMessages() ) ).not.toContain( 'tool_result' );
	} );

	it( 'does NOT reconcile what is stored — the failed turn keeps its trailing call', () => {
		const t = turnOf( { at: 0, kind: 'user', text: 'hi' }, call( 'a' ) );

		// The trailing tool-call of a turn that died mid-loop IS the diagnosis. It must stay in the
		// itinerary while never reaching a provider — which is why reconciliation runs at the projection.
		expect( t.turnRows()[ 0 ].rows.map( ( r ) => r.kind ) ).toContain( 'tool-call' );
		expect( JSON.stringify( t.wireMessages() ) ).not.toContain( 'tool_use' );
	} );

	it( 'does not confuse pairs across separate turns', () => {
		const t = new Transcript();
		const one = t.openTurn( 'turn-1', 0 );
		t.append( call( 'a' ), one );
		const two = t.openTurn( 'turn-2', 1 );
		t.append( result( 'a' ), two );

		// A result in a LATER turn does not answer a call in an earlier one — the provider reads pairs
		// within one assistant/user exchange, so both are orphans.
		expect( JSON.stringify( t.wireMessages() ) ).not.toContain( 'tool_use' );
		expect( JSON.stringify( t.wireMessages() ) ).not.toContain( 'tool_result' );
	} );
} );
