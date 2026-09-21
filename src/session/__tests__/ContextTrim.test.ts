import { describe, it, expect } from 'vitest';
import { contextTrim, fitToWindow, pointResults, KEEP_TOOL_RESULT_LAPS, TRIM_AT_WINDOW_FRACTION, type TrimMessage, type TrimSource } from '../ContextTrim';

/**
 * THE TRIM RULE — which tool results ride as pointers when a conversation has outgrown its model.
 *
 * The rule is pure, so these are the whole of its contract; nothing downstream can make it behave
 * differently. Four of the cases below are the ones a conversation would never think to try:
 *
 *  - NOTHING TO MEASURE AGAINST. A model that declares no window trims nothing, however large the
 *    conversation. The alternative is inventing a window, which is a confident wrong answer.
 *  - THE LAP IS THE UNIT. A lap rides or points as one. Half a lap left whole hands the model one answer and
 *    a pointer to its sibling, which buys nothing and reads as a bug in the tool loop.
 *  - MONOTONIC. What is pointed stays pointed as the conversation grows. This is the cache: the prefix ahead
 *    of the cut has to be byte-identical lap after lap, and a rule that let a result come back whole would
 *    reprice everything behind it — while looking, from the outside, like it was working.
 *  - THE NEWEST LAP SURVIVES ANY SETTING. `keepLaps: 0` is a caller asking for a model that cannot see the
 *    results of the calls it just made.
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

		// Six laps, three kept: the first three point, and the ones the model is still working from do not.
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

		// FOUR laps, three kept, so only the opening one points. Counted per RESULT the fanned lap would be
		// three of them — pushing the count to six, pointing two of its own three, and handing the model one
		// answer beside a pointer to its sibling.
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
		// The SAME rule serves both sides of the connector seam. Written as a provider would send it — string
		// content on the result block, no import of either type — because that is the shape the wire holds
		// and a rule that needed it mapped first would be a second place the mapping could be wrong.
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

		// The one message that changed is a new object; every other is the same one. The prefix ahead of a
		// cut has to be byte-identical lap after lap, and identity is the cheapest way to see that it is.
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
		// The three oldest laps carry a pointer; the three the model is working from carry their results.
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

		// Over the line, and every message back by identity. A source with no result log cannot point
		// anywhere, and a pointer at nowhere is worse than the result it replaced.
		expect( fit.pointed.size ).toBe( 0 );
		for ( const [ i, message ] of fit.messages.entries() ) expect( message ).toBe( messages[ i ] );
	} );
} );
