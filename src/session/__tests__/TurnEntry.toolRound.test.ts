import { describe, it, expect } from 'vitest';
import { frameToolRound, TOOL_ERROR_CHARS, type TurnEntry } from '../TurnEntry';

/**
 * The standard tool-round shape — the one renderer of a tool call on the compaction path.
 *
 * The property under every case: the detail goes, the IDENTITY and the OUTCOME stay. A round collapses to
 * one line because a call's arguments and a result's body are envelope to a pass being asked what happened,
 * and tool traffic is the most compressible mass a transcript holds.
 *
 * The case worth guarding hardest is the FAILURE. Dropping the body is the natural way to shrink a result,
 * and for an error the body is the outcome — a compacted transcript in which a failure reads as a success
 * teaches the next session a history that did not happen, and compaction is the one pass whose output
 * nobody re-reads against the original.
 */

type Call   = Extract<TurnEntry, { kind: 'tool-call' }>;
type Result = Extract<TurnEntry, { kind: 'tool-result' }>;

function call( name = 'sm_file.read', input: unknown = { path: 'C:/repo/a.ts' } ): Call {
	return { at: 1, kind: 'tool-call', id: 'call-1', name, input };
}

function result( over: Partial<Result> = {} ): Result {
	return { at: 2, kind: 'tool-result', toolUseId: 'call-1', content: 'body', ...over };
}

describe( 'frameToolRound', () => {

	it( 'names the tool and sizes the result, carrying neither the arguments nor the body', () => {
		const line = frameToolRound( call(), result( { content: 'x'.repeat( 900 ) } ) );

		expect( line ).toBe( '[tool sm_file.read — ok, 900 chars returned]' );
		expect( line ).not.toContain( 'C:/repo/a.ts' );
	} );

	it( 'keeps a FAILURE legible, with its reason', () => {
		expect( frameToolRound( call(), result( { content: 'ENOENT: no such file', isError: true } ) ) )
			.toBe( '[tool sm_file.read — FAILED: ENOENT: no such file]' );
	} );

	it( 'CAPS a long reason and flattens it to one line', () => {
		const line = frameToolRound( call(), result( { content: `${ 'e'.repeat( 5_000 ) }\n\tand more`, isError: true } ) );

		// Capped so a rejected request that echoes what it rejected cannot be the largest thing in the
		// summary's input; flattened so one round is one line whatever the tool returned.
		expect( line ).not.toContain( '\n' );
		expect( line.length ).toBeLessThan( TOOL_ERROR_CHARS + 80 );
		expect( line ).toContain( 'FAILED: eee' );
		expect( line ).toContain( '…' );
	} );

	it( 'says so when an error carried no reason at all, rather than trailing off', () => {
		expect( frameToolRound( call(), result( { content: '   ', isError: true } ) ) )
			.toBe( '[tool sm_file.read — FAILED: no reason given]' );
	} );

	it( 'accounts for a call whose result never arrived', () => {
		// A turn that died mid-loop. Silence here reads as the round never having happened.
		expect( frameToolRound( call(), null ) ).toBe( '[tool sm_file.read — called, no result recorded]' );
	} );

	it( 'renders an unpaired RESULT with no name to wear, rather than dropping it', () => {
		expect( frameToolRound( null, result( { content: 'it broke', isError: true } ) ) )
			.toBe( '[tool ( unidentified ) — FAILED: it broke]' );
	} );

	it( 'returns NOTHING when asked about neither half', () => {
		// Absence rather than an invented round — `_turnText` already drops an empty body.
		expect( frameToolRound( null, null ) ).toBe( '' );
	} );

	it( 'emits no "#", so it cannot resemble the house fence markers', () => {
		const lines = [
			frameToolRound( call(), result() ),
			frameToolRound( call(), result( { isError: true } ) ),
			frameToolRound( call(), null )
		];
		for ( const line of lines ) expect( line ).not.toContain( '#' );
	} );
} );
