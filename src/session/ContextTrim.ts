/**
 * CONTEXT TRIM — which tool results ride as a POINTER once a conversation has outgrown its model.
 *
 * A PURE RULE: no state, no clock, no session, so the same conversation and model always give the same answer and
 * the surface, the gauge and a test can rebuild what was sent. It answers with a SET OF IDS, not a narrowed list,
 * because the wire, the gauge and a view each want something different done with it. Price, ask, apply is
 * `fitToWindow`, so the send and the view cannot disagree. It measures the WHOLE conversation, never the trimmed
 * request, so a result that starts as a pointer stays one and the cached prefix is untouched. It never reads content.
 */

/** How many of the most recent laps keep their tool results whole. Three, as the older-turn rule does: a large default
 *  hides whether the mechanism works. Never zero, since a lap of pointers is one the model cannot act on. */
export const KEEP_TOOL_RESULT_LAPS = 3;

/** Share of a model's window a conversation may fill before older results start riding as pointers. Half, and soft:
 *  the input is an estimate, and the room below the wall absorbs its error. */
export const TRIM_AT_WINDOW_FRACTION = 0.5;

/** The least a trim reads of one block. Structural on purpose: the neutral wire block and a provider's own block both
 *  satisfy it, without importing each other's types. */
export interface TrimBlock {
	type:         string;
	tool_use_id?: string;
}

/** One message as the trim reads it. Both the neutral `WireMessage` and a provider's message satisfy it. */
export interface TrimMessage {
	role:    string;
	content: string | readonly TrimBlock[];
}

export interface TrimInput {
	/** What those messages weigh, priced by whoever prices context. Never estimated in here: a private measure would be
	 *  a second opinion about the send. */
	estimated: number;
	/** The model's effective window. Zero trims NOTHING: inventing a window is worse than leaving the conversation whole. */
	window: number;
	/** Most recent laps that keep their results whole. Defaults to `KEEP_TOOL_RESULT_LAPS`, and is held at one. */
	keepLaps?: number;
}

/** The ids that ride as pointers, and the two numbers that decided it. The numbers reach the trace line, so the
 *  estimator is calibrated against the provider's count in use. */
export interface ContextTrim {
	pointed:   Set<string>;
	estimated: number;
	line:      number;
}

/**
 * Which of these messages' tool results ride as pointers. Empty under the line, with no window, or at three laps or
 * fewer, which is most conversations.
 */
export function contextTrim( messages: readonly TrimMessage[], input: TrimInput ): ContextTrim {
	// No window means no line, and no line means nothing to be over.
	const line    = Math.floor( input.window * TRIM_AT_WINDOW_FRACTION );
	const pointed = new Set<string>();
	if ( line <= 0 || input.estimated < line ) return { pointed, estimated: input.estimated, line };

	// A lap is a message carrying tool results. Count laps, not results: half a lap pointed buys nothing and reads as a bug.
	const laps: string[][] = [];
	for ( const message of messages ) {
		if ( typeof message.content === 'string' ) continue;
		const ids: string[] = [];
		for ( const block of message.content ) {
			if ( block.type === 'tool_result' && typeof block.tool_use_id === 'string' ) ids.push( block.tool_use_id );
		}
		if ( ids.length ) laps.push( ids );
	}

	const keep = Math.max( 1, input.keepLaps ?? KEEP_TOOL_RESULT_LAPS );
	for ( const ids of laps.slice( 0, Math.max( 0, laps.length - keep ) ) ) {
		for ( const id of ids ) pointed.add( id );
	}
	return { pointed, estimated: input.estimated, line };
}

/**
 * What a fit needs from whatever holds the conversation: two methods, which `Session` already has, declared as a shape so
 * this file imports nothing. The fit may ask for what the conversation weighs and the pointer text, and nothing more.
 */
export interface TrimSource {
	estimateTokens(): number;
	resultStubs( ids?: Iterable<string> ): Map<string, string>;
}

/** A fitted send: the messages as they would cross, what decided them, and WHICH results were swapped. Ids rather
 *  than a count, because the wire and a view want different things from the same answer. */
export interface Fitted<Message> {
	messages:  Message[];
	estimated: number;
	line:      number;
	pointed:   Set<string>;
}

/**
 * The pointed results, swapped for their pointer. GENERIC over the message, so one function narrows the neutral wire
 * projection and a provider's request and cannot drift between them. An untouched message is returned BY IDENTITY, so the
 * prefix ahead of the cut stays the same objects.
 *
 * THE BLOCK KIND NEVER CHANGES: a pointer is still a `tool_result` answering its `tool_use`, which keeps a narrowed
 * conversation valid by construction.
 */
export function pointResults<Message extends TrimMessage>(
	messages: readonly Message[],
	stubs:    ReadonlyMap<string, string>
): Message[] {
	if ( !stubs.size ) return [ ...messages ];
	return messages.map( ( message ) => {
		if ( typeof message.content === 'string' ) return message;
		let narrowed = false;
		const content = message.content.map( ( block ) => {
			if ( block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' ) return block;
			const stub = stubs.get( block.tool_use_id );
			if ( stub === undefined ) return block;
			narrowed = true;
			return { ...block, content: stub };
		} );
		return narrowed ? { ...message, content } as Message : message;
	} );
}

/**
 * PRICE, ASK, APPLY — the whole fit, in the order every caller performs it. `overhead` is what else fills the window
 * (the system layer, today), passed in because this file knows messages and ids and nothing else.
 *
 * The estimate covers the WHOLE conversation, never the narrowed result. See the header for why.
 */
export function fitToWindow<Message extends TrimMessage>(
	source:   TrimSource,
	messages: readonly Message[],
	overhead: number,
	window:   number
): Fitted<Message> {
	const estimated = source.estimateTokens() + overhead;
	const trim      = contextTrim( messages, { estimated, window } );
	// The source frames the pointer, and answers with nothing when it has no log to point at: then the conversation
	// crosses whole, since a pointer to a missing file is worse than the result it replaced.
	const stubs = source.resultStubs( trim.pointed );
	return { messages: pointResults( messages, stubs ), estimated, line: trim.line, pointed: new Set( stubs.keys() ) };
}

/**
 * ── THE FITTED SEND, AS A SURFACE READS IT ──
 * Declared here because it crosses to the renderer, and a contract two processes hold needs one declaration. Main builds
 * it; this unit owns its shape.
 */

/** One message as the view reads it — the role, what it says, and whether any of it rides as a pointer. */
export interface SentContextRow {
	role:    string;
	text:    string;
	/** True when a tool result here crosses as a POINTER at the result log. Narrowing is said, not hidden. */
	pointed: boolean;
}

/** The whole answer: the system layer, the message window, and the measurement that decided its shape. */
export interface SentContext {
	/** The model this was fitted to, as a person names it. Empty when the session has no agent or no model
	 *  bound — the projection still stands, it simply was not fitted to anything. */
	model:     string;
	system:    string;
	rows:      SentContextRow[];
	/** The whole-context estimate the fit judged, by the house formula. Not a provider's count, which exists only after a send. */
	estimated: number;
	/** Where narrowing starts. Zero for a model that declares no window: nothing to measure against. */
	line:      number;
	window:    number;
	/** How many tool results ride as a pointer. */
	pointed:   number;
}

/**
 * The measurement alone, for an always-on gauge: a SUBSET of `SentContext`'s fields, same names, off the same fit, so the
 * gauge and the view cannot report two numbers. Not a second rule: its only way to be wrong is the fit being wrong.
 */
export interface ContextPrice {
	/** Untrimmed, as `Fitted.estimated` is: a price measured on the narrowed request would alternate lap by lap. */
	estimated: number;
	/** Where narrowing starts. Zero for a model that declares no window. */
	line:      number;
	window:    number;
	/** How many tool results ride as a pointer. */
	pointed:   number;
}
