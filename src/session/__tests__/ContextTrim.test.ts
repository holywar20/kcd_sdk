import { describe, it, expect } from 'vitest';
import { contextTrim, fitToWindow, pointResults, KEEP_TOOL_RESULT_LAPS, TRIM_AT_WINDOW_FRACTION, type TrimMessage, type TrimSource } from '../ContextTrim';

/**
 * The trim rule: which tool results ride as pointers once a conversation outgrows its model. Pure, so these
 * cases are its whole contract.
 *  - No declared window, no trim: inventing one would be a confident wrong answer.
 *  - A lap is the unit: half a lap left whole reads as a bug in the tool loop.
 *  - Monotonic: what is pointed stays pointed, or the cached prefix ahead of the cut reprices.
 *  - The newest lap survives any setting; `keepLaps: 0` must still show the model its last call.
 */

const WINDOW = 200_000;
const LINE   = WINDOW * TRIM_AT_WINDOW_FRACTION;

/** One lap: the assistant's calls, then the message carrying their results. `n` results in the same lap. */
function lap( id: string, results = 1 ): TrimMessage[] {
	const calls:   { type: string; tool_use_id?: string }[] = [];
	const answers: { type: string; tool_use_id?: string }[] = [];
	for ( let i = 0; i < results; i++ ) {
		calls.push( { type: 'tool_use' } );
		answers.push( { type: 'tool_result', tool_use_id: results === 1 ? id : `${ id }-${ i }` } );
	}
	return [ { role: 'assistant', content: calls }, { role: 'user', content: answers } ];
}

/** A conversation of `n` laps, opened by a plain user message. */
function conversation( n: number ): TrimMessage[] {
	const out: TrimMessage[] = [ { role: 'user', content: 'do the thing' } ];
	for ( let i = 1; i <= n; i++ ) out.push( ...lap( `call-${ i }` ) );
	return out;
}

describe( 'the trim rule', () => {

	it( 'leaves a conversation under the line whole, and says what it measured', () => {
		const trim = contextTrim( conversation( 12 ), { estimated: LINE - 1, window: WINDOW } );

		expect( [ ...trim.pointed ] ).toEqual( [] );
		expect( trim ).toMatchObject( { estimated: LINE - 1, line: LINE } );
	} );

	it( 'points every result but the last three laps once the conversation is over the line', () => {
		const trim = contextTrim( conversation( 6 ), { estimated: LINE, window: WINDOW } );

		expect( [ ...trim.pointed ] ).toEqual( [ 'call-1', 'call-2', 'call-3' ] );
		expect( KEEP_TOOL_RESULT_LAPS ).toBe( 3 );
	} );

	it( 'counts LAPS, not results — a lap rides or points as one', () => {
		const messages: TrimMessage[] = [
			{ role: 'user', content: 'do the thing' },
			...lap( 'first' ),
			...lap( 'fanned', 3 ),
			...lap( 'third' ),
			...lap( 'fourth' )
		];
		const trim = contextTrim( messages, { estimated: LINE * 2, window: WINDOW } );

		// Four laps, three kept: only the opening one points. Counted per result, the fanned lap would point two
		// of its own three and leave one answer beside a pointer to its sibling.
		expect( [ ...trim.pointed ] ).toEqual( [ 'first' ] );
	} );

	it( 'trims NOTHING for a model that declares no window', () => {
		const trim = contextTrim( conversation( 40 ), { estimated: 1_000_000, window: 0 } );

		expect( [ ...trim.pointed ] ).toEqual( [] );
		expect( trim.line ).toBe( 0 );
	} );

	it( 'only ever grows — what is pointed on one lap is pointed on the next', () => {
		const at6 = contextTrim( conversation( 6 ), { estimated: LINE, window: WINDOW } );
		const at7 = contextTrim( conversation( 7 ), { estimated: LINE + 5_000, window: WINDOW } );

		for ( const id of at6.pointed ) expect( at7.pointed.has( id ) ).toBe( true );
		expect( at7.pointed.size ).toBe( at6.pointed.size + 1 );
	} );

	it( 'keeps the newest lap whole however low `keepLaps` goes', () => {
		const trim = contextTrim( conversation( 4 ), { estimated: LINE, window: WINDOW, keepLaps: 0 } );

		// A model that cannot see the result of the call it just made cannot take its next step.
		expect( [ ...trim.pointed ] ).toEqual( [ 'call-1', 'call-2', 'call-3' ] );
	} );

	it( 'reads a provider-shaped message as readily as the neutral one', () => {
		// Written as a provider sends it, so one rule serves both sides of the connector seam.
		// A mapping step would be a second place to go wrong.
		const messages = [
			{ role: 'user',      content: 'do the thing' },
			{ role: 'assistant', content: [ { type: 'tool_use', id: 'a', name: 'read_thing', input: {} } ] },
			{ role: 'user',      content: [ { type: 'tool_result', tool_use_id: 'a', content: 'rows and rows' } ] },
			{ role: 'assistant', content: [ { type: 'tool_use', id: 'b', name: 'read_thing', input: {} } ] },
			{ role: 'user',      content: [ { type: 'tool_result', tool_use_id: 'b', content: 'more rows' } ] }
		];
		const trim = contextTrim( messages, { estimated: LINE, window: WINDOW, keepLaps: 1 } );

		expect( [ ...trim.pointed ] ).toEqual( [ 'a' ] );
	} );
} );

/** A conversation source with no session behind it — what `fitToWindow` is allowed to ask for, and the
 *  proof that it asks for nothing else. */
function source( weight: number, hasLog = true ): TrimSource {
	return {
		estimateTokens: () => weight,
		resultStubs:    ( ids ) => {
			const out = new Map<string, string>();
			if ( !hasLog ) return out;
			for ( const id of ids ?? [] ) out.set( id, `[pointer for ${ id }]` );
			return out;
		}
	};
}

describe( 'applying the answer', () => {

	it( 'swaps a pointed result and returns every other message BY IDENTITY', () => {
		const messages = conversation( 3 );
		const stubs    = new Map( [ [ 'call-1', '[pointer]' ] ] );

		const out = pointResults( messages, stubs );

		// Identity, not equality: the prefix ahead of a cut must stay byte-identical lap after lap.
		const changed = out.filter( ( m, i ) => m !== messages[ i ] );
		expect( changed ).toHaveLength( 1 );
		expect( changed[ 0 ]!.content ).toEqual( [ { type: 'tool_result', tool_use_id: 'call-1', content: '[pointer]' } ] );
	} );

	it( 'leaves a conversation alone when nothing is pointed', () => {
		const messages = conversation( 3 );

		const out = pointResults( messages, new Map() );

		for ( const [ i, message ] of out.entries() ) expect( message ).toBe( messages[ i ] );
	} );
} );

describe( 'the whole fit', () => {

	it( 'prices, asks and applies — one answer, whoever is asking', () => {
		const messages = conversation( 6 );

		const fit = fitToWindow( source( LINE ), messages, 0, WINDOW );

		expect( fit ).toMatchObject( { estimated: LINE, line: LINE } );
		expect( [ ...fit.pointed ] ).toEqual( [ 'call-1', 'call-2', 'call-3' ] );
		const results = fit.messages.flatMap( ( m ) => typeof m.content === 'string' ? [] : m.content )
			.filter( ( b ) => b.type === 'tool_result' );
		expect( results.filter( ( b ) => String( ( b as { content?: string } ).content ).startsWith( '[pointer' ) ) ).toHaveLength( 3 );
	} );

	it( 'counts the OVERHEAD toward the line — the system layer occupies the same window', () => {
		const messages = conversation( 6 );

		const without = fitToWindow( source( LINE - 1_000 ), messages, 0,     WINDOW );
		const with_   = fitToWindow( source( LINE - 1_000 ), messages, 2_000, WINDOW );

		expect( without.pointed.size ).toBe( 0 );
		expect( with_.pointed.size ).toBe( 3 );
	} );

	it( 'narrows NOTHING when the source has no pointer text to give', () => {
		const messages = conversation( 6 );

		const fit = fitToWindow( source( LINE, false ), messages, 0, WINDOW );

		// A source with no result log cannot point anywhere, and a pointer at nowhere is worse than the result it replaced.
		expect( fit.pointed.size ).toBe( 0 );
		for ( const [ i, message ] of fit.messages.entries() ) expect( message ).toBe( messages[ i ] );
	} );
} );
