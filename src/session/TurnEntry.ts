import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import { Assert } from '../core/Assert';
import { type SlotMode } from '../primitives/types';
import { type AccessLevel, type InjectedKind } from './InjectedItem';

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

/**
 * How a turn ENDED — the REASON, deliberately distinct from `Turn.failed`, which is the GUARD.
 *
 * Two questions, not two names for one answer. `failed` decides whether a turn rides the wire and
 * whether it may be re-included; this says why it ended that way. A cancelled turn is `failed: true`
 * with `outcome: 'cancelled'` — both true, neither redundant, and collapsing them would force a
 * cancellation to be reported as a failure or a second boolean to contradict the first.
 *
 * The open half of the pair on purpose. `failed` can never grow past two states, but the reasons a
 * turn stops are open-ended and already visible on the roadmap: a user cancellation, a policy refusal
 * from gate middleware, a budget ceiling. Each arrives as one more member here and is carried,
 * persisted, and displayed by machinery that needs no further teaching.
 *
 * Called OUTCOME, not status, because this codebase already asks two other things by that name and a
 * third would make every read ambiguous: `SessionStatus` is active/archived ( is this filed away ) and
 * `TurnStatus` is idle/thinking ( is a turn running right now ). Three different clocks — filed,
 * running, ended — and this is the last of them.
 *
 * NEVER enforced by storage — the column is TEXT and nothing constrains it — so every read is
 * `!== 'ok'` rather than `=== 'failed'`. That points the failure direction at "this turn completed",
 * which is what an unrecognized value honestly is; the reverse would mark real history as broken.
 */
export type TurnOutcome = 'ok' | 'failed';

/** The stable envelope every entry carries — a stamp for the time-ordered itinerary. Ordering within
 *  a turn is array order; `at` is the display timestamp ( and the persisted-row field Phase 4 hydrates ). */
interface EntryBase {
	at: number;
	/**
	 * TRANSIENT — the injected file's contents, and NEVER persisted. `_entryPayload` strips it exactly as
	 * it strips `rowId`.
	 *
	 * Main reads the file and stashes it here immediately before projecting the LIVE turn; it is absent on
	 * every entry that is not being injected right now, which is nearly all of them. It lives on the entry
	 * for the length of one projection because @kcd/core is Node-free by charter and cannot open a file:
	 * the SDK decides WHAT rides, main supplies the bytes, and neither has to learn the other's job.
	 *
	 * Declared on the BASE rather than on the two attachment arms because the strip in `_entryPayload` is
	 * a base-level concern — one rest-destructure that cannot miss an arm someone adds later.
	 *
	 * NOT named `body`, which it was until the `error` arm arrived carrying the app's `Failure` currency
	 * verbatim — and `Failure.body` is an HTTP response body, a PERSISTED part of the account, the exact
	 * opposite of a transient file read. A base field and an arm field of one name intersect, so the two
	 * meanings did not merely confuse a reader: they made an error entry unconstructible ( `string` against
	 * `string | null` ). The established currency keeps `body`; this private transient is the one that moved.
	 */
	contents?: string;
	/**
	 * This entry's STORAGE identity — the `turn_entries.id` of the row holding it, when it has one.
	 *
	 * The one thing that makes an entry writable after the fact. Storage is otherwise insert-only, so an
	 * entry cannot be addressed for an update without this, and position will not substitute: hydration
	 * skips a row it cannot parse, which slides every in-memory index after it out of step with the table.
	 *
	 * OPTIONAL, and its absence is meaningful rather than incidental — absent means NOT PERSISTED, which is
	 * the true state of an entry on a live turn that has not been recorded yet, and of a pending attachment
	 * that no turn carries. Anything offering to change a recorded entry gates on this, so the gate reads
	 * the real condition instead of guessing at one.
	 *
	 * Deliberately NOT part of the wire projection or of equality — it is where the entry lives, not what
	 * the entry IS, and a copied turn ( fork / duplicate ) is a different row carrying the same account.
	 */
	rowId?: number;
}

// `EntryMode` used to stand here — a three-state ( suggested · on · off ) the user set per attachment.
// It is GONE, collapsed into the projection ( 2026-08-03 ). An attachment now stores a PATH and no body,
// so what rides is decided by POSITION rather than by a setting: the live turn carries the file, every
// prior turn carries a pointer to it, and a removed entry carries nothing. Injection became a verb
// instead of a state, and the state it replaced stopped needing a name.

/** One typed thing that happened. Discriminated on `kind`. The wire kinds ride the request every
 *  turn; `thinking` rides only inside the LIVE turn's tool loop, and only when SIGNED.
 *
 *  `signature` on the thinking arm is the PROVIDER'S verification token for that block: present ⇒
 *  the provider will accept the block back verbatim, so it is replayable; absent or empty ⇒
 *  display-only. It is optional because not every producer has one — openai-compat manufactures a
 *  thinking block with `signature: ''` ( a non-Anthropic model has nothing to verify against ), and
 *  a hydrated historical entry has none either.
 *
 *  `error` is what STOPPED a turn, recorded in the itinerary beside the calls that led up to it — so a
 *  review reads as one sequence ( here is the request, here is the tool it ran, here is what rejected
 *  it ) instead of sending the reader to a separate log to correlate by timestamp. Its fields mirror the
 *  app's `Failure` currency exactly, so one assigns to the other with no mapping; they are re-declared
 *  here rather than imported because @kcd/core cannot depend on the app that consumes it.
 *
 *  It is emphatically NOT a wire kind. A model is never told "you failed" as context: the turn that
 *  produced this is rolled back off the wire entirely, and the entry survives only as the account of what
 *  was attempted. Keeping it out of WIRE_KINDS also means it prices at zero, which is correct — nothing
 *  that never rides can cost the next turn anything.
 *
 *  `unreadable` is a row this build could not interpret — bad JSON, no discriminant, a missing required
 *  field, or a kind a NEWER build wrote. It takes `error`'s contract exactly rather than inventing one:
 *  recorded, displayed, priced at zero, never projected. It exists because the alternative — dropping the
 *  row — makes the transcript silently disagree with the conversation that happened, and because
 *  `Assert.never` THROWS, so an uninterpretable entry reaching a projection would take the whole
 *  projection down rather than costing one row.
 *
 *  This is what makes hydration total: `parseEntry` returns an entry or an `unreadable` entry, never
 *  nothing. Hydration LOADS; projection DECIDES what rides. A skip at load time made hydration a second
 *  decider, which is how a branch that adds a kind quietly shortens every conversation in the database
 *  the moment you switch away from it. */
export type TurnEntry = EntryBase & (
	| { kind: 'user';          text: string }
	| { kind: 'assistant';     text: string }
	| { kind: 'tool-call';     id: string; name: string; input: unknown }
	| { kind: 'tool-result';   toolUseId: string; content: string; isError?: boolean }
	| { kind: 'injected-file'; path: string; name: string; mediaType: string; bytes: number; removed?: boolean; level?: AccessLevel }
	| { kind: 'image';         path: string; name: string; mediaType: string; width?: number; height?: number; removed?: boolean; level?: AccessLevel }
	| { kind: 'injected-folder'; path: string; name: string; removed?: boolean; level?: AccessLevel }
	| { kind: 'injected-tool';   server: string; name: string; removed?: boolean }
	| { kind: 'thinking';      text: string; signature?: string }
	| { kind: 'error';         code: string; message: string; status: number | null; body: string | null; detail?: Record<string, unknown> }
	| { kind: 'unreadable';    originalKind: string | null; reason: string; payload: string }
);

/** The two FILE kinds a user attaches — the ones carrying bytes and a media type. Named because several
 *  places narrow to exactly this pair and `Extract<...>` spelled out at each of them is the same thought
 *  written three times. */
export type Attachment = Extract<TurnEntry, { kind: 'injected-file' | 'image' }>;

/**
 * Every kind a USER hands over — the grant set. An injection rides WHOLE on the turn it was made and as a
 * REFERENCE on every turn after, and that decay is decided by POSITION in the transcript: no flag to
 * clear, no timer, no policy, and no failed turn that can burn one. Read once, then a handle the agent
 * may follow at its option.
 *
 * A folder and a tool are grants on exactly those terms, which is why they are entries here rather than
 * rows in a table of their own — position already supplies decay, persistence, removal and re-injection,
 * and `turn_entries` already stores them.
 *
 * Agent-FOUND context is deliberately NOT here: an agent's own read stays a tool-result, on the same rule
 * that refused an injected-memory kind. What makes something a grant is that a person handed it over.
 */
export type Grant = Extract<TurnEntry, { kind: 'injected-file' | 'image' | 'injected-folder' | 'injected-tool' }>;

/** True for any kind a user hands over — the narrowing every grant-shaped read does. */
export function isGrant( entry: TurnEntry ): entry is Grant {
	return entry.kind === 'injected-file' || entry.kind === 'image'
		|| entry.kind === 'injected-folder' || entry.kind === 'injected-tool';
}

/** What a grant is ABOUT, read according to its kind — a path for a file or a folder, the qualified id
 *  for a tool. The word the drag, the deck tile and the gate all use for the same thing, so the vocabulary
 *  cannot drift between the gesture and what it produces. */
export function grantSubject( entry: Grant ): string {
	return entry.kind === 'injected-tool' ? `${ entry.server }.${ entry.name }` : entry.path;
}

/** A grant entry's KIND in the deck/authorization vocabulary — the translation between the entry union's
 *  discriminant ( which names a transcript kind ) and `InjectedKind` ( which names what the thing IS ).
 *  An image is a file here: the two differ in how they RIDE, and not at all in what is permitted. */
export function grantKind( entry: Grant ): InjectedKind {
	if ( entry.kind === 'injected-folder' ) return 'folder';
	if ( entry.kind === 'injected-tool' )   return 'tool';
	return 'file';
}

/**
 * How deep a grant entry reaches — the transcript's `level | null | absent` resolved to the one value an
 * authorization may carry.
 *
 * Beside `grantKind` and `grantSubject` on purpose: three facts read off one entry, by one rule each, in
 * one file. Every producer of a `GrantRef` calls all three, so none of them can drift from the others.
 *
 * A TOOL is `none` — it is not a path grant and has no depth to report. A path entry that never chose
 * resolves to `read`, the conservative rung and the one a grant meant before depths existed. That
 * ambiguity is settled HERE rather than at each gate: null is an honest thing for a transcript row to say
 * and a useless thing for a guard to be handed, and a guard left to decide for itself is three guards
 * deciding differently.
 */
export function grantLevel( entry: Grant ): AccessLevel {
	if ( entry.kind === 'injected-tool' ) return 'none';
	return entry.level ?? 'read';
}

/** The discriminant values that count as the session's STANDING context cost — what `estimateTokens()`
 *  prices and what the inspector charges a row for. `thinking` is deliberately absent EVEN THOUGH it can
 *  now ride: the provider strips thinking from history, so a thinking entry is never part of what the
 *  NEXT turn pays for. It rides once, inside its own turn's tool loop, and then stops. Do not "fix" this
 *  by adding 'thinking' here — that would charge the session forever for a block it sent once. */
const WIRE_KINDS: ReadonlySet<TurnEntry[ 'kind' ]> = new Set( [ 'user', 'assistant', 'tool-call', 'tool-result', 'injected-file', 'image', 'injected-folder', 'injected-tool' ] );

/**
 * What a stored payload must CARRY to mean anything, per kind — the seam `parseEntry` validates against.
 *
 * A complete `Record` over the union on purpose: adding a kind is a COMPILE ERROR right here, which is the
 * table asking "how does this validate?" before the new kind can reach a wire. That makes it the fifth
 * place the compiler stops you, alongside `wireMessages`, `_entryText`, `_display` and `_label` — so the
 * cost of extending the currency is answering five real questions, and never a silent default.
 *
 * REQUIRED fields only. An optional field that is present and wrong is a lesser sin than a required one
 * that is missing, and checking every field exhaustively is a schema library — which @kcd/core
 * deliberately is not, being Node-free and dependency-free by charter. `tool-call.input` is absent because
 * its type is `unknown`, which nothing can meaningfully assert; `error.status` and `error.body` are absent
 * because both are legitimately null.
 *
 * `unreadable` requires nothing: it is what `parseEntry` PRODUCES when validation fails, so a row that
 * somehow stored one is already exactly what it claims to be.
 */
const ENTRY_SPECS: Record<TurnEntry[ 'kind' ], Record<string, 'string' | 'number'>> = {
	'user':          { text: 'string' },
	'assistant':     { text: 'string' },
	'thinking':      { text: 'string' },
	'tool-call':     { id: 'string', name: 'string' },
	'tool-result':   { toolUseId: 'string', content: 'string' },
	'injected-file': { path: 'string', name: 'string', mediaType: 'string', bytes: 'number' },
	'image':         { path: 'string', name: 'string', mediaType: 'string' },
	'injected-folder': { path: 'string', name: 'string' },
	// No `subject` field: a tool's subject is DERIVED from the pair ( see `grantSubject` ). Storing it too
	// would be a second copy of an answer these two already give, and the copy is what goes stale.
	'injected-tool':   { server: 'string', name: 'string' },
	'error':         { code: 'string', message: 'string' },
	'unreadable':    {}
};

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
	/**
	 * Did this turn's dispatch FAIL — the model never answered, so the turn never landed.
	 *
	 * A state descriptor, exactly as `compacted` is: it guards the mode switch's clear and the manual
	 * toggle, and the itinerary reads it to draw the turn as a failure. Nothing projects off it — `include`
	 * is already false and stays false.
	 *
	 * Required rather than optional so every construction site states it. Absence would mean "not failed",
	 * and that failure direction is a failed turn quietly riding the wire — the one outcome this prevents.
	 */
	failed: boolean;
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
 * How many completed EXCHANGES a session needs before compacting it is worth doing. Below this the
 * summary would cost more tokens than the turns it replaced, and the user would be paying a model call
 * to make their context bigger.
 *
 * Lives here so BOTH sides read the same number: the renderer disables the button below it, and the
 * service refuses below it. Two gates, one constant — the alternative is a button that enables at four
 * and a service that refuses at five.
 */
export const MIN_COMPACTION_TURNS = 4;

/**
 * How many of the most recent PROJECTED turns keep their tool results WHOLE on the wire. Everything older
 * rides as a stub pointing into the session's result log.
 *
 * Lives here for the same reason MIN_COMPACTION_TURNS does — two readers, one number. The WIRE stubs against
 * it and the ITINERARY marks against it, and those reach a transcript by completely different routes ( a
 * send, a pull channel ). Sitting in the orchestrator it was reachable from only one of them, so the second
 * reader would have had to restate it, and a restated constant is a constant that drifts.
 *
 * Three is small on purpose: a large default hides whether the mechanism works at all. Setting it absurdly
 * high is the one-line way to turn stubbing off. The per-session POLICY that was scoped to replace this
 * ( per-entry-reduction Phase 3 ) is declined — one number is a constant, not a table.
 */
export const KEEP_TOOL_RESULT_TURNS = 3;

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
 * the timeline as history, and its summary stops riding to the wire.
 *
 * It is NOT an undo, and this block said it was until 2026-08-10. Under the flag model the span the
 * summary covered was marked `compacted: true` + `include: false` by `compactThrough()` and PERSISTED;
 * neither `compacted()` nor `resetWindow()` ever re-includes a compacted turn ( see both, which say so
 * outright ). So turning a compaction off drops the summary AND leaves its span dropped — a deliberate
 * "discard this whole stretch", not a recovery. Nothing here deletes a turn from the RECORD; `turnRows()`
 * still shows every one. What is gone is their place in the context sent to the model.
 */
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

/**
 * How the wire projection is TUNED — the options both readers ( `wireMessages` and `estimateTokens` ) take,
 * so a caller cannot tune one and price the other.
 */
export interface WireOptions {
	/** Project an image as its pointer line rather than an image block, for a tier that cannot carry one. */
	imagesAsText?: boolean;
	/** Stub tool results older than the last N turns. Absent ⇒ nothing stubs. */
	toolResults?: ToolResultReduction;
}

/**
 * Tool-result reduction, as the projection needs it.
 *
 * `logPath` is supplied by the CALLER because @kcd/core is Node-free and cannot know where a file lives;
 * `lines` is supplied by the SESSION, because it is the only object holding the whole transcript and a line
 * number is a fact about all of history rather than about what currently rides. The projection knows how to
 * frame a stub and nothing else — which is why neither of those two facts is computed here.
 */
export interface ToolResultReduction {
	/** How many of the most recent turns keep their results WHOLE. 0 keeps only the live turn's. */
	keepTurns: number;
	/** Absolute path to the session's result log — what a stub tells the agent to read. */
	logPath: string;
	/** `toolUseId` → 1-based line in that log. Absent ⇒ stubs name the id and cost the agent a search. */
	lines?: Map<string, number>;
}

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
	/** The entry's body text AS IT RIDES — mode-aware for an attachment, so a file projecting as a pointer
	 *  shows the pointer here. The itinerary is the answer to "what is in context"; showing a body the wire
	 *  is not sending made it the answer to a question nobody asked, and put it at odds with `tokens` on
	 *  this same row. An attachment's real contents are the FILE at the path in that pointer, and `read_file`
	 *  is how anything gets them — which is why no row ever carries bytes. */
	text: string;
	/** The STUB this entry rides as when the wire is reducing it — the exact text the model receives in place
	 *  of `text`. Absent when it rides whole, which is everything but an older tool result.
	 *
	 *  `text` above stays the FULL output, deliberately: the itinerary is the account of what happened, and a
	 *  tool result's output exists nowhere else a user can reach ( unlike an attachment, whose pointer
	 *  resolves to a file they can open ). `tokens` below is the STUB's weight, because that is what the send
	 *  actually pays. Both facts are true at once and the row states both. */
	stub?: string;
	/** The entry's STORAGE id, when it has one — what a repair names the row by. Absent for an entry no turn
	 *  has recorded yet, and for one whose turn predates typed entries; a surface offering a per-row action
	 *  gates on it rather than assuming. */
	rowId?: number;
	/** Wire token weight — 0 for a display-only ( thinking ) row, else the entry's projected cost. A row
	 *  carrying a `stub` prices as THAT, not as its full text: the wire pays for the stub. */
	tokens: number;
	/** True for the display-only kinds that never ride the wire ( thinking ). */
	displayOnly: boolean;
	/** Icon + colour token for this row — see RowDisplay. Every surface that draws a row reads this
	 *  rather than keeping its own kind→look table. */
	display: RowDisplay;
	/* The `media` handle went out with its only consumer ( ReaderContent's inline <img> ). It carried bytes
	   when the entry did; once an image stored a path, the row could only hand over a `file://` the dev
	   server's webSecurity refuses to load, so every image row rendered broken. An image row reads as its
	   pointer line like any other attachment now. A real thumbnail surface wants a registered protocol
	   handler in main — it can reintroduce a typed handle in the same change that consumes one. */
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
	/** This turn's dispatch failed — it is an account of what was attempted, and it rides nothing. The
	 *  display reads this to draw the block as a failure; without it a failed turn simply stops, which is
	 *  indistinguishable from one still in flight. */
	failed: boolean;
}

/* `AttachmentView` — the file-only gutter view — became the `file` variant of `InjectedItem`
   ( ./InjectedItem.ts ). The deck holds folders and tools beside files now, so the currency is the
   union rather than a widened file. Same projection, same reason it is a view and not the entry: a
   tile draws a name and a weight, and handing over entries would couple every surface to the shape of
   the union it came from. */

/** How an injected file frames into the wire as a user message — a brief marker so the model reads it
 *  as pinned reference material, not as the user's own words. */
export function frameFile( name: string, text: string ): string {
	return `[injected file — ${ name }]\n${ text }`;
}

/**
 * How an attachment set to `on` frames — the model is told the file EXISTS and how to reach it, which is
 * the whole difference between a pointer and a deletion. A file that silently vanishes reads as one that
 * never existed, so the model will not go looking for it.
 *
 * The PATH rides, not just the name: a pointer the reader cannot follow is a dead link, and an agent
 * handed one either hallucinates the contents or stalls. The renderer's `_pointerLine` named the file and
 * not where it was.
 *
 * Exported for the reason frameCompaction is: main projects it, the renderer prices it, and two copies of
 * this string quietly cost two different numbers.
 */
export function framePointer( name: string, path?: string ): string {
	return `[available file — ${ name }${ path ? ` at ${ path }` : '' } — not in context; read it if you need its contents]`;
}

/**
 * How a FAILED injection reads — the file was asked for and could not be read.
 *
 * The model is TOLD, deliberately. A user who injects a file and gets silence reasonably assumes it
 * arrived, and the agent then answers from nothing — which is the silent-failure shape this whole seam
 * keeps producing. Neither does it kill the turn: one moved file should not make a conversation
 * unsendable. The turn proceeds, everyone knows, and the path is right there to fix or re-inject.
 */
export function frameFailedInjection( name: string, path: string, reason: string ): string {
	return `[injection failed — ${ name } at ${ path } could not be read: ${ reason }]`;
}

/** How a REMOVED attachment reads in the itinerary. Rides nothing; the entry stays in the account,
 *  because removal is an intent recorded here and executed at compaction, never an edit to history. */
export function frameRemoved( name: string ): string {
	return `[removed — ${ name } — dropped from context at the next compaction]`;
}

/**
 * A FOLDER grant's reference form — the same shape `framePointer` takes for a file, naming the tool that
 * re-fetches it.
 *
 * It names the CALL rather than only the location, for the reason the tool-result stub does: the reader is
 * an agent composing its next move, and one left to work out how to list a directory will sometimes work it
 * out differently, or decide it is not worth the trouble — which is the same as the grant being gone.
 *
 * A folder listing is deliberately NOT re-resolved on every turn. Listing on demand is MORE current than a
 * standing listing compiled at the last send, and costs nothing in between.
 */
export function frameFolder( path: string ): string {
	return `[available folder — ${ path } — not in context; list it if you need what is in it]`;
}

/**
 * A TOOL grant's reference form — the one-line manifest entry.
 *
 * The whole/reference split lands exactly on `ToolMode`'s existing two states: whole is `suggested` ( the
 * full surface — name, description, input schema ), reference is `on` ( name plus a blurb, with the server
 * spawned lazily on first invoke ). So an injected tool needs no framing vocabulary of its own; it rides
 * the surface once and decays to the line the manifest already knows how to write.
 */
export function frameTool( server: string, name: string ): string {
	return `[available tool — ${ server }.${ name } — granted to you; call it when you need it]`;
}

/** How many files a folder listing carries before it stops enumerating and starts counting. The cap keeps
 *  a pathological directory from silently spending a context window, and the shape still answers the
 *  question a listing is for — what is here, and roughly how much of it.
 *
 *  A CONTEXT-BUDGET rule, deliberately not a filesystem one: `SdkFileAccess.list` has its own much larger
 *  floor ( LIST_CAP ) protecting the process from a 50k-entry readdir. Two different concerns, two
 *  different numbers, and collapsing them would tie what an agent reads to what a browser can render. */
export const FOLDER_FILE_CAP = 100;

/**
 * A FOLDER grant's WHOLE form — the listing that rides on the turn it was injected.
 *
 * Every folder survives the cap and only files are counted out. A directory is the thing an agent
 * navigates BY: dropping subdirectories to make room for more files would remove the part of the listing
 * that lets it go somewhere, which is the opposite of what a listing is for. The hundred LARGEST files
 * are kept because size is the only signal available without opening anything, and the remainder is
 * stated plainly so the agent knows the list is partial rather than believing it is complete.
 *
 * Sizes are NOT rendered per row. A listing is read to decide where to look next, and a column of byte
 * counts costs real tokens to answer a question nobody asked; size is used to CHOOSE the hundred, then
 * discarded.
 */
export function frameFolderListing( path: string, entries: { name: string; isDir: boolean; size: number }[] ): string {
	const dirs  = entries.filter( e => e.isDir );
	const files = entries.filter( e => !e.isDir );
	// Sorted by size to pick the hundred, then back to the caller's own order ( alphabetical ) to read.
	const kept  = [ ...files ].sort( ( a, b ) => b.size - a.size ).slice( 0, FOLDER_FILE_CAP );
	const keptSet = new Set( kept.map( f => f.name ) );
	const shown = files.filter( f => keptSet.has( f.name ) );
	const rest  = files.length - shown.length;

	const lines = [
		...dirs.map( d => `${ d.name }/` ),
		...shown.map( f => f.name )
	];
	if ( rest > 0 ) lines.push( `… and ${ rest } more file${ rest === 1 ? '' : 's' } not listed — glob or grep this folder to reach them` );
	if ( !lines.length ) lines.push( '( empty )' );

	return `[injected folder — ${ path }]\n${ lines.join( '\n' ) }`;
}

/** A TOOL grant's WHOLE form — the full surface, which is exactly what `ToolMode`'s `suggested` injects.
 *  Framed as a grant rather than as a suggestion because that is what it is: the agent is being given
 *  something it did not have, not being nudged toward something it did. */
export function frameToolSurface( server: string, name: string, description: string, schema: unknown ): string {
	return `[injected tool — ${ server }.${ name } — granted to you by the user]\n${ description }\n${ JSON.stringify( schema ) }`;
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

/**
 * A tool result the wire no longer carries — replaced by where to go and read it.
 *
 * SELF-CONTAINED on purpose: the path rides in every stub rather than being named once in the system half.
 * That costs a handful of tokens per stub against the thousands each one saves, and what it buys is a
 * pointer with no dependency on another part of the prompt being present and correct. A handle that only
 * resolves when a second thing is also right is not a handle.
 *
 * It names the CALL, not just the location. The reader is an agent composing its next tool call, and one
 * that has to work out how to fetch this will sometimes work it out differently — or decide it is not worth
 * the trouble, which is the same as the data being gone.
 *
 * The `line === undefined` arm is honest degradation, not a bug: a bare Transcript has no Session behind it
 * to number the log, so the stub falls back to the id and costs a search instead of a seek.
 */
/**
 * The result log, announced ONCE in the compiled half — the historical record, not a pointer to any one
 * result.
 *
 * It exists for the case a stub cannot cover. A stub is only present while its turn still rides; once a
 * compaction has replaced those turns there is no stub left to follow, and this line is the only remaining
 * word that the results ever existed. It is also what makes the log reachable for the thing a person wants
 * it for — going back and checking what a tool actually returned.
 *
 * Framed as a LAST RESORT deliberately. An agent told it can re-read anything will sometimes re-read rather
 * than remember, which spends a round trip to recover something it already had.
 */
export function frameResultLog( logPath: string ): string {
	return `Every tool result this conversation has produced is recorded at ${ logPath } — one JSON object per`
		+ ` line, in the order the tools ran, each carrying its "id" and its full output. Recent results are`
		+ ` in the conversation itself; older ones appear there as a stub naming their line. Read a line with`
		+ ` read_file( fromLine, toLine ) only when you genuinely need output you no longer have.`;
}

export function frameToolResultStub( logPath: string, line: number | undefined, toolUseId: string ): string {
	if ( line === undefined ) {
		return `[tool result not in context — the full output is in ${ logPath }, on the line whose "id" is "${ toolUseId }".]`;
	}
	return `[tool result not in context — full output at ${ logPath } line ${ line }.`
		+ ` Retrieve it with read_file( fromLine: ${ line }, toLine: ${ line } ) if you need it.]`;
}

/** Anthropic prices an image by pixel AREA — roughly ( width × height ) / 750 tokens — NOT by byte count
 *  or chars÷4, so a large screenshot and a small icon cost wildly different amounts. When dimensions are
 *  unknown ( not yet measured at attach time ) we fall back to a single conservative constant near the
 *  per-image ceiling, so an unmeasured image never reads as free. This is the non-text sibling of
 *  KCDPrimitive._estimateTokens: the cheap, always-available estimate the budget UI runs on. */
/** How much of an oversized body a summarising pass sees — enough to infer WHAT a thing is and why a
 *  later reader would want it, not enough to read it. */
/** Above this, a body is DESCRIBED instead of included. */

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
	 * The attachments still IN CONTEXT, in order — the gutter's list. A compacted turn's attachments are
	 * not among them: a summary stands in for that turn, so its files stopped riding when it did, and a chip
	 * still sitting there would claim context the model no longer has.
	 *
	 * NOTHING IS DESTROYED to make that true. The entries stay on their turns, in the table, and in the
	 * itinerary — a user who wants a file back scrolls to where it was injected and injects it again. This
	 * is a projection, exactly as the window and the summary are; the account of what happened is never
	 * edited to express a preference about it.
	 *
	 * COMPACTION is the line, not the retention window. Compaction is one-way — a covered turn is history
	 * and nothing re-includes it — so a chip leaving is permanent and honest. Retention is a policy the user
	 * can widen back, and hiding on it would make chips flicker in and out as the window slides.
	 *
	 * `removed` does not filter here either. A removed file keeps riding until its turn is compacted, so it
	 * keeps its chip ( wearing the red tone ) until then. What removal actually buys is that the file is
	 * left out of the SUMMARY too — see `digestText` — so it leaves context outright instead of being
	 * carried forward in paraphrase.
	 */
	attachments(): Grant[] {
		const out: Grant[] = [];
		for ( const turn of this.turns ) {
			if ( turn.compacted ) continue;
			for ( const entry of turn.entries ) {
				if ( isGrant( entry ) ) out.push( entry );
			}
		}
		return out;
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
			failed:    false,
		};
		return new Transcript( [ summary, ...this.turns ] );
	}

	// ── Appends ( in-flight — the orchestrator lands entries here as a turn runs ) ──

	/** Open a fresh turn and return it — the in-flight appender pushes entries onto it as rounds resolve.
	 *  Born INCLUDED and uncompacted, which is what makes the turn being dispatched right now ride without
	 *  anyone having to say so: whether the current turn is in the window was never a policy question. */
	openTurn( id: string, startedAt: number ): Turn {
		const turn: Turn = { id, startedAt, entries: [], include: true, compacted: false, failed: false };
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

	// ── Failure ( the other one-way flag pair ) ──

	/**
	 * Mark one turn FAILED — `failed: true` and `include: false`, set together, in the one place that sets
	 * either. The rollback for a turn whose dispatch died: it stays in the account ( the itinerary shows it )
	 * and it never rides again. Returns the turn so the caller can persist what it held — the entries a
	 * failed turn accumulated ARE the diagnosis. null when the id names no turn.
	 *
	 * Marking rather than REMOVING is what makes the live path and the reload path the same state: a removal
	 * would show a failure that vanished until the next restart, and would be the only destructive operation
	 * on an append-only structure — for no gain, since `include: false` already keeps the orphaned tool-call
	 * off the wire, which is the whole reason the rollback exists.
	 *
	 * ONE-WAY, like compaction: nothing re-includes a failed turn. The model never saw it land, and
	 * replaying a tool-call whose result never arrived is an invalid request by construction.
	 */
	failTurn( turnId: string ): Turn | null {
		const turn = this.turns.find( ( t ) => t.id === turnId );
		if ( !turn ) return null;
		turn.failed  = true;
		turn.include = false;
		return turn;
	}

	// ── The window flags ( every write to `include` goes through one of these two ) ──

	/**
	 * Flip ONE turn's window flag — the manual toggle's write. Returns false when the id names no turn, and
	 * when it names a COMPACTED or FAILED one: both are history and nothing re-includes either. That refusal
	 * lives HERE, beside the flag pair, rather than in whichever surface happens to offer the control — an
	 * invariant a caller has to remember is one a second caller will forget.
	 */
	setInclude( turnId: string, include: boolean ): boolean {
		const turn = this.turns.find( ( t ) => t.id === turnId );
		if ( !turn || turn.compacted || turn.failed ) return false;
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
	 * COMPACTED and FAILED turns are never touched, in either direction. That exemption is what lets forty
	 * turns of hand-tuning be escaped in one click without also undoing a compaction the user paid a model
	 * turn for, or re-arming a turn whose tool-call never got its result.
	 */
	resetWindow( keep: Set<string> | null ): void {
		for ( const turn of this.turns ) {
			if ( turn.compacted || turn.failed ) continue;
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
	 * `opts.toolResults` STUBS results older than the last N turns — the cheapest context-engineering lever
	 * ( operate on the transcript, don't just append ). The full text stays on the entry for the inspector,
	 * and rides in the session's result LOG, which is what makes a stub a handle rather than a hole: the
	 * stub names the file and the line, and the agent reads it back with `read_file`. Dormant when absent.
	 *
	 * `opts.imagesAsText` projects an image as its POINTER LINE rather than as an image block, for a tier
	 * whose wire cannot carry one — a text-only model, or a transport that is a string. It exists because
	 * the alternative was each tier dropping the block it could not translate, which turned an injected
	 * image into silence: no bytes, and not even the handle that would have let the agent go read it.
	 * Degrading here rather than at each connector keeps ONE definition of how a file reads.
	 */
	wireMessages( opts?: WireOptions ): WireMessage[] {
		const messages:  WireMessage[] = [];
		const liveTurn  = this.turns[ this.turns.length - 1 ];
		const reduction = opts?.toolResults;
		const stubbed   = this.stubbedResults( opts );
		for ( const turn of this.turns ) {
			const isLiveTurn = turn === liveTurn;
			// Pairs reconciled HERE, per turn, on the way out — never against what is stored. An entry that
			// hydrated as `unreadable` may have been a tool-call, and its surviving `tool_result` would then
			// answer a `tool_use` that is not in the request: not a smaller request, an INVALID one. Doing it
			// at the projection also means the trailing tool-call of a turn that died mid-loop stays in the
			// itinerary, where it is the diagnosis, while never reaching a provider.
			for ( const entry of Transcript.reconcilePairs( turn.entries ) ) {
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
					// EVERY grant arm follows ONE rule: the LIVE turn is the injection, every prior turn is a
					// handle. That is decay expressed STRUCTURALLY — position in the transcript is the clock, so
					// there is no policy to evaluate, no flag to flip after a send, and no failed turn that can
					// burn an injection. Re-injecting is simply attaching again, which the account records as a
					// second event rather than a mutation of the first.
					//
					// `contents` is transient and main-supplied. Absent on the live turn means the read FAILED, and
					// the model is told so rather than handed silence — a user who injected a file and got
					// nothing would reasonably assume it arrived, and the agent would answer from thin air.
					//
					// REMOVAL IS NOT A WIRE EVENT. A removed entry keeps riding exactly as it rode before, and a
					// compaction pass drops it for real. Honouring it here would rewrite a prior turn to save a
					// pointer and re-prefill everything downstream — the trade backwards, and the reason removal
					// was deferred in the first place. What the user sees change is the gutter and the itinerary.
					case 'injected-file':
					// A folder and a tool ride the same rule and the same reader. Neither carries a whole form
					// YET — the listing and the schema are compiled by their backing tool, which is a later
					// phase — so both currently project their reference line on every turn including the live
					// one. When that compile lands it supplies `contents`, and this branch lights up with no
					// change here: the live-turn arm already prefers contents when there are any.
					case 'injected-folder':
					case 'injected-tool': {
						this._appendBlock( messages, 'user', { type: 'text', text: Transcript._grantText( entry, isLiveTurn ) } );
						break;
					}
					case 'image': {
						// The one place the two kinds diverge, and why they stay two kinds: an image's bytes ride
						// as an IMAGE block, which the connector maps to the provider's nested source shape. Off
						// the live turn there is no cheap form of an image — the bytes ARE the payload — so the
						// reference form is a line of text and the block kind legitimately changes.
						//
						// A tier that cannot carry the block takes the same reference form ( `imagesAsText` ), so
						// it gets a handle it can act on instead of a block it will quietly discard.
						//
						// That degrade is decided HERE and not by `_grantText`, which honours live-ness and
						// would inline the payload as text — the right answer for a text file being injected, and
						// the wrong one for an image every time. Base64 as prose is the payload stripped of the
						// only thing that made it worth carrying: unreadable to the model, and large enough to
						// displace the context it was meant to add. A read that FAILED still falls through, so
						// the model is told so rather than handed a pointer to something that was never read.
						if ( isLiveTurn && entry.contents ) {
							if ( !opts?.imagesAsText ) {
								this._appendBlock( messages, 'user', { type: 'image', mediaType: entry.mediaType, data: entry.contents } );
								break;
							}
							this._appendBlock( messages, 'user', { type: 'text', text: framePointer( entry.name, entry.path ) } );
							break;
						}
						this._appendBlock( messages, 'user', { type: 'text', text: Transcript._grantText( entry, isLiveTurn ) } );
						break;
					}
					case 'assistant':
						this._appendBlock( messages, 'assistant', { type: 'text', text: entry.text } );
						break;
					case 'tool-call':
						this._appendBlock( messages, 'assistant', { type: 'tool_use', id: entry.id, name: entry.name, input: entry.input } );
						break;
					case 'tool-result': {
						// A stubbed result stops re-riding as raw text; it stays whole on the entry for the
						// inspector, and whole in the session's result LOG for the agent. The block KIND never
						// changes — a stub is still a `tool_result` answering its `tool_use`, which is what keeps a
						// reduced transcript valid by construction rather than by a rule someone has to remember.
						const content = reduction && stubbed.has( entry.toolUseId )
							? frameToolResultStub( reduction.logPath, reduction.lines?.get( entry.toolUseId ), entry.toolUseId )
							: entry.content;
						this._appendBlock( messages, 'user', { type: 'tool_result', tool_use_id: entry.toolUseId, content, ...( entry.isError ? { is_error: true } : {} ) } );
						break;
					}
					case 'unreadable':
						// NEVER projected, on the same rule as `error` below: this is the account of a row this
						// build could not read, and the model has no use for our storage problems. A placeholder
						// would be worse than the gap — it invites the model to reason about content that was
						// never in the conversation.
						break;
					case 'error':
						// NEVER projected. A model is not told that a turn failed — the turn carrying this is
						// rolled back off the wire in its entirety, and the entry survives purely as the account
						// of what was attempted. Handled EXPLICITLY rather than filtered upstream so that this
						// decision is stated at the projection, where a future reader would otherwise wonder
						// whether the omission was deliberate.
						break;
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
	 *
	 * `stubs` is what the WIRE is about to do to these entries — id → the text riding in their place. Handed
	 * IN rather than computed here for a structural reason: this method runs over the whole transcript and
	 * the rule counts over the PROJECTED one, so a transcript cannot answer it about itself. Omitted, no row
	 * is marked — which is honest for a caller that never asked what rides.
	 */
	turnRows( stubs?: Map<string, string> ): TranscriptTurn[] {
		return this.turns.map( ( turn ) => {
			const rows = turn.entries.map( ( entry ) => this._row( entry, stubs ) );
			return {
				id:        turn.id,
				startedAt: turn.startedAt,
				rows,
				tokens:    rows.reduce( ( sum, r ) => sum + r.tokens, 0 ),
				failed:    turn.failed
			};
		} );
	}

	private _row( entry: TurnEntry, stubs?: Map<string, string> ): TranscriptRow {
		const displayOnly = !WIRE_KINDS.has( entry.kind );
		// Guarded by KIND rather than by the map's key space. Only a tool-result can stub and no other entry
		// carries a `toolUseId`, so the lookup could not collide — but a reader should not have to work that
		// out from the keys to trust the line.
		const stub = entry.kind === 'tool-result' ? stubs?.get( entry.toolUseId ) : undefined;
		return {
			at:     entry.at,
			kind:   entry.kind,
			label:  Transcript._label( entry ),
			text:   Transcript._entryText( entry ),
			// The STUB's weight when one rides — the same rule `estimateTokens()` applies to the same entry,
			// so a turn's total here and the gauge's number cannot disagree about what this row costs.
			tokens: displayOnly ? 0 : stub ? KCDPrimitive._estimateTokens( stub ) : Transcript._entryTokens( entry ),
			...( entry.rowId !== undefined ? { rowId: entry.rowId } : {} ),
			...( stub ? { stub } : {} ),
			displayOnly,
			display: Transcript._display( entry )
		};
	}

	// ── Cost ───────────────────────────────────────────────────────────────────

	/** The transcript's wire token weight — the self-priced sum over the WIRE-bearing entries ( thinking
	 *  excluded ). Folds onto agent.estimateTokens() to give the session's whole context cost.
	 *
	 *  Takes the SAME options `wireMessages()` does, and must: a reduction the wire applies and the gauge
	 *  does not is a gauge reporting a cost nobody is paying. A stubbed result prices as its stub. */
	estimateTokens( opts?: WireOptions ): number {
		const reduction = opts?.toolResults;
		const stubbed   = this.stubbedResults( opts );
		let total = 0;
		for ( const turn of this.turns ) {
			for ( const entry of turn.entries ) {
				if ( !WIRE_KINDS.has( entry.kind ) ) continue;
				if ( reduction && entry.kind === 'tool-result' && stubbed.has( entry.toolUseId ) ) {
					total += KCDPrimitive._estimateTokens(
						frameToolResultStub( reduction.logPath, reduction.lines?.get( entry.toolUseId ), entry.toolUseId )
					);
					continue;
				}
				total += Transcript._entryTokens( entry );
			}
		}
		return total;
	}

	// ── Per-entry helpers ( static — pure over one entry ) ─────────────────────

	/**
	 * How one attachment READS — the single decision every projection asks, replacing `_modeOf` and the
	 * three-state it answered for.
	 *
	 * Three outcomes from one fact ( is this the live turn ) and one supplied value ( did main manage to
	 * read it ). No setting, because there is no longer a setting: the file's contents ride when the user
	 * injects them and a handle rides forever after.
	 *
	 * `removed` is deliberately NOT read here. This is the WIRE reader, and removal is an intent executed at
	 * compaction rather than an edit to what a prior turn says — see the attachment arms in wireMessages().
	 * The display reader ( `_entryText` ) is where it shows.
	 *
	 * ONE reader so the wire, the itinerary and the compactor cannot drift — the same reason `_modeOf`
	 * existed. What changed is that the answer is now derived from where the entry SITS rather than from
	 * something stored on it.
	 */
	static _grantText( entry: Grant, isLiveTurn: boolean ): string {
		if ( !isLiveTurn ) return Transcript._grantReference( entry );
		// `contents` carries RAW material for a file and ALREADY-FRAMED text for a folder or a tool, and the
		// asymmetry is deliberate rather than sloppy. A file's whole form is its bytes, which frame here in
		// one line. A folder's needs its entries STRUCTURED to apply the cap, and a tool's needs a schema
		// object — neither survives a `string` transient. So main renders those two through this module's own
		// `frameFolderListing` / `frameToolSurface` and hands over the result: the framing definition still
		// lives here and is still tested here, which is the property that actually mattered. The alternative
		// was a second transient field per payload shape.
		// PRESENCE, not truthiness. `contents` is `string | undefined`, so an empty file is `''` — which is
		// falsy, and testing it as a boolean reported a successfully-read empty file as a read FAILURE. The two
		// states were always distinguishable in the type; the check simply was not asking the question the
		// field answers. An empty file is a legitimate state and rides as an empty body.
		//
		// It is not cosmetic. `write` is whole-file replace with no append, so an agent told a populated file
		// was unreadable is one blind write away from destroying it — and this arm is exactly what would have
		// told it that. The empty case is only low-stakes by luck of there being nothing to lose.
		if ( entry.contents !== undefined ) {
			return entry.kind === 'injected-file' || entry.kind === 'image'
				? frameFile( entry.name, entry.contents )
				: entry.contents;
		}
		// A FILE with NO contents field on the live turn means the read FAILED, and the model is told so
		// rather than handed silence. A folder or a tool has no compile yet, so absence there is ordinary and
		// it simply reads as its reference — when that compile lands, absence becomes a failure for them too
		// and this arm should grow the same distinction.
		if ( entry.kind === 'injected-file' || entry.kind === 'image' ) {
			return frameFailedInjection( entry.name, entry.path, 'not read' );
		}
		return Transcript._grantReference( entry );
	}

	/** A grant's REFERENCE form — what it rides on every turn after the one that injected it, and the whole
	 *  of what "falls out of context" means here. One place, because the wire, the itinerary, the digest and
	 *  the pricing all have to agree on what a handle costs and says. */
	static _grantReference( entry: Grant ): string {
		switch ( entry.kind ) {
			case 'injected-folder': return frameFolder( entry.path );
			case 'injected-tool':   return frameTool( entry.server, entry.name );
			default:                return framePointer( entry.name, entry.path );
		}
	}

	/**
	 * One entry serialized FOR STORAGE — the two base transients removed.
	 *
	 * `rowId` says where the entry lives, not what it is: persisting it inside the payload would put a
	 * second, copyable answer next to the column that owns it, and a fork duplicates payload text into
	 * rows with different ids. `contents` is main's transient file read, which the whole attachment model
	 * exists to keep OUT of the row — a 3 MB screenshot must cost a few hundred bytes of storage and
	 * nothing at all in memory at boot.
	 *
	 * Here rather than at either call site because there are two of them — the turn INSERT and the
	 * per-entry update — and the invariant is asserted in a dozen doc comments across both processes. A
	 * strip that lives next to the fields it strips cannot fall out of step with an arm someone adds.
	 */
	static entryPayload( entry: TurnEntry ): string {
		const { rowId: _rowId, contents: _contents, ...rest } = entry;
		return JSON.stringify( rest );
	}


	/**
	 * The token weight of ONE wire-bearing entry — the one place a kind's cost formula lives. Text kinds
	 * are chars÷4; an image is priced by PIXEL AREA, never by its bytes. Callers gate on WIRE_KINDS first,
	 * so a display-only kind ( thinking ) never reaches here.
	 *
	 * `isLive` defaults FALSE because the question every gauge asks is "what will the NEXT send cost", and
	 * on the next send every entry that already exists is a prior turn — a handle. Only an injection being
	 * composed right now prices at full weight. An attachment prices from its stored METADATA ( `bytes`,
	 * `width`/`height` ), never from its contents, which is what lets the gauge stay honest without opening
	 * a single file.
	 */
	static _entryTokens( entry: TurnEntry, isLive = false ): number {
		if ( isGrant( entry ) ) {
			// A removed entry still RIDES until a compaction drops it, so it still costs its reference. Pricing
			// it at zero the moment the user asked would report a saving that has not happened yet.
			if ( !isLive ) return KCDPrimitive._estimateTokens( Transcript._grantReference( entry ) );
			if ( entry.kind === 'image' ) return estimateImageTokens( entry.width, entry.height );
			if ( entry.kind === 'injected-file' ) return Math.ceil( entry.bytes / 4 );
			// A folder's listing and a tool's schema are compiled by their backing tool, which has not landed.
			// Until it does the live form IS the reference form, and pricing it as anything else would be the
			// gauge reporting a cost nobody pays.
			return KCDPrimitive._estimateTokens( Transcript._grantReference( entry ) );
		}
		return KCDPrimitive._estimateTokens( Transcript._entryText( entry ) );
	}

	/**
	 * Rebuild ONE entry from its stored payload — the single door every hydration path goes through, and a
	 * TOTAL function: it returns a typed entry or an `unreadable` one, never nothing.
	 *
	 * It exists because the inline version it replaced asserted its way past the question. `{ ...payload,
	 * at } as unknown as TurnEntry` checked that `kind` was a string and nothing else, so a `tool-call`
	 * missing its `id` hydrated cleanly, rode the wire, and failed at the PROVIDER as a 400 with nothing
	 * pointing back at the row. A double cast is a claim nobody verified; this is the verification.
	 *
	 * `at` and `rowId` come from the COLUMNS, never from the payload. That is where each actually lives,
	 * and a payload duplicated into a different row by `copyTurns` would otherwise carry a stale id.
	 */
	static parseEntry( payload: string, at: number, rowId?: number ): TurnEntry {
		const unreadable = ( originalKind: string | null, reason: string ): TurnEntry => {
			const entry: TurnEntry = { at, kind: 'unreadable', originalKind, reason, payload };
			if ( rowId !== undefined ) entry.rowId = rowId;
			return entry;
		};

		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse( payload ) as Record<string, unknown>;
		} catch {
			return unreadable( null, 'payload is not valid JSON' );
		}
		if ( !raw || typeof raw !== 'object' ) return unreadable( null, 'payload is not an object' );

		const kind = raw[ 'kind' ];
		if ( typeof kind !== 'string' ) return unreadable( null, 'no kind discriminant' );

		const spec = ENTRY_SPECS[ kind as TurnEntry[ 'kind' ] ];
		// An unknown kind is most likely a NEWER one — a build reading a database a later build wrote,
		// which on a branch that adds a kind is an ordinary Tuesday rather than corruption. Reported as
		// what it is, so switching back repairs it by simply being able to parse again.
		if ( !spec ) return unreadable( kind, `unknown kind '${ kind }' — written by a newer build?` );

		for ( const field of Object.keys( spec ) ) {
			if ( typeof raw[ field ] !== spec[ field ] ) {
				return unreadable( kind, `${ kind }: '${ field }' must be ${ spec[ field ] }` );
			}
		}

		const entry = { ...raw, at } as unknown as TurnEntry;
		if ( rowId !== undefined ) entry.rowId = rowId;
		return entry;
	}

	/**
	 * Enforce the tool-pair invariant WITHIN one turn — every `tool_use` answered by exactly one
	 * `tool_result` and vice versa. Returns the survivors; the caller reports what went missing by
	 * comparing lengths, which is all any caller has needed so far.
	 *
	 * The invariant is the PROVIDER's, not ours: an orphaned `tool_result` is not a smaller request, it is
	 * an invalid one. Turn atomicity does not cover this — it protects pairs against WINDOWING, where a
	 * whole turn rides or does not, and says nothing about an entry going missing from inside a turn that
	 * rides. Hydration does exactly that whenever a payload lands as `unreadable`, which means this has
	 * been reachable since the transcript was first persisted.
	 *
	 * Runs at the PROJECTION and nowhere else. Reconciling what is STORED would erase the trailing
	 * tool-call of a turn that died mid-loop — which is the diagnosis, and the whole reason a failed turn
	 * is kept. It also means a repaired row heals with no further action: nothing was thrown away.
	 */
	static reconcilePairs( entries: TurnEntry[] ): TurnEntry[] {
		const callIds   = new Set<string>();
		const resultIds = new Set<string>();
		for ( const entry of entries ) {
			if ( entry.kind === 'tool-call' )   callIds.add( entry.id );
			if ( entry.kind === 'tool-result' ) resultIds.add( entry.toolUseId );
		}

		const kept: TurnEntry[] = [];
		for ( const entry of entries ) {
			if ( entry.kind === 'tool-call'   && !resultIds.has( entry.id ) )        continue;
			if ( entry.kind === 'tool-result' && !callIds.has( entry.toolUseId ) )   continue;
			kept.push( entry );
		}
		return kept;
	}

	/**
	 * Which tool-results STUB on this projection — the one place that rule lives.
	 *
	 * A SET rather than a predicate because THREE readers need it and only one of them walks turns by index:
	 * computing it once and consulting it three times is what stops `estimateTokens()` from reporting a saving
	 * `wireMessages()` is not taking, and the itinerary from marking a row the wire sent whole.
	 *
	 * PUBLIC for that third reader alone. `Session._resultStubs()` calls it on the PROJECTION and hands the
	 * answer down to the itinerary, which runs over the WHOLE transcript and therefore cannot compute this
	 * itself: counting "the last N" over every turn there ever was answers a different question.
	 *
	 * Counted over the PROJECTED turns, which is correct: "the last N turns" means the last N that ride, and
	 * a turn a compaction already replaced is not one of them. That is deliberately NOT the same counting as
	 * the line map, which spans all of history — see `Session._resultLines`.
	 */
	stubbedResults( opts?: WireOptions ): Set<string> {
		const out = new Set<string>();
		const keep = opts?.toolResults?.keepTurns;
		if ( keep === undefined ) return out;
		const cutoff = this.turns.length - Math.max( 0, keep );
		for ( const [ i, turn ] of this.turns.entries() ) {
			if ( i >= cutoff ) continue;
			for ( const entry of turn.entries ) {
				if ( entry.kind === 'tool-result' ) out.add( entry.toolUseId );
			}
		}
		return out;
	}

	/** The entry's body as text — what it costs and what the itinerary shows. */
	static _entryText( entry: TurnEntry ): string {
		switch ( entry.kind ) {
			case 'user':          return entry.text;
			case 'assistant':     return entry.text;
			case 'thinking':      return entry.text;
			case 'tool-call':     return `${ entry.name } ${ JSON.stringify( entry.input ?? {} ) }`;
			case 'tool-result':   return entry.content;
			// The RESTING projection, which is what the itinerary shows. An entry's contents are never stored
			// and never on the row: what the account records is that a file was injected here, and the handle
			// to go read it. `isLiveTurn: false` is right even for the entry currently being composed — by the
			// time a person is reading the itinerary, that turn is history like any other.
			//
			// This is also the one place removal SHOWS before compaction executes it. The wire deliberately
			// does not read this — a removed entry rides unchanged, and only a person is told sooner.
			case 'injected-file':
			case 'image':
			case 'injected-folder':
			case 'injected-tool': return entry.removed ? frameRemoved( entry.name ) : Transcript._grantText( entry, false );
			// The COPY-PASTE body, and the reason this entry exists at all: everything known about the
			// failure, in the order a person reads it, as one selectable block. The provider's own body is
			// last and VERBATIM — it is the part that names the offending block of a rejected request, and
			// clipping it here would leave the reader with a summary of the thing they came to read.
			case 'error':         return Transcript._errorText( entry );
			// The REASON, not the payload. This is what the itinerary shows, and a person scanning it needs to
			// know what broke and that it is fixable — the raw bytes are on the entry for anyone who wants
			// them, and the row is still in the table under its own id.
			case 'unreadable':    return entry.originalKind
				? `[unreadable ${ entry.originalKind } entry — ${ entry.reason }]`
				: `[unreadable entry — ${ entry.reason }]`;
			default:              return Assert.never( entry );
		}
	}

	/**
	 * One entry as a SUMMARISING pass should see it — the third audience for this union, after the wire
	 * and the inspector.
	 *
	 * A 50k file handed whole to the house agent is the thing compaction exists to prevent, arriving
	 * inside compaction itself. So past a limit a body stops being included and starts being DESCRIBED
	 * from its own head, which is all the pass needs: what it is being asked for is a name plus a line on
	 * why a later agent would want this.
	 *
	 * Dispatched by SPECIES, one helper each, because "how much of this is worth showing" has a different
	 * answer per type and those answers will keep diverging — a PDF wants its title page, a spreadsheet
	 * wants its headers. Adding one is a new helper and a new line here, and nothing else moves.
	 *
	 * The fallthrough is deliberate and safe: any kind with no special handling reads as it does in the
	 * inspector, which is honest prose for every remaining kind ( user, assistant, tool-call,
	 * tool-result ). A new kind that needs a digest gets one; a new kind that does not still works.
	 */
	static digestText( entry: TurnEntry ): string {
		// An attachment has no body to digest — the transcript stores a HANDLE. That closes the
		// contamination hole STRUCTURALLY rather than by rule: there is no stored body to summarise as
		// though the conversation had read it, so a summary cannot assert knowledge it never had.
		//
		// `_digestFile`'s head-truncation and `_digestImage`'s description both went with the stored body,
		// and the guard against handing a 50k file to the house agent went with them — there is no longer a
		// path by which that could happen. Three pieces of machinery collapsed into one line, which is what
		// it looks like when a model stops fighting its storage.
		//
		// `removed` digests to NOTHING, and that is the removal being EXECUTED rather than a display rule: the
		// file does not enter the summary that replaces its turn, so it leaves the account at the same moment
		// its entry does. `_turnText` already drops empty digests, so no caller learns a new rule.
		if ( isGrant( entry ) ) {
			return entry.removed ? '' : Transcript._grantReference( entry );
		}
		return Transcript._entryText( entry );
	}

	/** An error entry's full text. Sections are dropped when absent rather than printed empty: a socket
	 *  fault has no status and no body, and `status: —` is noise pretending to be information. */
	static _errorText( entry: Extract<TurnEntry, { kind: 'error' }> ): string {
		const parts: string[] = [];
		parts.push( entry.status ? `${ entry.status } ${ entry.code }` : entry.code );
		if ( entry.message ) parts.push( entry.message );
		for ( const [ key, value ] of Object.entries( entry.detail ?? {} ) ) {
			parts.push( `${ key }: ${ typeof value === 'string' ? value : JSON.stringify( value ) }` );
		}
		if ( entry.body ) parts.push( entry.body );
		return parts.join( '\n\n' );
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
			// The house tokens each already wears: a folder reads as navigation, a granted tool as the package
			// hue every MCP surface uses — so the itinerary agrees with the deck tile beside it.
			case 'injected-folder': return { icon: 'folder',  color: '--accent' };
			case 'injected-tool':   return { icon: 'package', color: '--plugin' };
			// `stop`, deliberately NOT the `warning` a failed tool-result wears. Both are --error, and that is
			// right — they are the same family — but they are not the same event: a tool that errored is
			// survivable and the turn carried on past it, while this is the row where the turn ENDED. Sharing
			// one glyph made a hiccup and a death look identical in a scan down the itinerary.
			case 'error':         return { icon: 'stop',      color: '--error' };
			// `warning`, not `stop`. A turn that ENDED is a different event from a row we could not read
			// inside a turn that otherwise completed — and unlike either error case this one is REPAIRABLE,
			// so it reads as a flag to act on rather than a death to investigate.
			case 'unreadable':    return { icon: 'warning',   color: '--error' };
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
			case 'injected-folder': return `folder ${ entry.name }`;
			// Qualified, because two servers may legitimately ship a tool of one name and a bare label would
			// make the two rows indistinguishable in a scan.
			case 'injected-tool':   return `tool ${ entry.server }.${ entry.name }`;
			// Leads with the status because "is this mine, theirs, or the network's" is the question a
			// failed turn is scanned to answer.
			case 'error':         return entry.status ? `error ${ entry.status } ${ entry.code }` : `error ${ entry.code }`;
			// Leads with the ROW, because the row id is the repair path ( `database.set_turn_entry` ) and a
			// label naming only the problem would send the reader to a database to find out which one.
			case 'unreadable':    return entry.rowId !== undefined ? `unreadable row ${ entry.rowId }` : 'unreadable entry';
			default:              return Assert.never( entry );
		}
	}
}
