import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import { Assert } from '../core/Assert';
import { type SlotMode } from '../primitives/types';

/**
 * TurnEntry / Turn / Transcript — the typed, sequential account of what happened in a session,
 * carried on the fat Session as the DYNAMIC half of the wire ( the Agent owns the stable half ).
 *
 * The model: a Session holds an ordered list of TURNS; each Turn holds an ordered list of typed
 * ENTRIES ( the itinerary of everything that happened — user text, tool calls + results, injected
 * files, the assistant answer ). One typed union, TWO projections: to the WIRE ( wireMessages() →
 * neutral message blocks a connector maps to its provider format ) and to the INSPECTOR ( rows() →
 * a flat, ordered itinerary ). It is the @kcd/core promotion of the main-side TurnRecord's
 * { at, kind, payload } shape into typed variants ( that class predicted this move ).
 *
 * The variant set was the deliberate BARE MINIMUM — user, assistant, tool-call, tool-result,
 * injected-file. There is no injected-memory kind: a memory injection IS the result of a tool
 * call, so it arrives as a tool-result. `thinking` is a NEARLY display-only entry: rendered in the
 * inspector for insight into the agent's reasoning, and re-projected to the wire ONLY inside the
 * LIVE turn's tool loop, and only when the provider SIGNED it. Anthropic requires that a continued
 * tool loop replay the assistant message carrying the tool_use with its thinking blocks intact and
 * unmodified — without that, round 2 of every tool loop 400s. HISTORY still carries no scratchpad:
 * once a turn is finished, the reasoning that led to it is discardable and stops riding.
 *
 * `image` reverses "text-only" ( ratified 2026-07-20 ): context is not pure text, and an image
 * dropped into the flow was riding at a zero-token estimate, invisible and mispriced. It is the
 * reference shape for every NON-TEXT kind ( document / PDF is the next follower — prove the pattern
 * once, reuse it ): it carries its own bytes inline ( like injected-file carries its text ), so it
 * self-displays ( a data URL ) and self-prices ( by pixel area, not chars÷4 — see estimateImageTokens ).
 *
 * Node-free ( @kcd/core ): no @anthropic-ai/sdk import. wireMessages() returns the neutral WireMessage
 * shape below, mirror-shaped to the Anthropic block union so the orchestrator's map is near-pass-through
 * while the transcript itself stays provider-agnostic ( model is a commodity ).
 */

/** The stable envelope every entry carries — a stamp for the time-ordered itinerary. Ordering within
 *  a turn is array order; `at` is the display timestamp ( and the persisted-row field Phase 4 hydrates ). */
interface EntryBase {
	at: number;
}

/** One typed thing that happened. Discriminated on `kind`. The wire kinds ride the request every
 *  turn; `thinking` rides only inside the LIVE turn's tool loop, and only when SIGNED.
 *
 *  `signature` on the thinking arm is the PROVIDER'S verification token for that block: present ⇒
 *  the provider will accept the block back verbatim, so it is replayable; absent or empty ⇒
 *  display-only. It is optional because not every producer has one — openai-compat manufactures a
 *  thinking block with `signature: ''` ( a non-Anthropic model has nothing to verify against ), and
 *  a hydrated historical entry has none either. */
export type TurnEntry = EntryBase & (
	| { kind: 'user';          text: string }
	| { kind: 'assistant';     text: string }
	| { kind: 'tool-call';     id: string; name: string; input: unknown }
	| { kind: 'tool-result';   toolUseId: string; content: string; isError?: boolean }
	| { kind: 'injected-file'; path: string; name: string; text: string }
	| { kind: 'image';         mediaType: string; data: string; name?: string; path?: string; width?: number; height?: number }
	| { kind: 'thinking';      text: string; signature?: string }
);

/** The discriminant values that count as the session's STANDING context cost — what `estimateTokens()`
 *  prices and what the inspector charges a row for. `thinking` is deliberately absent EVEN THOUGH it can
 *  now ride: the provider strips thinking from history, so a thinking entry is never part of what the
 *  NEXT turn pays for. It rides once, inside its own turn's tool loop, and then stops. Do not "fix" this
 *  by adding 'thinking' here — that would charge the session forever for a block it sent once. */
const WIRE_KINDS: ReadonlySet<TurnEntry[ 'kind' ]> = new Set( [ 'user', 'assistant', 'tool-call', 'tool-result', 'injected-file', 'image' ] );

/** One turn — a user prompt and everything that answered it, as an ordered entry list. `id` is stable
 *  for the life of the turn ( the dispatch traceId once persisted; a synthetic id for a live turn ). */
export interface Turn {
	id: string;
	startedAt: number;
	entries: TurnEntry[];
	/**
	 * Does this turn ride the next request — THE flag every projection reads, and the whole window model.
	 *
	 * Default TRUE, and that default is load-bearing twice over. A turn is born included, so the turn
	 * currently being dispatched rides by construction rather than by racing an id into a set before the
	 * request goes out. And absence means INCLUDED, so the failure direction is "sent one turn more than
	 * intended" rather than "silently sent nothing" — the window used to be a set of ids held on the
	 * policy, where a set that named nothing and a set that deliberately excluded everything were the
	 * same value.
	 */
	include: boolean;
	/**
	 * Is this turn covered by a compaction. A STATE DESCRIPTOR and nothing more: it guards the mode
	 * switch's clear ( which never re-includes a compacted turn ) and disables the manual toggle, and the
	 * UI reads it to explain why a turn is dark. NOTHING projects off it — `include` is already false and
	 * stays false, so giving this flag a second meaning is exactly how the two would drift apart.
	 *
	 * DERIVED at bind time from the compaction records, never persisted as an independent truth: the
	 * compaction's own `throughTurnId` is the source, and a second stored copy of "is this covered" is one
	 * that goes stale the first time a compaction is deleted.
	 */
	compacted: boolean;
}

/**
 * Which turns ride the wire on the NEXT request — the MODE, not the membership. The membership lives on
 * the turns themselves ( `Turn.include` ); this says how those flags get written and how the projection
 * reads them.
 *
 * `all` — every included turn · `lastN` — the trailing N of them ( a turn already IS a prompt plus
 * everything that answered it, so this needs no exchange-grouping scaffolding ) · `manual` — every
 * included turn, with the flags handed to the user to tune per turn.
 *
 * The three are EXCLUSIVE, and switching between them is what CLEARS the flags back to what the mode
 * says ( skipping compacted turns, which never come back ). That is the whole reason this stays a mode
 * rather than becoming a free-composing lens over per-turn flags: without an exclusive switch, forty
 * turns of hand-tuning needs a reset control to escape, and per-turn state accumulates in a shape the
 * user can't see.
 *
 * `manual` deliberately carries NO payload. It used to name turn ids, which is what let the renderer's
 * half-turn ids ( `${traceId}-u` ) reach main's whole-turn ids and window the wire down to nothing. A
 * mode that names no one cannot name the wrong one.
 *
 * Changing a policy still never deletes history: the transcript keeps every turn, and the flags decide
 * only what the next `wireMessages()` projects.
 */
export type RetentionPolicy =
	| { kind: 'all' }
	| { kind: 'lastN'; n: number }
	| { kind: 'manual' };

/**
 * Whether a session compacts itself, and when. The second POLICY — and the first one an AGENT drives
 * rather than code: crossing the threshold hands the transcript to the house agent, which writes a
 * structured summary that lands as a turn in turn order and narrows the window to itself.
 *
 * `enabled` is the switch ( off = the transcript is never compacted, whatever its size ). `threshold` is
 * the input-token count a completed turn must cross to trigger one; a manual press ignores it entirely.
 * Like retention, this NEVER deletes: compaction is a windowing decision over a transcript that stays
 * whole on disk.
 */
export type CompactionPolicy = { enabled: boolean; threshold: number };

/**
 * Every policy acting on one session's context, by name.
 *
 * A POLICY is anything that manipulates what rides the next request. It may be programmatic and
 * declarative ( `retention` — a pure rule over the turn list ) or agent-driven ( `compaction` — a house
 * agent writing a summary ). They live in one named bag rather than as loose fields so that the third
 * and fourth are additive: a new policy is an entry here plus the code that reads it, never a reshape
 * of the session record.
 */
export type SessionPolicies = {
	retention:  RetentionPolicy;
	compaction: CompactionPolicy;
};

/**
 * One COMPACTION of a session's transcript, as both processes read it — a structured summary standing in
 * for the turns it covers. The wire twin of main's `session_compactions` row.
 *
 * `throughTurnId` carries the window rule: a compaction covers the PREFIX of the transcript up to and
 * including that turn ( a DB turn id, i.e. an exchange's traceId — never a renderer-synthetic id, which
 * is regenerated on every reload ). `fromTurnId` is what the pass actually READ, which diverges the
 * moment a second compaction reads the first one plus what followed; it feeds display, never the window.
 *
 * `mode` is the SlotMode three-state, and `'off'` is the one that matters: an inert compaction stays in
 * the timeline as history while the raw turns ride again. Nothing here ever deletes a turn.
 */
/**
 * How many completed EXCHANGES a session needs before compacting it is worth doing. Below this the
 * summary would cost more tokens than the turns it replaced, and the user would be paying a model call
 * to make their context bigger.
 *
 * Lives here so BOTH sides read the same number: the renderer disables the button below it, and the
 * service refuses below it. Two gates, one constant — the alternative is a button that enables at four
 * and a service that refuses at five.
 */
export const MIN_COMPACTION_TURNS = 4;

export interface SessionCompaction {
	id:            string;
	sessionId:     string;
	createdAt:     number;
	fromTurnId:    string;
	throughTurnId: string;
	summary:       string;
	model:         string;
	mode:          SlotMode;
	tokensIn:      number;
	tokensOut:     number;
}

// ── The neutral wire currency ( @kcd/core, SDK-free ) ──────────────────────────────────────────

/** A content block, mirror-shaped to the Anthropic block union so the orchestrator maps 1:1 ( or passes
 *  through ) at the connector seam — the ONLY place a provider format is spoken. */
export type WireBlock =
	| { type: 'text';        text: string }
	| { type: 'thinking';    thinking: string; signature: string }
	| { type: 'tool_use';    id: string; name: string; input: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
	| { type: 'image';       mediaType: string; data: string };

/** One message as the transcript projects it — role plus either plain text or a block list. */
export interface WireMessage {
	role: 'user' | 'assistant';
	content: string | WireBlock[];
}

/**
 * How a row PRESENTS — an icon and a colour token, carried ON the row rather than looked up by every
 * surface that draws one ( Bryan, 2026-07-28, the Godot resource pattern: attach the render-side data to
 * the data object, hand the UI a completed object, and every surface renders it the same ).
 *
 * Three surfaces already draw these rows — the chat's turn itinerary, the inspector's Turns folder, and
 * the reader drawer's digest — and each was about to grow its own private kind→icon/hue table. One
 * drifting copy per surface is exactly the failure this kills.
 *
 * `color` is the NAME of a CSS custom property, not `var( … )`: naming the shared token is a vocabulary
 * decision the model can legitimately own, whereas emitting CSS syntax from the SDK is not. The renderer
 * wraps it.
 *
 * Being per-ROW and not per-KIND is the point — it lets an instance differ. A FAILED tool result is the
 * proof: same kind, different icon and colour, decided where the `isError` flag actually lives.
 */
export interface RowDisplay {
	/** Icon-library key ( see the renderer's icon lib ). */
	icon: string;
	/** A CSS custom-property NAME — `'--thinking'`, `'--accent'`, … The renderer wraps it in `var()`. */
	color: string;
}

/** One inspector itinerary row — a flat, display-ready view of an entry ( thinking included ), carrying
 *  its self-priced wire token weight ( 0 for the display-only thinking row ). The renderer formats;
 *  this is the currency the Turns folder reads. */
export interface TranscriptRow {
	at: number;
	kind: TurnEntry[ 'kind' ];
	/** A one-line label for the row — "user", "→ tool weather", "tool result", "file notes.md", … */
	label: string;
	/** The entry's body text as the itinerary shows it ( the file text, the tool input, the answer ). */
	text: string;
	/** Wire token weight — 0 for a display-only ( thinking ) row, else the entry's projected cost. */
	tokens: number;
	/** True for the display-only kinds that never ride the wire ( thinking ). */
	displayOnly: boolean;
	/** Icon + colour token for this row — see RowDisplay. Every surface that draws a row reads this
	 *  rather than keeping its own kind→look table. */
	display: RowDisplay;
	/** For a NON-TEXT row ( image ), a self-contained display source the inspector renders inline as a
	 *  thumbnail — the same bytes that ride the wire, so the itinerary stays a flat row list without the
	 *  renderer re-reading anything. Absent on text rows. */
	media?: { mediaType: string; data: string; width?: number; height?: number };
}

/** One TURN as the inspector shows it — a single block carrying the entries that happened inside it.
 *  The display currency matches the MODEL ( a Session holds Turns; a Turn holds entries ), rather than
 *  flattening both levels away: a turn is the unit a user reasons about ( "what happened when I asked
 *  that?" ) and the unit the window policy operates on, so the display should not pretend it is a
 *  featureless stream of entries. */
export interface TranscriptTurn {
	id: string;
	/** Epoch ms the turn opened — the block's timestamp, and the honest answer to "when did this happen". */
	startedAt: number;
	/** Everything that happened inside this turn, in order ( thinking included ). */
	rows: TranscriptRow[];
	/** The turn's whole wire weight — the sum of its wire-bearing rows. */
	tokens: number;
}

/** How an injected file frames into the wire as a user message — a brief marker so the model reads it
 *  as pinned reference material, not as the user's own words. */
function frameFile( name: string, text: string ): string {
	return `[injected file — ${ name }]\n${ text }`;
}

/**
 * How a compaction frames into the wire — a marked REPORT about the conversation, never a transcript of
 * it. The framing says "summary" on purpose: a summary of turns that were both roles, dropped in unmarked,
 * is how a model comes to treat a paraphrase of its own past output as something it actually said — and a
 * paraphrase asserted with the confidence of a verbatim quote is exactly the failure compaction is most
 * likely to cause.
 *
 * Exported because BOTH processes frame the same artifact — main projects it onto the wire, the renderer
 * prices and previews it. One definition, or the preview quietly costs a different number than the send.
 */
export function frameCompaction( summary: string ): string {
	return '[compacted summary of the earlier conversation — a REPORT about what happened, not a transcript'
		+ ' of it. Details here are paraphrased and may have lost exact wording; re-read source files rather'
		+ ' than trusting quotations below.]\n\n'
		+ summary
		+ '\n\n[end compacted summary]';
}

/** Anthropic prices an image by pixel AREA — roughly ( width × height ) / 750 tokens — NOT by byte count
 *  or chars÷4, so a large screenshot and a small icon cost wildly different amounts. When dimensions are
 *  unknown ( not yet measured at attach time ) we fall back to a single conservative constant near the
 *  per-image ceiling, so an unmeasured image never reads as free. This is the non-text sibling of
 *  KCDPrimitive._estimateTokens: the cheap, always-available estimate the budget UI runs on. */
const IMAGE_TOKENS_PER_PIXEL = 1 / 750;
const IMAGE_FALLBACK_TOKENS  = 1600;
function estimateImageTokens( width?: number, height?: number ): number {
	if ( width && height ) return Math.max( 1, Math.round( width * height * IMAGE_TOKENS_PER_PIXEL ) );
	return IMAGE_FALLBACK_TOKENS;
}

/**
 * Transcript — the ordered turn list plus its projections. The @kcd/core promotion of the main-side
 * TurnRecord: it appends ( in-flight ), queries, and projects to the wire and to the inspector. A
 * Session carries exactly one; it is non-persisted object state, rebuilt on arrival via bindTranscript.
 */
export class Transcript {

	private turns: Turn[];

	constructor( turns: Turn[] = [] ) {
		this.turns = turns;
	}

	static empty(): Transcript {
		return new Transcript( [] );
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	/** The raw ordered turn list — what the Turns inspector folder iterates. The ARRAY is a copy, so a
	 *  reader can't add, remove, or reorder turns; the Turn objects in it are the LIVE ones, so
	 *  `turn.entries` IS the transcript's entry list and pushing onto it edits the transcript. Shared by
	 *  convention, not sealed by construction: the one caller reads a finished turn's entries out on every
	 *  completed turn, and deep-cloning that path to buy a guarantee nobody's call site needs would cost
	 *  more than the guarantee is worth. Treat what comes back as read-only. */
	allTurns(): Turn[] {
		return [ ...this.turns ];
	}

	isEmpty(): boolean {
		return this.turns.length === 0;
	}

	/**
	 * This transcript narrowed to the turns a policy admits — a PURE query returning a NEW Transcript
	 * over the kept turns. Nothing is mutated and nothing is dropped from the original: the policy
	 * decides what rides the next request, it does not edit history ( the standing ruling ). Callers
	 * project the result ( `wireMessages()` / `estimateTokens()` ); the unwindowed original still answers
	 * `rows()`, because the inspector's itinerary shows everything that happened.
	 */
	windowed( policy: RetentionPolicy ): Transcript {
		const included = this.turns.filter( ( t ) => t.include );
		// lastN — the trailing n of the INCLUDED turns, so "last 5" is five turns that actually ride rather
		// than five slots a compaction already emptied. n <= 0 windows to nothing rather than silently
		// meaning "all".
		if ( policy.kind === 'lastN' ) return new Transcript( policy.n <= 0 ? [] : included.slice( -policy.n ) );
		// `all` and `manual` read identically here — they differ in who WROTE the flags ( the mode switch
		// recomputes them; manual hands them to the user ), never in how the projection reads them.
		return new Transcript( included );
	}

	/**
	 * This transcript with the active summary put in FRONT of it — a PURE query exactly as `windowed` is:
	 * a new Transcript, nothing mutated and nothing dropped from the original. Compose it after
	 * windowed( retention ), which reads naturally rather than because the order is load-bearing: the turns
	 * this summary covers already left, at `compactThrough()` time, and cannot come back.
	 *
	 * The NEWEST active compaction wins — an older one covers a prefix of what the newer one covers, since
	 * the newer pass read the older summary plus everything after it. That is what makes compacting twice
	 * compose instead of conflict.
	 *
	 * `mode: 'off'` skips a compaction, and what that MEANS has changed with the flag model: the summary
	 * stops riding, and the span it covered stays gone rather than coming back. An inert compaction is a
	 * deliberate "drop this whole stretch", not an undo — a compacted turn is history, not context, and
	 * nothing re-includes it.
	 *
	 * The summary rides as a synthetic USER turn: it stands in for turns that were BOTH roles, and
	 * attributing it to the assistant would have the model reading a paraphrase as its own verbatim words.
	 * Synthetic because it exists only HERE, in the throwaway projection — the bound transcript keeps every
	 * real turn, so `turnRows()` still shows what actually happened.
	 */
	compacted( compactions: SessionCompaction[] ): Transcript {
		const active = compactions
			.filter( ( c ) => c.mode !== 'off' )
			.sort( ( a, b ) => a.createdAt - b.createdAt );
		const newest = active[ active.length - 1 ];
		if ( !newest ) return new Transcript( [ ...this.turns ] );
		// No prefix is cut here any more. The turns a summary covers were marked `include: false` once, by
		// compactThrough(), so `windowed()` has already dropped them before this runs — there is nothing
		// left to re-derive and nothing to pay for twice. What used to be an id-match plus a
		// timestamp fallback ( to stay honest when the covered turn wasn't here to cut ) is now answered by
		// each turn carrying its own flag. This method's whole remaining job is to put the summary in front.
		const summary: Turn = {
			id:        `compaction-${ newest.id }`,
			startedAt: newest.createdAt,
			entries:   [ { at: newest.createdAt, kind: 'user', text: frameCompaction( newest.summary ) } ],
			include:   true,
			compacted: false,
		};
		return new Transcript( [ summary, ...this.turns ] );
	}

	// ── Appends ( in-flight — the orchestrator lands entries here as a turn runs ) ──

	/** Open a fresh turn and return it — the in-flight appender pushes entries onto it as rounds resolve.
	 *  Born INCLUDED and uncompacted, which is what makes the turn being dispatched right now ride without
	 *  anyone having to say so: whether the current turn is in the window was never a policy question. */
	openTurn( id: string, startedAt: number ): Turn {
		const turn: Turn = { id, startedAt, entries: [], include: true, compacted: false };
		this.turns.push( turn );
		return turn;
	}

	/**
	 * Append one entry — onto the TURN the caller holds, or, when none is given, onto the last open turn
	 * ( opening an anonymous one if there is none — a defensive fallback for a caller that appends without
	 * opening ).
	 *
	 * Passing the `openTurn()` result is what makes a wrong-turn append unrepresentable. Two turns running
	 * concurrently against ONE session ( a room seat beside the chat surface, two Constellation steps ) both
	 * see the same "last turn", so the second turn's entries landed on the first turn's object. Nothing
	 * main-side enforces one-at-a-time: the renderer's `pending` flag is a chat-surface guard and
	 * `Session.turnStatus` is advisory.
	 */
	append( entry: TurnEntry, turn?: Turn ): void {
		const target = turn ?? this.turns[ this.turns.length - 1 ] ?? this.openTurn( `t${ this.turns.length + 1 }`, entry.at );
		target.entries.push( entry );
	}

	// ── Compaction ( the covered prefix is marked once, here ) ──

	/**
	 * Mark every turn through `throughTurnId` ( INCLUSIVE ) as compacted — `compacted: true` and
	 * `include: false`, set together, in the one place that sets either. A summary stands in for them from
	 * now on, and they never ride again: a compacted turn is history, not context. The mode switch's clear
	 * skips them and the manual toggle refuses them, so this is a one-way door by design.
	 *
	 * Both flags move here rather than at two call sites because they are one fact said twice — a turn
	 * marked compacted but still included would ride alongside the summary that replaced it, paying for
	 * the same history twice, and the inverse would go dark with nothing on screen explaining why.
	 *
	 * Returns how many turns it marked. 0 means the id names no turn in this transcript ( its exchange was
	 * deleted from the DB ) — the caller decides what that is worth. This neither guesses at a prefix nor
	 * throws: guessing is what the old timestamp fallback did, and it existed only because the window was
	 * re-derived on every projection instead of being recorded once, here.
	 */
	compactThrough( throughTurnId: string ): number {
		const at = this.turns.findIndex( ( t ) => t.id === throughTurnId );
		if ( at === -1 ) return 0;
		for ( const turn of this.turns.slice( 0, at + 1 ) ) {
			turn.compacted = true;
			turn.include   = false;
		}
		return at + 1;
	}

	// ── The window flags ( every write to `include` goes through one of these two ) ──

	/**
	 * Flip ONE turn's window flag — the manual toggle's write. Returns false when the id names no turn,
	 * and when it names a COMPACTED one: a compacted turn is history and nothing re-includes it. That
	 * refusal lives HERE, beside the flag pair, rather than in whichever surface happens to offer the
	 * control — an invariant a caller has to remember is one a second caller will forget.
	 */
	setInclude( turnId: string, include: boolean ): boolean {
		const turn = this.turns.find( ( t ) => t.id === turnId );
		if ( !turn || turn.compacted ) return false;
		turn.include = include;
		return true;
	}

	/**
	 * Reset the window to what a MODE says — the mode switch's CLEAR, and the reason there is no "clear
	 * window" button anywhere in the UI.
	 *
	 * `keep` null opens everything back up ( `all` / `lastN`, whose rules take over at projection ). A set
	 * FREEZES exactly those ids ( entering `manual`, seeded from the window the user can currently see, so
	 * the switch itself changes nothing until they toggle something ).
	 *
	 * COMPACTED turns are never touched, in either direction. That exemption is what lets forty turns of
	 * hand-tuning be escaped in one click without also undoing a compaction the user paid a model turn for.
	 */
	resetWindow( keep: Set<string> | null ): void {
		for ( const turn of this.turns ) {
			if ( turn.compacted ) continue;
			turn.include = keep ? keep.has( turn.id ) : true;
		}
	}

	// ── Projection: to the WIRE ────────────────────────────────────────────────

	/**
	 * Project the transcript to the neutral message list a connector sends. Walks every turn's entries in
	 * order and batches them into alternating role messages: assistant text + its tool-calls become ONE
	 * assistant message ( text block then tool_use blocks ); tool-results become a following user message
	 * of tool_result blocks; user text and injected files are user messages. `thinking` rides only when
	 * BOTH gates pass — a non-empty provider `signature` AND membership in the LIVE ( last ) turn;
	 * otherwise it is skipped.
	 *
	 * A replayed thinking block must be the FIRST block of its assistant message. That falls out for free
	 * rather than needing a sort: the orchestrator records the provider's content in the order it was sent
	 * ( thinking first ), `_appendBlock` appends in order, and inside a tool loop every assistant response
	 * is preceded by a USER message ( the prior round's tool-results, or the turn's user text ), so the
	 * thinking entry always OPENS a fresh assistant message.
	 *
	 * No windowing here: it projects whatever turns are bound. The policy that decides WHICH turns ride
	 * ( RetentionPolicy ) is applied by the caller binding only the in-window set — a Phase 3 seam.
	 *
	 * `opts.clearToolResultsBefore` ( ms ) stubs any tool-result older than the cutoff — the cheapest
	 * context-engineering lever ( operate on the transcript, don't just append ); the full text stays on
	 * the entry for the inspector. Dormant when absent.
	 */
	wireMessages( opts?: { clearToolResultsBefore?: number } ): WireMessage[] {
		const messages: WireMessage[] = [];
		const liveTurn = this.turns[ this.turns.length - 1 ];
		for ( const turn of this.turns ) {
			const isLiveTurn = turn === liveTurn;
			for ( const entry of turn.entries ) {
				switch ( entry.kind ) {
					case 'thinking':
						// TWO gates, both required. SIGNED: the provider's own verification token, so it
						// will accept the block back verbatim ( openai-compat manufactures one with
						// signature: '', so a local model's reasoning is never echoed — no special case
						// needed ). LIVE TURN: a signature is model-family bound and Starmind lets the
						// model change between turns, so replaying a historical block to a different
						// model would manufacture the very 400 this exists to fix.
						if ( entry.signature && isLiveTurn ) this._appendBlock( messages, 'assistant', { type: 'thinking', thinking: entry.text, signature: entry.signature } );
						break;
					case 'user':
						messages.push( { role: 'user', content: entry.text } );
						break;
					case 'injected-file':
						this._appendBlock( messages, 'user', { type: 'text', text: frameFile( entry.name, entry.text ) } );
						break;
					case 'image':
						// A non-text user injection — its bytes ride as an image block ( user role, like a file ).
						// The connector maps { mediaType, data } to the provider's nested source shape.
						this._appendBlock( messages, 'user', { type: 'image', mediaType: entry.mediaType, data: entry.data } );
						break;
					case 'assistant':
						this._appendBlock( messages, 'assistant', { type: 'text', text: entry.text } );
						break;
					case 'tool-call':
						this._appendBlock( messages, 'assistant', { type: 'tool_use', id: entry.id, name: entry.name, input: entry.input } );
						break;
					case 'tool-result': {
						// Seed #1 — tool-result clearing: a result older than the cutoff stops re-riding as raw
						// text ( it stays whole on the entry for the inspector; only the WIRE projection stubs it ).
						// Dormant unless a caller passes a cutoff — identical to no option otherwise.
						const cleared = opts?.clearToolResultsBefore != null && entry.at < opts.clearToolResultsBefore;
						this._appendBlock( messages, 'user', { type: 'tool_result', tool_use_id: entry.toolUseId, content: cleared ? '[tool result cleared to save context]' : entry.content, ...( entry.isError ? { is_error: true } : {} ) } );
						break;
					}
					default:
						Assert.never( entry );   // add a kind ⇒ compile error here until it's projected
				}
			}
		}
		return messages;
	}

	/** Append a block to the last message when it is the same role AND already block-shaped; otherwise
	 *  start a new message. Keeps assistant text + its tool-calls in one message and batches consecutive
	 *  tool-results, matching the tool-loop wire shape. */
	private _appendBlock( messages: WireMessage[], role: WireMessage[ 'role' ], block: WireBlock ): void {
		const last = messages[ messages.length - 1 ];
		if ( last && last.role === role && Array.isArray( last.content ) ) {
			last.content.push( block );
			return;
		}
		messages.push( { role, content: [ block ] } );
	}

	// ── Projection: to the INSPECTOR ───────────────────────────────────────────

	/**
	 * The time-ordered itinerary the Turns folder renders — one BLOCK per turn, each carrying the entries
	 * that happened inside it ( thinking included ) with their self-priced wire weight.
	 *
	 * Grouped rather than flat because a turn is the unit a user reasons about and the unit the window
	 * policy operates on. A flat entry stream reads as an undifferentiated log; blocks let the display be
	 * honest about the structure that actually exists — this is what you asked, and here is everything
	 * that happened because of it.
	 */
	turnRows(): TranscriptTurn[] {
		return this.turns.map( ( turn ) => {
			const rows = turn.entries.map( ( entry ) => this._row( entry ) );
			return {
				id:        turn.id,
				startedAt: turn.startedAt,
				rows,
				tokens:    rows.reduce( ( sum, r ) => sum + r.tokens, 0 )
			};
		} );
	}

	private _row( entry: TurnEntry ): TranscriptRow {
		const displayOnly = !WIRE_KINDS.has( entry.kind );
		return {
			at:     entry.at,
			kind:   entry.kind,
			label:  Transcript._label( entry ),
			text:   Transcript._entryText( entry ),
			tokens: displayOnly ? 0 : Transcript._entryTokens( entry ),
			displayOnly,
			display: Transcript._display( entry ),
			// a non-text row carries its bytes so the inspector can thumbnail it inline
			...( entry.kind === 'image'
				? { media: {
					mediaType: entry.mediaType,
					data:      entry.data,
					...( entry.width  ? { width:  entry.width  } : {} ),
					...( entry.height ? { height: entry.height } : {} )
				} }
				: {} )
		};
	}

	// ── Cost ───────────────────────────────────────────────────────────────────

	/** The transcript's wire token weight — the self-priced sum over the WIRE-bearing entries ( thinking
	 *  excluded ). Folds onto agent.estimateTokens() to give the session's whole context cost. */
	estimateTokens(): number {
		let total = 0;
		for ( const turn of this.turns ) {
			for ( const entry of turn.entries ) {
				if ( !WIRE_KINDS.has( entry.kind ) ) continue;
				total += Transcript._entryTokens( entry );
			}
		}
		return total;
	}

	// ── Per-entry helpers ( static — pure over one entry ) ─────────────────────

	/** The token weight of ONE wire-bearing entry — the one place a kind's cost formula lives. Text kinds
	 *  are chars÷4 ( KCDPrimitive._estimateTokens over the body ); an image is priced by pixel area
	 *  ( estimateImageTokens ), NOT its text. Callers gate on WIRE_KINDS first, so a display-only kind
	 *  ( thinking ) never reaches here. */
	static _entryTokens( entry: TurnEntry ): number {
		if ( entry.kind === 'image' ) return estimateImageTokens( entry.width, entry.height );
		return KCDPrimitive._estimateTokens( Transcript._entryText( entry ) );
	}

	/** The entry's body as text — what it costs and what the itinerary shows. */
	static _entryText( entry: TurnEntry ): string {
		switch ( entry.kind ) {
			case 'user':          return entry.text;
			case 'assistant':     return entry.text;
			case 'thinking':      return entry.text;
			case 'tool-call':     return `${ entry.name } ${ JSON.stringify( entry.input ?? {} ) }`;
			case 'tool-result':   return entry.content;
			case 'injected-file': return frameFile( entry.name, entry.text );
			case 'image':         return ( entry.name ?? '(image)' ) + ( entry.width && entry.height ? ` ${ entry.width }×${ entry.height }` : '' );
			default:              return Assert.never( entry );
		}
	}

	/**
	 * How ONE entry presents — the single kind→look table for the whole app ( see RowDisplay ).
	 *
	 * Colours are the house tokens each kind already wears elsewhere, so the itinerary agrees with the
	 * surfaces around it by construction: `--know` for the human and `--care` for the model ( the chat's
	 * own per-role turn tints ), `--thinking` amber for reasoning, `--accent` for an action.
	 *
	 * A tool result is deliberately NOT the tool call's icon: a call and what it returned are different
	 * events, and giving them one glyph made a tool loop read as a stutter rather than a round trip. It
	 * also branches on `isError` — the one place that flag is known, and the reason this is computed per
	 * row instead of being a static lookup on `kind`.
	 */
	static _display( entry: TurnEntry ): RowDisplay {
		switch ( entry.kind ) {
			case 'user':          return { icon: 'user',      color: '--know' };
			case 'assistant':     return { icon: 'sparkle',   color: '--care' };
			case 'thinking':      return { icon: 'lightbulb', color: '--thinking' };
			case 'tool-call':     return { icon: 'pulse',     color: '--accent' };
			case 'tool-result':   return entry.isError
				? { icon: 'warning', color: '--error' }
				: { icon: 'package', color: '--plugin' };
			case 'injected-file': return { icon: 'file',      color: '--reference' };
			case 'image':         return { icon: 'camera',    color: '--external' };
			default:              return Assert.never( entry );
		}
	}

	/** A one-line label for an itinerary row. */
	static _label( entry: TurnEntry ): string {
		switch ( entry.kind ) {
			case 'user':          return 'user';
			case 'assistant':     return 'assistant';
			case 'thinking':      return 'thinking';
			case 'tool-call':     return `→ tool ${ entry.name }`;
			case 'tool-result':   return entry.isError ? 'tool result (error)' : 'tool result';
			case 'injected-file': return `file ${ entry.name }`;
			case 'image':         return 'image';
			default:              return Assert.never( entry );
		}
	}
}
