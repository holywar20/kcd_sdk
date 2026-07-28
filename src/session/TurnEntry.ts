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
 * call, so it arrives as a tool-result. `thinking` is a DISPLAY-ONLY entry: rendered in the
 * inspector for insight into the agent's reasoning, but NEVER re-projected to the wire — once a
 * decision is made the scratchpad that led to it is discardable, and it lives outside the loop.
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

/** One typed thing that happened. Discriminated on `kind`. The five wire kinds ride the request;
 *  `thinking` is display-only ( skipped by wireMessages ). */
export type TurnEntry = EntryBase & (
	| { kind: 'user';          text: string }
	| { kind: 'assistant';     text: string }
	| { kind: 'tool-call';     id: string; name: string; input: unknown }
	| { kind: 'tool-result';   toolUseId: string; content: string; isError?: boolean }
	| { kind: 'injected-file'; path: string; name: string; text: string }
	| { kind: 'image';         mediaType: string; data: string; name?: string; path?: string; width?: number; height?: number }
	| { kind: 'thinking';      text: string }
);

/** The discriminant values that ride the wire — `thinking` is deliberately absent ( display-only ). */
const WIRE_KINDS: ReadonlySet<TurnEntry[ 'kind' ]> = new Set( [ 'user', 'assistant', 'tool-call', 'tool-result', 'injected-file', 'image' ] );

/** One turn — a user prompt and everything that answered it, as an ordered entry list. `id` is stable
 *  for the life of the turn ( the dispatch traceId once persisted; a synthetic id for a live turn ). */
export interface Turn {
	id: string;
	startedAt: number;
	entries: TurnEntry[];
}

/**
 * Which turns ride the wire on the NEXT request. A property of the Session ( persisted, changed by a
 * deliberate user action ), never of the turns themselves — flipping it reshapes the window without
 * touching a single entry. That separation is the whole point: the transcript is the durable account of
 * what happened, the policy is a lens over it, and no policy change can ever delete history.
 *
 * `all` sends everything · `lastN` sends the trailing N TURNS ( a turn already IS a prompt plus
 * everything that answered it, so this needs no exchange-grouping scaffolding ) · `manual` sends exactly
 * the named turn ids.
 */
export type RetentionPolicy =
	| { kind: 'all' }
	| { kind: 'lastN'; n: number }
	| { kind: 'manual'; ids: string[] };

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

	/** The raw ordered turn list — what the Turns inspector folder iterates. Copy out so a reader can't
	 *  mutate the transcript in place. */
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
		if ( policy.kind === 'all' ) return new Transcript( [ ...this.turns ] );
		if ( policy.kind === 'manual' ) {
			const wanted = new Set( policy.ids );
			return new Transcript( this.turns.filter( ( t ) => wanted.has( t.id ) ) );
		}
		// lastN — the trailing n turns; n <= 0 windows to nothing rather than silently meaning "all".
		if ( policy.n <= 0 ) return new Transcript( [] );
		return new Transcript( this.turns.slice( -policy.n ) );
	}

	// ── Appends ( in-flight — the orchestrator lands entries here as a turn runs ) ──

	/** Open a fresh turn and return it — the in-flight appender pushes entries onto it as rounds resolve. */
	openTurn( id: string, startedAt: number ): Turn {
		const turn: Turn = { id, startedAt, entries: [] };
		this.turns.push( turn );
		return turn;
	}

	/** Append one entry onto the last open turn ( opening an anonymous one if none exists — a defensive
	 *  fallback; the orchestrator normally openTurn()s first ). */
	append( entry: TurnEntry ): void {
		const turn = this.turns[ this.turns.length - 1 ] ?? this.openTurn( `t${ this.turns.length + 1 }`, entry.at );
		turn.entries.push( entry );
	}

	// ── Projection: to the WIRE ────────────────────────────────────────────────

	/**
	 * Project the transcript to the neutral message list a connector sends. Walks every turn's entries in
	 * order and batches them into alternating role messages: assistant text + its tool-calls become ONE
	 * assistant message ( text block then tool_use blocks ); tool-results become a following user message
	 * of tool_result blocks; user text and injected files are user messages. `thinking` is SKIPPED — the
	 * scratchpad never rides the wire.
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
		for ( const turn of this.turns ) {
			for ( const entry of turn.entries ) {
				switch ( entry.kind ) {
					case 'thinking':
						break;   // display-only — never rides
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
