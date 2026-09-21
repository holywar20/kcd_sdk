/**
 * CONTEXT TRIM — which tool results ride as a POINTER when a conversation has outgrown the model it is
 * going to.
 *
 * A PURE RULE, and that is the whole of the design. It holds no state, reads no clock, touches no session
 * and does not know a gate exists: hand it the messages about to ride, what they weigh and the window they
 * are going to, and it answers with a set of ids. The same conversation and the same model always give the
 * same answer, so what went over the wire can be rebuilt afterwards from what the session kept — by the
 * surface that shows it, by the gauge that prices it, and by a test, none of which were there when it was
 * sent. An answer that had to be remembered would be an answer only the process that sent it could give.
 *
 * WHY A SET OF IDS RATHER THAN A NARROWED MESSAGE LIST. Three readers want three different things done with
 * it — the wire swaps those bodies for pointers, the gauge prices what that leaves, a view marks the rows —
 * and handing back narrowed messages would serve the first and leave the other two restating the rule. It is
 * the shape `Transcript.stubbedResults` already answers in, for the same reason.
 *
 * WHAT ELSE IS IN THIS FILE, and why it is not a second one. `pointResults` performs the swap and
 * `fitToWindow` composes the three steps every caller performs in the same order — price, ask, apply. The
 * rule alone would have left that sequence written out at each site, and there are two sites in two
 * processes: the Model station fitting a request as it leaves, and the surface rebuilding what left after
 * the fact. Two copies of a four-line sequence is how the send and the view come to disagree about what was
 * sent, which is the one failure this whole unit exists to make impossible. NOTHING HERE IMPORTS ANYTHING:
 * `fitToWindow` takes a `TrimSource` — two methods — rather than a Session, so the rule stays a file with no
 * dependencies and a test can hand it a double.
 *
 * IT MEASURES THE WHOLE CONVERSATION, never the trimmed request. The caller passes the estimate of the
 * messages as the projection produced them, and that is what keeps the answer MONOTONIC inside a turn: a
 * conversation only grows between laps, so a result that starts riding as a pointer goes on riding as one
 * and the cached prefix ahead of the cut is untouched. Measured on the trimmed request instead, the
 * conversation would fall back under the line the moment the trim worked, and the two states would alternate
 * lap by lap — every alternation repricing the prefix.
 *
 * IT IS NOT THE OLDER-TURN RULE. `KEEP_TOOL_RESULT_TURNS` points results by AGE and always: three turns back,
 * whatever they weigh. This one points by SIZE and only once the conversation has outgrown the model,
 * counting LAPS inside a turn rather than turns across a session. The two compose without knowing about each
 * other, because a result both of them point is the same pointer either way.
 *
 * WHAT IT DOES NOT LOOK AT: the content. A result that is already a pointer is pointed again and nothing
 * changes, which is what lets this answer stay a fact about POSITION and SIZE rather than about whatever the
 * projection happened to do first. An error result is pointed like any other — it is small, and the unit
 * that watches for a tool failing the same way repeatedly lives at the Tool station, not here.
 */

/** How many of the most recent LAPS keep their tool results whole. Three, the same small number the
 *  older-turn rule keeps and for the same reason: a large default hides whether the mechanism works at all.
 *  Never zero — a lap whose own results are pointers is a lap the model cannot act on. */
export const KEEP_TOOL_RESULT_LAPS = 3;

/** How much of a model's context window a conversation may occupy before its older results start riding as
 *  pointers. Half, and deliberately soft: the input is an ESTIMATE, and a line with this much room below the
 *  wall absorbs the estimator's error instead of depending on it being right. */
export const TRIM_AT_WINDOW_FRACTION = 0.5;

/** The least a trim needs to see of one block: its kind, and — when it is a tool result — the call it
 *  answers. Structural on purpose, so ONE rule reads the neutral `WireBlock` and a provider's own block
 *  without either importing the other's types, and without a copy being mapped between them for the sake of
 *  a question that only ever asks two fields. */
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
	/** What those messages weigh, priced by whoever prices context. Never estimated in here: a rule with its
	 *  own private measure is a second opinion about the size of the send. */
	estimated: number;
	/** The model's effective context window. Zero — a model that declares none — trims NOTHING: there is
	 *  nothing to measure against, and inventing a window is a worse answer than leaving the conversation
	 *  whole. */
	window: number;
	/** How many of the most recent laps keep their results whole. Defaults to `KEEP_TOOL_RESULT_LAPS`, and is
	 *  held at one however low it is asked to go. */
	keepLaps?: number;
}

/** What the rule answers — the ids that ride as pointers, and the two numbers that decided it. Those two
 *  ride the trace line, which is how the estimator gets calibrated against a provider's own count while it
 *  is being used rather than argued about beforehand. */
export interface ContextTrim {
	pointed:   Set<string>;
	estimated: number;
	line:      number;
}

/**
 * Which of these messages' tool results ride as pointers.
 *
 * Empty whenever the conversation is under the line, the model declares no window, or there are three laps
 * or fewer — which is most conversations, and is why this costs nothing to consult on every send.
 */
export function contextTrim( messages: readonly TrimMessage[], input: TrimInput ): ContextTrim {
	// A MODEL WITH NO WINDOW FALLS OUT HERE, on the same test as a conversation that is simply small: no
	// window means no line, and no line means nothing to be over.
	const line    = Math.floor( input.window * TRIM_AT_WINDOW_FRACTION );
	const pointed = new Set<string>();
	if ( line <= 0 || input.estimated < line ) return { pointed, estimated: input.estimated, line };

	// A LAP IS A MESSAGE CARRYING TOOL RESULTS — the answer to one assistant message's calls. Laps are
	// counted rather than results so that a lap rides or points as ONE: half a lap left whole is a model
	// holding one answer and a pointer to its sibling, which buys nothing and reads as a bug.
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
 * WHAT A FIT NEEDS FROM THE THING THAT HOLDS THE CONVERSATION. Two methods, both of which `Session`
 * already has, declared here as a shape rather than imported as a class so this file goes on importing
 * nothing. It also says exactly what the fit is allowed to ask for: what the conversation weighs, and the
 * pointer text for a set of results. Not the transcript, not the policies, not the log.
 */
export interface TrimSource {
	estimateTokens(): number;
	resultStubs( ids?: Iterable<string> ): Map<string, string>;
}

/** A fitted send: the messages as they would cross, what decided them, and WHICH results were swapped.
 *  The ids rather than a count, because the two readers want different things from the same answer — the
 *  wire writes how many on a trace line, a view marks the rows that carry one. */
export interface Fitted<Message> {
	messages:  Message[];
	estimated: number;
	line:      number;
	pointed:   Set<string>;
}

/**
 * The pointed results, swapped for their pointer.
 *
 * GENERIC OVER THE MESSAGE, and that is the point: the same function narrows the neutral wire projection
 * and a provider's own request, hands each caller back its own type, and cannot drift between them. A
 * message nothing touched is returned BY IDENTITY, so the prefix ahead of the cut is the same objects as
 * well as the same bytes, and a reader can see at a glance how little was rewritten.
 *
 * THE BLOCK KIND NEVER CHANGES. A pointer is still a `tool_result` answering its `tool_use`, which is what
 * keeps a narrowed conversation valid by construction rather than by a rule someone has to remember.
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
 * PRICE, ASK, APPLY — the whole fit, in the one order every caller performs it.
 *
 * `overhead` is what else occupies the window and is not in these messages — the system layer, today.
 * Passed in rather than found here because this file knows about messages and ids and deliberately nothing
 * else; a fit that went looking for a system prompt would be a fit with an opinion about what a request is
 * made of.
 *
 * The estimate covers the WHOLE conversation as the source prices it, never the narrowed result — see the
 * rule above for why that is what keeps the answer monotonic inside a turn.
 */
export function fitToWindow<Message extends TrimMessage>(
	source:   TrimSource,
	messages: readonly Message[],
	overhead: number,
	window:   number
): Fitted<Message> {
	const estimated = source.estimateTokens() + overhead;
	const trim      = contextTrim( messages, { estimated, window } );
	// THE SOURCE FRAMES THE POINTER. It owns the log path and the line numbers, and it answers with NOTHING
	// when it has no log to point at — in which case the conversation crosses whole, which is the right
	// answer: a pointer at a file that does not exist is worse than the result it replaced.
	const stubs = source.resultStubs( trim.pointed );
	return { messages: pointResults( messages, stubs ), estimated, line: trim.line, pointed: new Set( stubs.keys() ) };
}

/**
 * ── THE FITTED SEND, AS A SURFACE READS IT ──
 * Declared here rather than beside the main-side builder because it crosses to the renderer, and a
 * contract two processes hold needs one declaration or it is two contracts. The BUILDING of it is main's
 * ( it needs the agent's system layer and the model registry ); the SHAPE of it belongs to this unit,
 * which is the thing that decided what rides.
 */

/** One message as the view reads it — the role, what it says, and whether any of it rides as a pointer. */
export interface SentContextRow {
	role:    string;
	text:    string;
	/** True when a tool result in this row crosses as a POINTER at the result log rather than as its own
	 *  output. What was narrowed is said, not hidden: a row the model got less of than the transcript shows
	 *  is the one thing this view can say that the turn log cannot. */
	pointed: boolean;
}

/** The whole answer: the system layer, the message window, and the measurement that decided its shape. */
export interface SentContext {
	/** The model this was fitted to, as a person names it. Empty when the session has no agent or no model
	 *  bound — the projection still stands, it simply was not fitted to anything. */
	model:     string;
	system:    string;
	rows:      SentContextRow[];
	/** The whole-context estimate the fit judged — the conversation plus the system layer, by the house
	 *  formula. NOT a provider's count, which exists only after a send; the trace line carries that one. */
	estimated: number;
	/** Where narrowing starts. Zero for a model that declares no window: nothing to measure against. */
	line:      number;
	window:    number;
	/** How many tool results ride as a pointer. */
	pointed:   number;
}
