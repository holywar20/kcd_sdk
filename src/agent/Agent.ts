import { LensObject } from '../primitives/framework/LensObject';
import { SlotResolver } from '../primitives/framework/SlotResolver';
import type { SlotResolution } from '../primitives/framework/SlotResolver';
import { ContextAssembler, MANIFEST_SECTIONS } from '../primitives/framework/ContextAssembler';
import { KcdContext } from '../core/html/KcdContext';
import type { Command } from '../core/Command';
import type { SlotRow } from '../core/html/KcdContext';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SegmentKey, SerializedArtifact, SerializedLens, SlotMode, SourceLayer, TaggedBlock } from '../primitives/types';

/**
 * A habit in the COMPOSITION view: an inventory entry, not a compiled block, so one that loses its slot stays listed.
 * See `Agent.habitSlots()`.
 */
export interface HabitSlotCandidate {
	path:        string;
	/** the mutual-exclusion class, or null for a bare drop-in that contends nothing. */
	habitClass:  string | null;
	sourceLayer: SourceLayer;
	/** the mode it compiles at: the agent's own habit is `load` or `on`; a lens's is what the lens authored. */
	mode:        SlotMode;
	won:         boolean;
}

/**
 * One row per artifact in an agent's compiled context, costed from the real compiled output at its effective mode.
 * `tokens` is never a re-derived estimate.
 */
export interface CompositionRow {
	/** The artifact's own path — the row's identity. */
	path:   string;
	name:   string;
	kind:   ArtifactType;
	/** The lens that contributes this file, or `agent` for one the agent itself bolted on. Attributed once,
	 *  to the first lens that carries it, matching the compile's dedup. */
	source: string;
	/** The mutual-exclusion SLOT this file competes in, from its `habit-class` frontmatter, or null. Two files
	 *  sharing a slot means only one reaches the compiled context. Lives on the artifact, not the habit type. */
	slot:   string | null;
	mode:   SlotMode;
	tokens: number;
}

/** One habit-class's composition view: every candidate that declared the class, and which one wins. A
 *  classless habit gets its own single-candidate entry with `habitClass: null`. */
export interface HabitSlotView {
	habitClass: string | null;
	winner:     HabitSlotCandidate;
	candidates: HabitSlotCandidate[];
}
import { ACCOUNTLESS_ACCOUNT_ID, DEFAULT_MODEL_KEY, REASONING_EFFORTS, type ReasoningEffort } from './Model';
// TYPE-ONLY, so no runtime edge back into the session module ( `Session.ts` imports `Agent` as a type too ).
// The policy SHAPE is the session's: an agent's default must be stated in the currency a session stores.
import type { ReasoningPolicy } from '../session/TurnEntry';
import { carries, type ToolMode } from '../primitives/ToolAccess';
import type { ToolDef } from './ToolDef';

/*
 * An Agent has NO status: it is configuration, and run state lives on `Session.turnStatus`, one flag per run.
 */

/**
 * The wire / DB-seed form of an Agent: light and declarative. The `composed*` materialization is NOT here;
 * it is rebuilt from this seed on arrival (see Agent.compose), so it can never ride the wire stale.
 */
export interface SerializedAgent {
	id: string;
	/** The workspace this agent belongs to (`projects.id`). Lens paths are vault-relative, so the project
	 *  rides WITH the agent rather than being inferred. '' only before a row is read. */
	projectId: string;
	name: string;
	/** Presentation — a Glyph name + a color token string (e.g. `var(--generator)`). Null = fall back. */
	icon: string | null;
	color: string | null;
	/** A ModelDescriptor registry key, or null for a vault agent that never dispatches; defaulting one there
	 *  would be a lie a later reader acts on. An authored agent is always concrete. */
	model: string | null;
	/**
	 * An account id, never null: ACCOUNTLESS_ACCOUNT_ID is "nothing stated here", not "charge nobody".
	 * An override, not the answer; seeded at birth and never re-stamped, or work silently changes subscription.
	 */
	account?: string;
	/** The visible top-of-context lever. Null = none; '' is a deliberately empty one. */
	systemPrompt: string | null;
	/** The composed lenses, serialized whole. `[]` = a draft (cannot run yet). `[0]` is primary. */
	lenses: SerializedLens[];
	/**
	 * The habits this agent HOLDS, as paths: its own, never inherited. Tools are NOT here: `toolModes` answers
	 * whether a tool is carried, and a second field could disagree with it silently.
	 */
	baseHabits: string[];
	/** The held habits whose whole text rides; every other held habit rides as its one-line routing row. Taking
	 *  a habit off is removing it from `baseHabits` — there is no off state for a habit the agent still holds. */
	loadedHabits?: string[];
	/**
	 * `baseHabits` materialized into artifacts the SlotResolver can rank. Derived, NOT a second source of truth:
	 * `baseHabits` is authoritative and persisted; these are rebuilt from it on every main-side load.
	 */
	baseHabitNodes?: SerializedArtifact[];
	/** Lenses the record names that did not load — see `BrokenLens`. */
	brokenLenses?: BrokenLens[];
	/** Habits the record names that did not load — see `BrokenHabit`. */
	brokenHabits?: BrokenHabit[];
	/**
	 * THE SKILLS THIS AGENT HOLDS, as SLUGS — its own, never inherited. A lens supplies no skills to an
	 * agent, the same rule `baseHabits` states and for the same reason.
	 *
	 * SLUGS AND NOTHING ELSE. No name, no description, no path, no copy of anything the library holds — the
	 * library is the authority on what a skill IS; this says only which ones the agent holds.
	 *
	 * A SLUG THAT NO LONGER RESOLVES IS AN ABSENCE, not a fault. The attachment row survives on the record
	 * and contributes nothing to a compile; nothing here drops it, repairs it, or throws over it — there is
	 * no `BrokenSkill` twin of `BrokenHabit`, because there is nothing broken to report. That is this step's
	 * boundary: compiling an attachment into context is the next card's job, not this one's.
	 *
	 * A RECORD WRITTEN BEFORE THIS FIELD EXISTED HAS NO `skills` KEY AT ALL, and reads that absence as an
	 * empty list — the same tolerance `baseHabits` itself would need were it not required on the wire. See
	 * `Agent.fromSerialized`, where the `?? []` lives.
	 */
	skills?: string[];
	/**
	 * WHAT THIS AGENT CARRIES, and how much of each one is put in front of it — keyed by tool IDENTITY
	 * ( `group.tool` ).
	 *
	 * PRESENCE IS THE ANSWER. `off` is never stored: a tool absent from here is not carried, is not minted
	 * into the passport, and is refused — absence and denial are one fact rather than two, which is what
	 * makes a denial unable to leak. It is not there.
	 *
	 * ONE FIELD, BECAUSE IT IS ONE QUESTION ( Bryan, 2026-09-22 ). This was `toolPolicies` + `toolSurfaces`,
	 * a permission axis beside a cost axis. An agent has no permission axis: it is a PROTOTYPE, and the run's
	 * papers are minted from it. What is left is how much of a carried tool rides — a line, or the whole
	 * schema — which is the same ladder references and habits already wear.
	 *
	 * NO `ask` HERE. The confirm question is the passport's and the project's; an agent that could also ask it
	 * was a second control writing a value only the passport ever read. See `ToolAccess`.
	 */
	toolModes: Record<string, ToolMode>;
	/** Open typed-field bag — composable config, kept LOOSE at the SDK seam (widget SettingFields). */
	fields: Record<string, unknown>[];
	/** Management / system configuration (model overrides, runtime knobs). Loose by design. */
	system: Record<string, unknown>;
	/** Runtime identity — defaulted in. An agent with no lenses is a draft, derived, not a status. */
	createdAt: number;
	/** Path-style folder string (e.g. "work/writing"). Absent = ungrouped. */
	folder?: string;
	/** Human scratch-pad — per-agent sticky note. Null = empty. */
	notes: string | null;
	/** What this agent is FOR: a one-line, third-party routing fact. Null is legitimate; nothing synthesizes one,
	 *  because a router cannot tell a guess apart from a statement. */
	slug?: string | null;
	/** The reasoning default a spawned session is born on. Null = none stated, which must never collapse into
	 *  "medium". Absent on a wire or row written before the field existed reads as the same null. */
	reasoning?: ReasoningPolicy | null;
}

/** A lens an agent's record names that could not be loaded. Kept on the agent so it can say which lens it
 *  lost, and so a record write puts the id AND ITS NAME back where they were rather than dropping them. */
export interface BrokenLens {
	/** the doc-index id the record holds — frontmatter the document carries, not a key the database minted */
	id:       string;
	/** The lens's name: the index row's, else the name the RECORD stored, else the id. Storing the name is
	 *  the point: an id that resolves to no row would otherwise leave a bare uuid where the name belongs. */
	name:     string;
	/** its place in the authored stack */
	position: number;
	/** `missing`: row or file gone. `invalid`: will not load. `ambiguous`: the name matched several lenses, and
	 *  picking the first would be a guess about which agent this is. */
	reason:   'missing' | 'invalid' | 'ambiguous';
	message?: string;
}

/**
 * The habit twin of `BrokenLens`. No `position`: habits are a deduped set with no order, so one would drift.
 * `loaded` rides along so a repair restores the `{ id, loaded }` pair whole, not merely that a habit existed.
 */
export interface BrokenHabit {
	/** the doc-index id the record holds */
	id:       string;
	/** the habit's last known name, or its id when the index never had one */
	name:     string;
	/** whether the record carried it loaded in full */
	loaded:   boolean;
	reason:   'missing' | 'invalid';
	message?: string;
}

/** The roster form of an Agent — who it is and what it stacks, never loaded content. A list read answers
 *  this; the whole graph is `SerializedAgent`, reached by naming the agent. */
export interface AgentSummary {
	id: string;
	projectId: string;
	name: string;
	model: string | null;
	/** Which account pays, never null (see `SerializedAgent.account`). Rides the roster form: a roster that
	 *  names a model but not the subscription it bills to is half an answer. */
	account: string;
	/** The lens stack as paths, primary first. Nothing is appended beneath it. */
	lensPaths: string[];
}

export interface AgentOptions {
	id?: string;
	/** The owning workspace ( `projects.id` ). Omitted by a bare or test agent; the callers that know it
	 *  ( the row loader, the two birth paths ) supply it. */
	projectId?: string;
	name?: string;
	icon?: string | null;
	color?: string | null;
	/** Omit for the default; pass null explicitly for an agent that never dispatches ( see the field ). */
	model?: string | null;
	/** Omit for the reserved accountless member — "nothing stated", which the host's cascade falls through.
	 *  A birth path that knows the project's default supplies it here; nothing else should. */
	account?: string;
	systemPrompt?: string | null;
	lenses?: LensObject[];
	baseHabits?: string[];
	loadedHabits?: string[];
	/** Slugs only — see `SerializedAgent.skills`. Omit for none. */
	skills?: string[];
	toolModes?: Record<string, ToolMode>;
	fields?: Record<string, unknown>[];
	system?: Record<string, unknown>;
	folder?: string;
	notes?: string | null;
	slug?: string | null;
	reasoning?: ReasoningPolicy | null;
}

/** Pull the paths of every node of a given artifact type out of a flat node list. */
function _pathsOfType( nodes: KCDPrimitive[], type: ArtifactType ): string[] {
	return nodes.filter( ( n ) => n.getType() === type ).map( ( n ) => n.getPath() );
}

/** The tool identities this agent holds. Every writer and reader of a tool's mode files it under `ToolDef.id`,
 *  so they cannot disagree; a def with no id cannot be held, and a bare-name fallback once split one map in two. */
function _heldIds( defs: readonly ToolDef[] ): ToolDef[] {
	return defs.filter( ( d ) => !!d.id );
}

/**
 * Agent — THE composition primitive. Pure data plus one composition method, with no `fs`: it crosses the bridge
 * whole via serialize / fromSerialized. Its only disk-capable member, LensObject, keeps disk behind a main-only reader.
 *
 * Three tiers: `lenses` + `base*` are the declarative SOURCE OF TRUTH, stored and light. `composed*` is materialized
 * by `compose()`; trust the children, since a wrong contribution is a bug in the child, not corrected here.
 * `effective*` = `base* ∪ composed*`, which is what a permissions gate reads.
 *
 * FLUSH-AND-FILL: `compose()` rebuilds `composed*` whole at construction and on every base or lens change; it is never
 * delta-managed. `composed*` is never persisted, because a lens is a file editable out-of-band and that would go stale.
 *
 * A draft is an agent with no lenses (`isDraft()`); "deploy" is a state transition on this object, not a new class.
 */
/**
 * The wire's EXTERNAL layers: everything a compiled context needs beyond the agent's own graph.
 * Every key is optional and applied only when present.
 */
/** One package's injection. `id` is the key a toggle, a deck row and a trace line all read; there is no
 *  tier because a package makes no ranking decision — see `ContextContribution`. */
export type Contribution = {
	id:      string;
	heading: string;
	text:    string;
};

/** What ONE agent overrides about ONE package's injection, stored in its `system.contributions` bag under
 *  the package id. Absent means the package rides on its own declared defaults — enabled is default ON,
 *  because an installed contributor the user never touched is one they asked for by installing it. */
export type ContributionSettings = {
	enabled?: boolean;
	params?:  Record<string, unknown>;
};

export type AgentEnvironment = {
	hostPrompt?:     string;
	/** What the host says about the INSTALLATION this agent is running in — see `Agent.hostEnvironment`. */
	hostEnvironment?: string;
	toolDefs?:       ToolDef[];
	/**
	 * The ids this run may call but its request does NOT carry: exactly the `[schema on request]` tools.
	 * Bound from the same subtraction as the search door, so prompt and request cannot disagree.
	 * Absent on a composition surface, which has no request to subtract from.
	 */
	runDeferred?:    readonly string[];
	searchTool?:     string;
	/**
	 * True on a host that owns the model conversation and so the tool namespace: our deferral cannot apply
	 * there, so a manifest marking rows would describe a cut nothing made. The host states the fact; we word it.
	 */
	hostManagedTools?: boolean;
	contributions?:  Contribution[];
	attachments?:    string;
	grants?:         SlotRow[];
	commands?:       readonly Command[];
	manifestGroups?: readonly { heading: string; body: string }[];
	capability?:     string;
	/** One sentence saying this project's configuration moved since the session's last turn, or ''. Derived at
	 *  `Environment.compile` from `Session.lastConfigStamp`, never pushed, so nothing can be in flight to miss. */
	configNotice?:   string;
	frame?:          string;
	modeLine?:       string;
};

/**
 * A pull-reader for the environment: a receiver that pulls cannot be handed a stale layer. Called on every read,
 * so it owes its own memoization. A key it leaves undefined falls back to whatever `bindEnv` bound.
 */
export type EnvReaderFn = () => AgentEnvironment;

export class Agent {

	readonly id: string;
	/** The workspace this agent belongs to. READONLY: its lens paths are vault-relative, so moving projects is a
	 *  migration, not a field write. */
	readonly projectId: string;
	name: string;
	icon: string | null;
	color: string | null;
	model: string | null;
	/** Never null: the reserved member when nothing is stated. Written only through this accessor, so the
	 *  never-dispatching rule is enforced in one place rather than at four callers. */
	get account(): string { return this._account; }
	set account( value: string | null | undefined ) { this._account = Agent.normalizeAccount( value, this.model ); }
	private _account: string = ACCOUNTLESS_ACCOUNT_ID;
	systemPrompt: string | null;

	/** The composed lenses (materialized graphs). `[]` = draft; `[0]` = primary. */
	lenses: LensObject[];

	/** The habits this agent holds, as paths (see SerializedAgent.baseHabits). */
	baseHabits: string[];
	/** The held habits that load in full (see SerializedAgent.loadedHabits). */
	loadedHabits: string[];
	/** The skills this agent holds, as slugs (see SerializedAgent.skills). Its own, never inherited; a slug
	 *  naming no skill is an absence, not a fault. */
	skills: string[];

	/** What this agent carries, and how much of each rides — presence IS the answer (see
	 *  SerializedAgent.toolModes). */
	toolModes: Record<string, ToolMode>;

	fields: Record<string, unknown>[];
	system: Record<string, unknown>;

	// ── Runtime identity ──
	readonly createdAt: number;
	folder: string | undefined;
	notes: string | null;

	/**
	 * A routing fact for a third party, never given to the agent itself: a self-description shapes behaviour.
	 * Null is the absent case; nothing derives one, since a guessed description is worse than none.
	 */
	get slug(): string | null { return this._slug; }
	set slug( value: string | null | undefined ) { this._slug = Agent.normalizeSlug( value ); }
	private _slug: string | null = null;

	/**
	 * The default a spawned session is born on: read ONCE at creation and stamped onto that session's own policy.
	 * Null is 'none stated', never 'medium'. Never shown to the agent; clamping to a model happens at session creation.
	 */
	get reasoning(): ReasoningPolicy | null { return this._reasoning; }
	set reasoning( value: ReasoningPolicy | null | undefined ) { this._reasoning = Agent.normalizeReasoning( value ); }
	private _reasoning: ReasoningPolicy | null = null;

	// ── composed{X}: MATERIALIZED by compose(); never persisted, never crosses the wire ──
	composedHabits: string[] = [];
	composedReferences: string[] = [];
	composedPlans: string[] = [];
	/** The run's deferred set, bound per turn and never persisted. NULL, not empty, until bound: empty means "this run
	 *  defers nothing", which the manifest must tell apart from "there is no run to ask". */
	get runDeferred(): readonly string[] | null { return this._layer( 'runDeferred' ) ?? null; }

	/**
	 * The agent's own base habits as loaded objects, materialized by main from `baseHabits` and rebuilt on every
	 * load/save so they cannot go stale. They ride the wire for the renderer's view, and are never persisted.
	 */
	baseHabitNodes: KCDPrimitive[] = [];
	/** Lenses the record names that did not load — set by the host that loaded the record. */
	brokenLenses: BrokenLens[] = [];
	/** Habits the record names that did not load, or whose file would not read — set by the host. A habit
	 *  here is NOT in `baseHabits`: the paths are what the agent actually carries, exactly as `lenses` is. */
	brokenHabits: BrokenHabit[] = [];

	// ── Bound environment: the wire's EXTERNAL layers, injected post-hydration ( `bindEnv` ) ──
	// Set from outside, never persisted and never crossing the wire, flush-and-filled on change. With these bound,
	// the agent answers `compiledContext()` / `wireSystem()` / `estimateTokens()` alone.

	/** What the host says to every agent inside it, leading the compiled context. Bound in code by the dispatch
	 *  tier, never in the vault and never user-editable: a user must not rewrite the app's account of its surfaces. */
	get hostPrompt(): string { return this._layer( 'hostPrompt' ) ?? ''; }
	/**
	 * What the host says about the installation this agent runs in. Its own layer, not part of `hostPrompt`: that
	 * block is code-authored under a fixed ceiling, while this one is part live state and part person-written.
	 */
	get hostEnvironment(): string { return this._layer( 'hostEnvironment' ) ?? ''; }
	/** The live tool defs available to this agent — the flat set the manifest + preload surface read,
	 *  each carrying its BAKED per-mode counts. Bound from the MCP store; `[]` until bound. */
	get toolDefs(): ToolDef[] { return this._layer( 'toolDefs' ) ?? []; }
	/** The name of the tool that fetches a deferred schema, as the model calls it. Bound by the host, so this
	 *  package never spells a name it does not own; unset, the manifest's note stays mechanism-free. */
	get searchTool(): string { return this._layer( 'searchTool' ) ?? ''; }
	/** WHETHER THE HOST, NOT US, DECIDES WHICH TOOLS ARE LOADED — see `AgentEnvironment.hostManagedTools`.
	 *  False until bound, which is the ordinary wire lane: we cut the request, so we can say what is deferred. */
	get hostManagedTools(): boolean { return this._layer( 'hostManagedTools' ) ?? false; }
	/** What the installed contributors returned for this run, each carrying its band. `[]` emits nothing, whether
	 *  unbound, uninstalled, or every contributor came back dry. */
	get contributions(): Contribution[] { return this._layer( 'contributions' ) ?? []; }
	/** The bound session's PREFILL attachments, already composed to a string. An agent reaching into `session/`
	 *  for the entry array would invert the layering: a session is a run of an agent, not the reverse. */
	get attachments(): string { return this._layer( 'attachments' ) ?? ''; }
	/** The bound session's canonized grants, as STRUCTURED ROWS: the manifest section is merged from `rows` and never
	 *  re-parsed from text. Only the hoisted set arrives; a grant whose turn still rides is already in the transcript. */
	get grantRows(): SlotRow[] { return this._layer( 'grants' ) ?? []; }
	/** The commands this run may run, as objects. Denied ones are ALREADY REMOVED, not present-and-refused: "the
	 *  agent has not heard of it" is only true in that shape. `[]` is a legitimate answer. */
	get commandRows(): readonly Command[] { return this._layer( 'commands' ) ?? []; }
	/**
	 * The manifest bands this run's tools author for themselves: each a `##` section under `# Manifest`, composed
	 * and narrowed by the host (the passport alone says what is refused), and sorted: order is a prefix-cache contract.
	 */
	get manifestGroups(): readonly { heading: string; body: string }[] { return this._layer( 'manifestGroups' ) ?? []; }
	/** What this run holds, said to the agent: opaque text the host composes from the run's passport. Not derived
	 *  here, because two authors of a permission description produce one that is reassuring and wrong. */
	get capability(): string { return this._layer( 'capability' ) ?? ''; }
	/** One sentence saying the project configuration moved since the session's last turn. Opaque bound text:
	 *  whether anything changed is dispatch's question. */
	get configNotice(): string { return this._layer( 'configNotice' ) ?? ''; }
	/** The caller's layer above the lens: a room or Constellation frame, bound per round. It trails the identity,
	 *  since general comes before specific: a standing identity is true of every turn, a frame of exactly one. */
	get frame(): string { return this._layer( 'frame' ) ?? ''; }
	/** The turn's prompt-SHAPING line (today, the thinking-mode request). Opaque bound text: deciding what shapes
	 *  a turn is dispatch policy, and this object only knows where the answer sits. */
	get modeLine(): string { return this._layer( 'modeLine' ) ?? ''; }

	/** What a host BOUND ( `bindEnv` ) — the push half, kept for the dispatch tier, which assembles one
	 *  environment per round and has nothing to read through. Replaced wholesale on each bind. */
	private _bound: AgentEnvironment = {};

	/** What the agent READS its environment through, when something injected one. `null` on every
	 *  SDK-built agent and on main's, which are bound rather than read. */
	private _env: EnvReaderFn | null = null;

	/**
	 * One layer of the environment: the reader's answer, else what a host bound. The reader wins where it answers,
	 * and an undefined key falls through, so a reader never blanks a layer only a host can supply.
	 */
	private _layer<K extends keyof AgentEnvironment>( key: K ): AgentEnvironment[ K ] | undefined {
		const read = this._env ? this._env()[ key ] : undefined;
		return read !== undefined ? read : this._bound[ key ];
	}

	private constructor(
		id: string,
		projectId: string,
		name: string,
		icon: string | null,
		color: string | null,
		model: string | null,
		account: string | null | undefined,
		systemPrompt: string | null,
		lenses: LensObject[],
		baseHabits: string[],
		loadedHabits: string[],
		skills: string[],
		toolModes: Record<string, ToolMode>,
		fields: Record<string, unknown>[],
		system: Record<string, unknown>,
		createdAt: number,
		folder: string | undefined,
		notes: string | null,
		slug: string | null,
		reasoning: ReasoningPolicy | null,
	) {
		this.id             = id;
		this.projectId      = projectId;
		this.name           = name;
		this.icon           = icon;
		this.color          = color;
		this.model          = model;
		// AFTER `model`, and that order is load-bearing: the accessor reads it to force the reserved member
		// onto an agent that never dispatches, so assigning the account first would normalize against null.
		this.account        = account;
		this.systemPrompt   = systemPrompt;
		this.lenses         = lenses;
		this.baseHabits     = baseHabits;
		this.loadedHabits   = loadedHabits;
		this.skills         = skills;
		this.toolModes      = toolModes;
		this.fields         = fields;
		this.system         = system;
		this.createdAt      = createdAt;
		this.folder         = folder;
		this.notes          = notes;
		this.slug           = slug;   // through the accessor — the cap is enforced in one place
		this.reasoning      = reasoning;   // through the accessor too — one validator, not one per caller
		this.compose();   // materialize composed{X} from the lenses on the way in
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** The slug ceiling in characters: a router reads slugs off a roster, so an unbounded one is a context leak. */
	static readonly SLUG_MAX = 120;

	/** The one normalizer every write goes through. Clamped rather than refused, since a dropped edit is the worse failure;
	 *  empty, blank and undefined all land on null: absent is one state, not three. */
	static normalizeSlug( value: string | null | undefined ): string | null {
		if( value == null ) return null;
		// Newlines fold to spaces so the roster stays one line and the cap measures what a reader sees.
		const flat = value.replace( /\s+/g, ' ' ).trim();
		return flat === '' ? null : flat.slice( 0, Agent.SLUG_MAX );
	}

	/**
	 * The one normalizer every write of `reasoning` goes through. Absent, null and an unreadable shape all become null.
	 * Refused rather than repaired, unlike a slug: guessing which stop somebody meant would invent a default.
	 */
	static normalizeReasoning( value: ReasoningPolicy | null | undefined ): ReasoningPolicy | null {
		if( value == null || typeof value !== 'object' ) return null;
		const effort = value.effort;
		const mode   = value.mode;
		if( !REASONING_EFFORTS.includes( effort as ReasoningEffort ) ) return null;
		if( mode !== 'chain' && mode !== 'show' ) return null;
		return { effort, mode };
	}

	/**
	 * The one normalizer for `account`: absent, null, blank and the reserved id all become the reserved id.
	 * Non-dispatching agents always get it (an account there would be a false billing claim); no roster check here.
	 */
	static normalizeAccount( account: string | null | undefined, model: string | null ): string {
		if( model === null ) return ACCOUNTLESS_ACCOUNT_ID;
		const flat = typeof account === 'string' ? account.trim() : '';
		return flat === '' ? ACCOUNTLESS_ACCOUNT_ID : flat;
	}

	/** Compose an agent. A lensless draft is legal — running is what demands a lens. An agent with no name
	 *  given takes its primary lens's, and a draft is just `'agent'`. */
	static create( opts: AgentOptions = {} ): Agent {
		const lenses = opts.lenses ?? [];
		return new Agent(
			opts.id ?? crypto.randomUUID(),
			opts.projectId ?? '',
			opts.name ?? lenses[ 0 ]?.getName() ?? 'agent',
			opts.icon ?? null,
			opts.color ?? null,
			// `=== undefined`, never `??`: absent is the default model, explicit null is a vault agent that never
			// dispatches, and `??` would collapse the two.
			opts.model === undefined ? DEFAULT_MODEL_KEY : opts.model,
			opts.account,
			opts.systemPrompt ?? null,
			lenses,
			opts.baseHabits ?? [],
			opts.loadedHabits ?? [],
			opts.skills ?? [],
			opts.toolModes ?? {},
			opts.fields ?? [],
			opts.system ?? {},
			Date.now(),
			opts.folder,
			opts.notes ?? null,
			opts.slug ?? null,
			opts.reasoning ?? null,
		);
	}

	/** Rebuild from the wire / DB seed — each lens hydrates through its own registered hydrator;
	 *  the constructor re-runs compose() so the materialized graph arrives fresh, never stale. */
	static fromSerialized( json: SerializedAgent ): Agent {
		const lenses = ( json.lenses ?? [] ).map( ( l ) => LensObject.fromSerialized( l ) );
		const agent = new Agent(
			json.id,
			json.projectId ?? '',   // absent on a payload written before agents carried their project
			json.name,
			json.icon,
			json.color,
			json.model === undefined ? DEFAULT_MODEL_KEY : json.model,   // absent → default; null → stays null ( see create )
			json.account,   // absent → the reserved member, which the host's cascade reads as "nothing stated"
			json.systemPrompt ?? null,
			lenses,
			json.baseHabits ?? [],
			json.loadedHabits ?? [],
			json.skills ?? [],
			json.toolModes ?? {},
			json.fields ?? [],
			json.system ?? {},
			json.createdAt,
			json.folder,
			json.notes ?? null,
			json.slug ?? null,
			json.reasoning ?? null,
		);
		// Main re-materializes from the paths on every load/save, so an absent field means not-yet, never a loss.
		agent.baseHabitNodes = ( json.baseHabitNodes ?? [] ).map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		agent.brokenLenses   = ( json.brokenLenses ?? [] ).map( ( b ) => ( { ...b } ) );
		agent.brokenHabits   = ( json.brokenHabits ?? [] ).map( ( b ) => ( { ...b } ) );
		return agent;
	}

	/** The roster form — identity and the authored lens stack as paths. Carries no lens content, so a
	 *  whole fleet of these costs what one row of a table would. */
	summarize(): AgentSummary {
		const lensPaths: string[] = [];
		for ( const lens of this.lenses ) {
			const path = lens.getPath();
			if ( path ) lensPaths.push( path );
		}
		return { id: this.id, projectId: this.projectId, name: this.name, model: this.model, account: this.account, lensPaths };
	}

	/** One function, many purposes: the bridge wire form, the save form, the reconstruction source.
	 *  Ships base strings + serialized lenses only — composed{X} is rebuilt on arrival. */
	serializeForWire(): SerializedAgent {
		return { ...this.serializeOwn(), lenses: this.lenses.map( ( l ) => l.serializeForWire() ) };
	}

	/** The agent's RECORD — its own fields, and each lens as a record the receiver reads on access. The wire
	 *  form for a receiver that compiles for itself: it carries none of what the lenses say. */
	serializeRecord(): SerializedAgent {
		return { ...this.serializeOwn(), lenses: this.lenses.map( ( l ) => l.serializeRecord() ) };
	}

	/** Every field of the agent but its lenses — what both wire forms share. */
	private serializeOwn(): Omit<SerializedAgent, 'lenses'> {
		return {
			id:             this.id,
			projectId:      this.projectId,
			name:           this.name,
			icon:           this.icon,
			color:          this.color,
			model:          this.model,
			account:        this.account,
			systemPrompt:   this.systemPrompt,
			baseHabits:     [ ...this.baseHabits ],
			loadedHabits:   [ ...this.loadedHabits ],
			skills:         [ ...this.skills ],
			toolModes:      { ...this.toolModes },
			fields:         this.fields.map( ( f ) => ( { ...f } ) ),
			system:         { ...this.system },
			createdAt:      this.createdAt,
			folder:         this.folder,
			notes:          this.notes,
			slug:           this.slug,
			reasoning:      this.reasoning,
			baseHabitNodes: this.baseHabitNodes.map( ( n ) => n.serialize() ),
			brokenLenses:   this.brokenLenses.map( ( b ) => ( { ...b } ) ),
			brokenHabits:   this.brokenHabits.map( ( b ) => ( { ...b } ) ),
		};
	}

	// ── Composition (flush-and-fill; trust the children) ──────────────────────

	/**
	 * Rebuild every `composed{X}` wholesale from the current lenses, never by delta. Cheap, so call it on every change.
	 * No tools come out of a lens: tools belong to the agent.
	 */
	compose(): void {
		const nodes = this.lenses.flatMap( ( l ) => l.getNodes() );
		this.composedReferences = _pathsOfType( nodes, 'reference' );
		this.composedPlans      = _pathsOfType( nodes, 'plan' );
		this.composedHabits     = _pathsOfType( nodes, 'habit' );
	}

	/**
	 * Hand the agent a reader it pulls its external layers from on access, the way a lens pulls its document.
	 * Idempotent; `null` takes it back to whatever a host bound.
	 */
	setEnvReader( read: EnvReaderFn | null ): void {
		this._env = read;
	}

	/**
	 * Push half for the dispatch tier: a partial bind overwrites only its keys, flush-and-fill like `compose()`.
	 * Never persisted: this is live environment, not identity. Where a reader also answers, the reader wins per key.
	 */
	bindEnv( env: AgentEnvironment ): void {
		const next: AgentEnvironment = { ...this._bound };
		for ( const [ key, value ] of Object.entries( env ) ) {
			if ( value !== undefined ) ( next as Record<string, unknown> )[ key ] = value;
		}
		this._bound = next;
	}

	/**
	 * The tools this agent carries, by identity: those at `on` or `preload`. An `off` left in a stale or hand-edited
	 * map is dropped here, so no reader can forget to check.
	 */
	carriedTools(): Record<string, ToolMode> {
		const held: Record<string, ToolMode> = {};
		for ( const [ id, mode ] of Object.entries( this.toolModes ) ) if ( carries( mode ) ) held[ id ] = mode;
		return held;
	}

	/**
	 * How much of one tool rides: `preload` for its whole schema, `on` for its manifest line, `off` if not carried.
	 * There is no per-run layer above this; preload is decided while building the agent, not per session.
	 */
	toolModeFor( id: string ): ToolMode {
		const mode = this.toolModes[ id ];
		return mode && carries( mode ) ? mode : 'off';
	}

	/**
	 * The mode a lens authored for one path: its policy entry, `on` for an unnamed node, or `null` if none supplies it.
	 * Read from POLICY, not the live `included` flag, which `getContextBlocks` rewrites on every compile.
	 */
	lensMode( path: string ): SlotMode | null {
		const norm  = ( s: string ): string => s.replace( /\\/g, '/' );
		const entry = this.getPolicy().find( e => e.href && norm( path ).endsWith( norm( e.href ) ) );
		if ( entry ) return entry.mode;
		return this.getNodes().some( n => n.getPath() === path ) ? 'on' : null;
	}

	/** Whether one of this agent's held habits loads in full. Compared slash-blind, because a path built on
	 *  Windows and the same path normalized for display are one habit. */
	isHabitLoaded( path: string ): boolean {
		const norm = ( s: string ): string => s.replace( /\\/g, '/' );
		const p    = norm( path );
		return this.loadedHabits.some( l => norm( l ) === p );
	}

	// ── Lens surface ──────────────────────────────────────────────────────────

	/**
	 * Every file in this agent's compiled context, priced at its real cost, in load order. Walks POLICY rather than the
	 * dredge, so `off` artifacts stay listed. Care prose is apportioned from the merged bands, never summed per part.
	 */
	composition(): CompositionRow[] {
		const norm      = ( s: string ): string => s.replace( /\\/g, '/' );
		const weigh     = ( t: string ): number => t ? KCDPrimitive._estimateTokens( t ) : 0;
		const survivors = SlotResolver.compilePlan( this.getContextBlocks() ).survivors;
		const isIndex   = ( b: TaggedBlock ): boolean => b.sourceLayer !== 'injected' && b.section !== null && Agent.INDEX_SECTIONS.has( b.section );

		const body       = survivors.filter( b => !isIndex( b ) && b.section !== 'stub' );
		const careBlocks = body.filter( b => b.region === 'care' );

		// Core weight per artifact path — everything that rides as its own body text.
		const core = new Map<string, number>();
		for ( const b of body.filter( b => b.region !== 'care' ) )
			if ( b.path ) core.set( norm( b.path ), ( core.get( norm( b.path ) ) ?? 0 ) + weigh( b.text ) );

		// Care: the merged bands' real weight, apportioned by each lens's pre-merge contribution.
		const bandTotal = this.buildCareBands( careBlocks ).reduce( ( s, b ) => s + weigh( b.text ), 0 );
		const careRaw   = new Map<string, number>();
		for ( const b of careBlocks ) careRaw.set( norm( b.path ), ( careRaw.get( norm( b.path ) ) ?? 0 ) + weigh( b.text ) );
		const rawTotal  = [ ...careRaw.values() ].reduce( ( s, w ) => s + w, 0 );
		const careFor   = ( p: string ): number => rawTotal ? Math.round( bandTotal * ( careRaw.get( p ) ?? 0 ) / rawTotal ) : 0;

		// Routing-row weight per manifest `where` — an `on` artifact's entire contribution.
		const rowWeight = new Map<string, number>();
		for ( const r of ContextAssembler.manifestRows( survivors.filter( isIndex ) ) )
			rowWeight.set( norm( r.where ), weigh( r.text ) );

		const root = this.firstLens;
		const rel  = ( abs: string ): string => norm( ( root ?? this.lenses[ 0 ] )?.vaultRelative( abs ) ?? abs );

		// A displaced habit puts nothing on the wire, so the chart must not price it: chart and compile are one
		// plan projected twice, and must agree.
		const displaced = this.displacedHabitPaths();

		// A file's slot is its own `habit-class` frontmatter ( protocol §6 ) — the mutual-exclusion class
		// `SlotResolver` groups contenders by. Null for anything that contends nothing.
		const slotOf = ( n: KCDPrimitive | null ): string | null =>
			( n?.getFrontmatter()[ 'habit-class' ] as string | undefined ) ?? null;

		const out: CompositionRow[] = [];
		const seen = new Set<string>();

		for ( const lens of this.lenses ) {
			const lp = norm( lens.getPath() ?? '' );
			seen.add( lp );
			out.push( {
				path: lp, name: lens.getName(), kind: 'lens', source: lens.getName(), slot: null,
				mode: 'load', tokens: ( core.get( lp ) ?? 0 ) + careFor( lp ),
			} );

			for ( const entry of lens.getPolicy() ) {
				const href = entry.href?.trim() ?? '';
				if ( href === '' || /^\{.*\}$/.test( href ) ) {
					out.push( { path: '', name: entry.what || '( unnamed )', kind: 'unknown', source: lens.getName(), slot: null, mode: 'off', tokens: 0 } );
					continue;
				}
				// Match the declared href to a dredged node to recover its real identity and absolute path;
				// an `off` target was never dredged, so it reports from the policy row alone, at zero.
				const node = lens.getNodes().find( n => norm( n.getPath() ).endsWith( norm( href ) ) ) ?? null;
				const p    = node ? norm( node.getPath() ) : norm( href );
				if ( seen.has( p ) ) continue;
				seen.add( p );

				const declared = entry.mode;
				const mode     = ( node && displaced.has( rel( node.getPath() ) ) ) ? 'off' as SlotMode : declared;
				out.push( {
					path:   p,
					name:   entry.what || node?.getName() || p.split( '/' ).pop() || href,
					kind:   node?.getType() ?? 'unknown',
					source: lens.getName(),
					slot:   slotOf( node ),
					mode,
					tokens: mode === 'off' ? 0 : ( core.get( p ) ?? rowWeight.get( node ? rel( node.getPath() ) : norm( href ) ) ?? 0 ),
				} );
			}
		}

		// The agent's OWN habits — no lens declares them, so they are attributed to the agent itself.
		for ( const node of this.baseHabitNodes ) {
			const p = norm( node.getPath() );
			if ( seen.has( p ) ) continue;
			seen.add( p );
			const declared: SlotMode = this.isHabitLoaded( p ) ? 'load' : 'on';
			const mode     = displaced.has( rel( node.getPath() ) ) ? 'off' as SlotMode : declared;
			out.push( {
				path: p, name: node.getName(), kind: node.getType(), source: 'agent', slot: slotOf( node ),
				mode, tokens: mode === 'off' ? 0 : ( core.get( p ) ?? rowWeight.get( rel( node.getPath() ) ) ?? 0 ),
			} );
		}

		return out;
	}

	/**
	 * The first lens in the stack, or null for a draft. No lens outranks another: position only decides which
	 * lens claims a reference two of them name.
	 */
	get firstLens(): LensObject | null { return this.lenses[ 0 ] ?? null; }

	/** A draft cannot run: no lens has been COMPOSED onto it yet. */
	isDraft(): boolean { return this.lenses.length === 0; }

	/** The first lens's path — the agent's path identity — or null for a draft. */
	getPath(): string | null { return this.firstLens?.getPath() ?? null; }

	// ── The lens read surface, aggregated across every composed lens (null-safe) ──

	getNodes(): KCDPrimitive[]        { return this.lenses.flatMap( ( l ) => l.getNodes() ); }
	getPolicy(): PolicyEntry[]        { return this.lenses.flatMap( ( l ) => l.getPolicy() ); }
	getContributors(): KCDPrimitive[] { return this.lenses.flatMap( ( l ) => l.getContributors() ); }
	getFrontmatter(): Record<string, unknown> { return this.firstLens?.getFrontmatter() ?? {}; }
	getSections(): Record<string, string>      { return this.firstLens?.getSections() ?? {}; }

	// ── Context assembly ────────────────────────────────────────────────────────

	/**
	 * The one composition point: every reader reads it, so no view can show a resolution the compile does not honour.
	 * Base habits outrank the lens in a contended slot; one artifact contributes once, from its most specific source.
	 */
	getContextBlocks(): TaggedBlock[] {
		// Lenses are walked in stack order and the first to contribute an artifact path claims it, so one artifact
		// contributes once. Claimed per lens, not per block: a flat block list cannot tell one artifact's regions from a copy.
		const claimed: Set<string> = new Set();
		const lensBlocks: TaggedBlock[] = [];
		for ( const lens of this.lenses ) {
			const blocks = lens.getContextBlocks();
			for ( const b of blocks ) if ( !claimed.has( b.path ) ) lensBlocks.push( b );
			// Claimed after the lens drains: claiming as we go would let an artifact's second region collide with its first.
			for ( const b of blocks ) claimed.add( b.path );
		}
		const habitBlocks = this.baseHabitNodes.flatMap( node => {
			node.setIncluded( this.isHabitLoaded( node.getPath() ) );
			return node.getContextBlocks().map( b => ( { ...b, sourceLayer: 'agent' as const } ) );
		} );
		return Agent.dedupeBySource( [ ...lensBlocks, ...habitBlocks ] );
	}

	/**
	 * Anti-leak core: an artifact contributes once, from its most specific (lowest-rank) layer, before slot resolution.
	 * Same-rank blocks all stay (one artifact's regions); sibling lenses are settled in `getContextBlocks`, not here.
	 */
	static dedupeBySource( blocks: TaggedBlock[] ): TaggedBlock[] {
		const best = new Map<string, number>();
		for ( const b of blocks ) {
			const r = SlotResolver.rank( b.sourceLayer );
			const cur = best.get( b.path );
			if ( cur === undefined || r < cur ) best.set( b.path, r );
		}
		return blocks.filter( b => SlotResolver.rank( b.sourceLayer ) === best.get( b.path ) );
	}

	/**
	 * `getContextBlocks()` run through `SlotResolver` and `ContextAssembler`, as one source-blind string.
	 * A draft contributes nothing; the `systemPrompt` is not prepended here, since `wireSystem` folds it in.
	 */
	contribute(): string {
		if ( !this.lenses.length ) return '';
		return SlotResolver.compile( this.getContextBlocks(), Agent.SYSTEM_SEP );
	}

	/**
	 * Merged body first, then the manifest at the bottom: the stable prose leads and the changeable tables trail.
	 * A draft compiles to nothing; the legacy `stub` block is dropped, since the References table already carries it.
	 */
	compile(): string {
		return Agent.projectSystem( this.compiledBlocks() );
	}

	/**
	 * The flat, merged `TaggedBlock[]` that `compile()` projects: body (Care, Knowledge) first, then the manifest tables,
	 * with `before`/`after` bracketing the join and `contributed`/`sections` sorted into the body by their declared tier.
	 * Body and manifest are assembled separately: one sort would tier `injected` below `manifest`, which the wire does not do today.
	 */
	compiledBlocks( extras: { before?: TaggedBlock[]; after?: TaggedBlock[]; contributed?: TaggedBlock[]; sections?: TaggedBlock[] } = {} ): TaggedBlock[] {
		const before = extras.before ?? [];
		const after  = extras.after ?? [];
		const contributed = extras.contributed ?? [];
		// `sections` joins the block list, not the bracket: a manifest-tagged block fuses with the lens's own rows for that section.
		const sections = extras.sections ?? [];
		if ( !this.lenses.length ) return Agent.joinSegments( [ before, contributed, sections, after ] );
		const blocks  = [ ...SlotResolver.compilePlan( this.getContextBlocks() ).survivors, ...contributed, ...sections ];
		const inIndex = ( b: TaggedBlock ): boolean => b.sourceLayer !== 'injected' && b.section !== null && Agent.INDEX_SECTIONS.has( b.section );
		// The body is everything that ISN'T an index table and isn't the legacy Available-on-request stub.
		const body = blocks.filter( b => !inIndex( b ) && b.section !== 'stub' );

		// Care prose is grouped by kind, one `## {lens}` sub-section per lens; built here because it needs lens names and primacy.
		const careBlocks = body.filter( b => b.region === 'care' );
		const rest       = body.filter( b => b.region !== 'care' );
		const careBands  = this.buildCareBands( careBlocks );

		// Band headings fire per non-empty tier only, so no bare heading lands over nothing.
		const bodyBlocks  = ContextAssembler.withBandHeadings( ContextAssembler.assembleBlocks( [ ...careBands, ...rest ] ) );
		// Habit contention is settled over nodes, not blocks: an `on`-mode habit emits no block for `SlotResolver` to see.
		const rawManifest = this.manifestBlocks( Agent.withoutRows( blocks.filter( inIndex ), this.displacedHabitPaths() ) );
		const manifestBlocks = rawManifest.length
			? [ ContextAssembler.headingBlock( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )! ), ...rawManifest ]
			: [];
		return Agent.joinSegments( [ before, bodyBlocks, manifestBlocks, after ] );
	}

	// ── Self-assembling context ( the fat-object surface; fed by `bindEnv` ) ──────
	// Everything the Session store used to hand-gather into `compiledBlocks`'s extras bag now comes off the
	// agent's own bound environment, so ONE zero-arg call answers "what is my context" and both the renderer
	// preview and ( Phase 5 ) the send path read the SAME method — no second door, no drift by construction.

	/** Documents the lenses are still waiting on; always empty in main, whose reader is disk. */
	pending(): string[] {
		const out: string[] = [];
		for ( const lens of this.lenses ) out.push( ...lens.pending() );
		return out;
	}

	/**
	 * The live wire's context: `compiledBlocks()` with the bound environment folded in as blocks, zero-arg.
	 * Every layer that reaches the system wire is in this list, so the wire, budget and preview all project one object.
	 * A preload tool's schema stays in the request's `tools` array, not here; the tool still must be named here, since the wire carries no server.
	 */
	compiledContext(): TaggedBlock[] {
		const manifest  = this.toolManifest();
		const bands     = this.manifestBands();
		// The host narrows before it calls a contributor; this is the same gate read again on the owning object.
		const contributed = this.contributions.filter( ( c ) => this.injectionEnabled( c.id ) );
		// Grants are a manifest section, not a trailing extra, so they sit under the `# Manifest` band.
		// Empty means absent, checked on the rows: a heading over nothing reads as a dropped table.
		const grants = this.grantRows.length
			? [ Agent.sectionBlock( 'grants', this.grantRows.map( ( r ) => KcdContext.renderRow( r ) ).join( '\n' ), this.grantRows ) ]
			: [];
		return this.compiledBlocks( {
			sections: grants,
			before: Agent.joinSegments( [
				// Host prompt leads: the most-shared layer, identical across agents, so it sits where nothing above can invalidate it.
				this.hostPrompt   ? [ Agent.extraBlock( 'host-prompt',   this.hostPrompt   ) ] : [],
				// Host environment follows the host prompt: shared per instance, so above everything per-agent or per-turn.
				this.hostEnvironment ? [ Agent.extraBlock( 'host-environment', this.hostEnvironment ) ] : [],
				// Name follows the host: stable across every turn this agent takes.
				this.nameBlock()  ? [ Agent.extraBlock( 'agent-name',    this.nameBlock()  ) ] : [],
				// The authored system prompt sits here so the preview and the wire carry the same weight.
				this.systemPrompt ? [ Agent.extraBlock( 'system-prompt', this.systemPrompt ) ] : []
			] ),
			contributed: contributed.map( ( c ) => Agent.contributionBlock( c ) ),
			after: Agent.joinSegments( [
				manifest ? [ Agent.extraBlock( 'tool-manifest', manifest ) ] : [],
				// Authored bands close the manifest as sibling categories, one block for all of them, not subsections of the tool manifest.
				bands     ? [ Agent.extraBlock( 'manifest-groups', bands ) ] : [],
				// Capability is last of the three: it is the most run-specific, so the churning layer goes below the settled ones.
				this.capability ? [ Agent.extraBlock( 'capability', this.capability ) ] : [],
				// Config notice is the most volatile block, so it sits as low as its meaning allows; empty drops it.
				this.configNotice ? [ Agent.extraBlock( 'config-notice', this.configNotice ) ] : [],
				// Attachments trail the system half: they churn mid-conversation, and placed earlier would re-prefill everything beneath.
				this.attachments ? [ Agent.extraBlock( 'attachments', this.attachments ) ] : [],
				// Frame, then shaping: the order the hand-assembly used, kept so the projection stays byte-identical.
				this.frame    ? [ Agent.extraBlock( 'frame', this.frame ) ] : [],
				this.modeLine ? [ Agent.extraBlock( 'mode-line', this.modeLine ) ] : []
			] )
		} );
	}

	/** The agent's name, as the agent is told it. Derived here rather than bound from outside, because the
	 *  name is this agent's own fact. '' for an agent with no name, which drops the block. */
	nameBlock(): string {
		const name = this.name.trim();
		return name ? `## Name\nYou are ${ name }.` : '';
	}

	/**
	 * THE projection from a compiled block list to the wire text — `wireSystem()`'s own body, named so a
	 * caller that ALREADY HOLDS the list can reach the same string without compiling a second time.
	 *
	 * It exists for main's lens-draft loop, which hands the renderer both halves of ONE compile ( the block
	 * list for the Context tree, the text for the Markup tab ). Before this it could only hand back a list
	 * and a separately-compiled string, and the two were built from different lists — the Context tab and
	 * the Markup tab disagreeing about what the agent would be sent, which is the failure both surfaces
	 * exist to rule out. A second hand-written copy of this join anywhere is that same drift wearing a new
	 * shape.
	 */
	static projectSystem( blocks: readonly TaggedBlock[] ): string {
		return blocks.map( b => b.text ).join( '\n\n' );
	}

	/** The system half a real turn sends: `compiledContext()` projected to text, and nothing joined on after it. */
	wireSystem(): string {
		return Agent.projectSystem( this.compiledContext() );
	}

	/**
	 * The same compiled list projected to the per-source breakdown: joining the segments reproduces `wireSystem()` exactly.
	 * Counts are null: the tokenizer lives main-side, and a guess would be worse than an absence.
	 */
	contextSegments(): ContextSegment[] {
		const out: ContextSegment[] = [];
		// Structural blocks waiting for the segment they introduce — see the `!owner` branch below.
		let pending: string[] = [];

		for ( const block of this.compiledContext() ) {
			const owner = Agent.segmentKey( block );

			// Structural blocks (dividers, band headings) belong to the segment they introduce, so they wait for it.
			if ( !owner ) {
				pending.push( block.text );
				continue;
			}

			const text = [ ...pending, block.text ].join( '\n\n' );
			pending = [];

			// Same identity as the open segment: continue it rather than open a second under one name.
			const open = out[ out.length - 1 ];
			if ( open && open.source === owner.source && open.label === owner.label ) {
				open.text = open.text + '\n\n' + text;
				continue;
			}

			out.push( { source: owner.source, label: owner.label, text, tokens: null } );
		}

		// A trailing divider joins the last segment; a compile of only structure produces no segments.
		const last = out[ out.length - 1 ];
		if ( pending.length && last ) last.text = last.text + '\n\n' + pending.join( '\n\n' );

		return out;
	}

	/** Whole-context token estimate over `wireSystem()`. Deliberately loose; only the wire `usage` is exact. */
	estimateTokens(): number {
		return KCDPrimitive._estimateTokens( this.wireSystem() );
	}

	/**
	 * Compiled blocks summed by budget bucket. Sums blocks only, so a band header equals the list beneath it;
	 * the preload schemas on the request's `tools` array are not counted (a known gap, deferred).
	 */
	compiledBudget(): { system: number; lenses: number; tools: number } {
		const out = { system: 0, lenses: 0, tools: 0 };
		for ( const b of this.compiledContext() ) out[ Agent.bucketOf( b ) ] += ( b.text ? KCDPrimitive._estimateTokens( b.text ) : 0 );
		return out;
	}

	/** Tool defs grouped by `ToolDef.server` in first-seen order; a def with no server falls into "Other tools", never dropped. */
	static groupByServer( defs: ToolDef[] ): { name: string; doc: string; tools: ToolDef[] }[] {
		const order: string[] = [];
		const groups = new Map<string, { name: string; doc: string; tools: ToolDef[] }>();
		for ( const t of defs ) {
			const key = t.server?.id ?? '';
			if ( !groups.has( key ) ) { groups.set( key, { name: t.server?.name ?? 'Other tools', doc: t.server?.doc ?? '', tools: [] } ); order.push( key ); }
			groups.get( key )!.tools.push( t );
		}
		return order.map( k => groups.get( k )! );
	}

	/**
	 * Every tool the run holds, grouped by server, one `- name — description` line each: this is where a tool gets its identity,
	 * since the wire carries no server. Only the schema divides preloaded from deferred; the manifest names all of them.
	 * Reads no policy: `toolDefs` is already the callable set. Load-bearing: a search searches nothing not read here first.
	 */
	toolManifest(): string {
		const held = _heldIds( this.toolDefs );
		if ( !held.length ) return '';

		// The mark rides the rows and the note explains it once per manifest. The search tool's name comes from
		// `searchTool`, bound by the host that serves it, so it is never spelled here.
		const MARK = '[schema on request]';
		const NOTE = this.searchTool
			? `Everything you hold is listed here. A tool marked ${ MARK } is not callable yet: call ${ this.searchTool } with its exact name, or with a server's name for all of that server's tools, then call it. A tool you already have never stands in for one you have not fetched.`
			: `Everything you hold is listed here. A tool marked ${ MARK } is not in your callable set yet — ask for its schema, then call it.`;

		// The mark follows what the request actually defers, not the surface: only a composition surface falls back to the surface.
		// A managed lane gets `HOST_NOTE` instead, since its host does not say what it loaded and nothing is true to mark.
		const HOST_NOTE = 'Everything you hold is listed here, and every row is yours to call. Your HOST loads '
			+ 'these into the conversation and does not tell us which it has loaded yet, so a tool on this list '
			+ 'can refuse the first time with "no such tool" or "not available". THAT IS A LOADING STATE, NOT A '
			+ 'DENIAL — a tool you do not hold is absent from this list entirely, and absence is the only denial '
			+ 'there is. So if a row refuses that way: name the tool you are calling in your reply and call it '
			+ 'again. Do not conclude you lack it, do not report it as a missing capability, and do not reach the '
			+ 'same end another way. If it still refuses after you have named it, THEN say so and name the tool.';

		const runDeferred = this.runDeferred;
		// Managed lanes mark nothing: their preview would point at a search tool the lane cannot carry.
		const deferred = ( t: ToolDef ): boolean => this.hostManagedTools
			? false
			: runDeferred
				? runDeferred.includes( t.id! )
				: this.toolModeFor( t.id! ) !== 'preload';
		const sections = Agent.groupByServer( held ).map( g => {
			const head = g.doc ? `### ${ g.name }\n${ g.doc }` : `### ${ g.name }`;
			// Each row names the tool the way the model must CALL it — its wire name, which carries the server.
			return head + '\n' + g.tools.map( t => `- ${ t.wire ?? t.name } — ${ t.description }${ deferred( t ) ? ' ' + MARK : '' }` ).join( '\n' );
		} );

		// The example is a real row's own name, so the rule never spells the wire separator itself.
		const example = held[ 0 ].wire ?? held[ 0 ].name;
		const RULE = `Call a tool by the exact name its row begins with — \`${ example }\`, letter for letter, server part included. `
			+ 'A name that is not on this list is not a tool you hold.';

		// Empty is absent: an agent with every tool loaded is told nothing about fetching schemas.
		const parts = [ '## Available tools', RULE ];
		// One note or the other. The managed note is unconditional: the host may defer something on a later turn.
		if ( this.hostManagedTools ) parts.push( HOST_NOTE );
		else if ( held.some( deferred ) ) parts.push( NOTE );
		parts.push( sections.join( '\n\n' ) );
		return parts.join( '\n\n' );
	}

	/**
	 * The authored bands, each `##` heading over its body. Renders only: which bands exist and their order were decided
	 * by the host before binding, so this cannot narrow or sort them. Empty means no block at all.
	 */
	manifestBands(): string {
		if ( !this.manifestGroups.length ) return '';
		return this.manifestGroups.map( g => `## ${ g.heading }\n\n${ g.body }` ).join( '\n\n' );
	}

	/** The tool identities this agent preloads, read off the defs. Identities, not bare names, so a same-named tool on another server cannot match. */
	preloadedToolIds(): string[] {
		return _heldIds( this.toolDefs ).filter( t => this.toolModeFor( t.id! ) === 'preload' ).map( t => t.id! );
	}

	/** A plain string as a synthetic wire-order block. `section` labels it for the budget bucket; the compiler never reads it. */
	static extraBlock( section: string, text: string ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** Sections that price as SYSTEM, not lens identity. `attachments`, `frame` and `mode-line` are parked here: a fourth bucket is probably right, deferred. */
	private static readonly SYSTEM_SECTIONS = new Set<string>( [ 'host-prompt', 'host-environment', 'agent-name', 'system-prompt', 'root-context', 'attachments', 'frame', 'mode-line' ] );
	/** The compiled sections that price as TOOLS — the surface, not the identity that may reach for it. */
	private static readonly TOOL_SECTIONS = new Set<string>( [ 'tool-manifest' ] );
	/** Every section the bottom manifest emits, so the breakdown files `files` with the routing tables; `MANIFEST_SECTIONS` alone omits it. */
	private static readonly ROUTING_SECTIONS = new Set<string>( [ 'files', ...MANIFEST_SECTIONS ] );

	/** The budget bucket for one block, read off its `section` tag; everything the tables do not claim is Lenses. */
	static bucketOf( b: TaggedBlock ): 'system' | 'lenses' | 'tools' {
		if ( !b.section ) return 'lenses';
		if ( Agent.SYSTEM_SECTIONS.has( b.section ) ) return 'system';
		if ( Agent.TOOL_SECTIONS.has( b.section ) )   return 'tools';
		return 'lenses';
	}

	/** Canonical names for synthetic sections. Views read through `labelFor` rather than keeping a copy. */
	private static readonly SECTION_LABELS: Record<string, string> = {
		'host-prompt':     'host prompt',
		'host-environment': 'environment',
		'agent-name':      'name',
		'system-prompt':   'agent instruction',
		'root-context':    'root context',
		'attachments':     'attachments',
		'frame':           'caller frame',
		'mode-line':       'shaping line',
		'tool-manifest':   'available tools'
	};

	/** The lowercase canonical name for a synthetic section, or `null` for one that names itself off its artifact. */
	static labelFor( section: string ): string | null {
		return Agent.SECTION_LABELS[ section ] ?? null;
	}

	/**
	 * The breakdown segment for one block, or `null` for structural blocks (dividers, band headings).
	 * `source` is the reader's folder, deliberately not the pricing bucket.
	 */
	static segmentKey( b: TaggedBlock ): SegmentKey | null {
		if ( !b.section ) return null;
		// Injection first, so a package id matching a section name cannot misfile itself.
		if ( b.sourceLayer === 'injected' )           return { source: 'injection', label: b.section };
		if ( Agent.SYSTEM_SECTIONS.has( b.section ) ) return { source: 'system', label: Agent.SECTION_LABELS[ b.section ] ?? b.section };
		if ( Agent.TOOL_SECTIONS.has( b.section ) )   return { source: 'tools',  label: Agent.SECTION_LABELS[ b.section ] ?? b.section };
		if ( Agent.ROUTING_SECTIONS.has( b.section ) ) return { source: 'index', label: b.section };
		if ( b.region === 'care' )                    return { source: 'lens',   label: b.section };
		return { source: b.artifactType, label: Agent.basename( b.path ) || b.section };
	}

	/** A path's file name without its extension. Plain string work, so core stays Node-free. */
	private static basename( p: string ): string {
		const tail = p.split( /[\\/]/ ).pop() ?? '';
		return tail.replace( /\.[^.]+$/, '' );
	}

	/**
	 * Each care kind (Purpose, Philosophy) becomes one block merging every active lens as a `## {lens}` sub-section,
	 * primary leading and marked. A section's own `### heading` is stripped so the kind band is not shadowed.
	 */
	buildCareBands( careBlocks: TaggedBlock[] ): TaggedBlock[] {
		const norm     = ( s: string ): string => s.replace( /\\/g, '/' );
		const ordered  = this.lenses;
		const allPaths = new Set( ordered.map( l => norm( l.getPath() ?? '' ) ) );

		const title     = ( k: string ): string => k ? k.charAt( 0 ).toUpperCase() + k.slice( 1 ) : 'Care';
		const lensLabel = ( l: LensObject ): string => `${ l.getName() }${ l === ordered[ 0 ] ? ' ( Primary )' : '' }`;
		// Drops a section's own leading `###` heading so the kind band is not shadowed by a near-duplicate.
		const prose = ( text: string ): string => {
			const lines = text.split( '\n' );
			let i = 0;
			while ( i < lines.length && lines[ i ].trim() === '' ) i++;
			return ( i < lines.length && /^#{1,6}\s/.test( lines[ i ].trim() ) )
				? lines.slice( i + 1 ).join( '\n' ).trim()
				: text.trim();
		};

		// Care kinds in first-appearance order.
		const kinds: string[] = [];
		for ( const b of careBlocks ) { const k = b.section ?? ''; if ( !kinds.includes( k ) ) kinds.push( k ); }

		const out: TaggedBlock[] = [];
		for ( const kind of kinds ) {
			const members = careBlocks.filter( b => ( b.section ?? '' ) === kind );
			const parts: string[] = [ `# ${ title( kind ) }` ];
			for ( const lens of ordered ) {
				const mine = members.filter( b => norm( b.path ) === norm( lens.getPath() ?? '' ) );
				if ( !mine.length ) continue;
				parts.push( `## ${ lensLabel( lens ) }` );
				for ( const m of mine ) parts.push( prose( m.text ) );
			}
			// Care with no active lens stays under its own label, never dropped.
			const orphans = members.filter( b => !allPaths.has( norm( b.path ) ) );
			if ( orphans.length ) { parts.push( '## Injected' ); for ( const o of orphans ) parts.push( prose( o.text ) ); }
			out.push( { ...members[ 0 ], text: parts.join( '\n\n' ), mergeKey: null } );
		}
		return out;
	}

	/** Joins segments with a `---` divider between each pair that both have content; an empty segment adds no stray divider. */
	static joinSegments( segments: TaggedBlock[][] ): TaggedBlock[] {
		const out: TaggedBlock[] = [];
		for ( const seg of segments.filter( s => s.length ) ) {
			if ( out.length ) out.push( Agent.dividerBlock() );
			out.push( ...seg );
		}
		return out;
	}

	/** The literal `---` boundary block; synthetic, so it carries the neutral tagging of every compiler-made block. */
	static dividerBlock(): TaggedBlock {
		return { region: 'know', section: null, mergeKey: null, text: '---', sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** The what/where/why routing sections, hoisted out of the body into the manifest. Derived from `MANIFEST_SECTIONS`, the one registry shared with `ContextAssembler`. */
	static readonly INDEX_ORDER = MANIFEST_SECTIONS;
	static readonly INDEX_SECTIONS = new Set<string>( MANIFEST_SECTIONS );

	/**
	 * Vault-relative hrefs of habits that LOST their habit-class contest. Settled over the node inventory: an `on`-mode
	 * habit emits no block for `SlotResolver`, so a lens's habits table would otherwise advertise both occupants of one slot.
	 * Most specific rank first, agent then lenses in load order; ties keep the incumbent.
	 */
	displacedHabitPaths(): Set<string> {
		const norm = ( s: string ): string => s.replace( /\\/g, '/' );
		const root = this.firstLens ?? this.lenses[ 0 ] ?? null;
		const href = ( abs: string ): string => norm( root?.vaultRelative( abs ) ?? abs );

		const best = new Map<string, { path: string; rank: number }>();
		const all: { cls: string; path: string }[] = [];
		const consider = ( node: KCDPrimitive, rank: number ): void => {
			if ( node.getType() !== 'habit' ) return;
			const cls = node.getFrontmatter()[ 'habit-class' ];
			if ( typeof cls !== 'string' || !cls ) return;
			const path = href( node.getPath() ?? '' );
			all.push( { cls, path } );
			const cur = best.get( cls );
			if ( !cur || rank < cur.rank ) best.set( cls, { path, rank } );
		};

		for ( const n of this.baseHabitNodes ) consider( n, 0 );
		this.lenses.forEach( ( lens, i ) => { for ( const n of lens.getNodes() ) consider( n, 1 + i ); } );

		const out = new Set<string>();
		for ( const c of all ) if ( best.get( c.cls )!.path !== c.path ) out.add( c.path );
		return out;
	}

	/** Manifest index blocks with the named rows removed. Copies rather than mutates, since `composition()` reads the same blocks. */
	static withoutRows( index: TaggedBlock[], drop: Set<string> ): TaggedBlock[] {
		if ( !drop.size ) return index;
		const norm = ( s: string ): string => s.replace( /\\/g, '/' );
		return index.map( b => b.rows?.length
			? { ...b, rows: b.rows.filter( r => !drop.has( norm( r.where ?? '' ) ) ) }
			: b );
	}

	/**
	 * The bottom-of-context manifest as blocks: a `Files` block naming every lens, then one routing table per non-empty
	 * `INDEX_ORDER` section. Paths are vault-relative against the primary lens, so a shared vault root resolves.
	 */
	manifestBlocks( index: TaggedBlock[] ): TaggedBlock[] {
		const root = this.firstLens;
		const out: TaggedBlock[] = [];

		const fileRows = this.lenses.map( l => KcdContext.renderRow( {
			what:  l.getName(),
			where: ( root ?? l ).vaultRelative( l.getPath() ?? '' ),
			why:   String( l.getFrontmatter()[ 'description' ] ?? '' )
		} ) );
		if ( fileRows.length ) {
			out.push( Agent.manifestBlock( 'files', [ ContextAssembler.title( 'files' ), ...fileRows ].join( '\n' ) ) );
		}

		for ( const section of Agent.INDEX_ORDER ) {
			const members = index.filter( b => b.section === section );
			if ( members.length ) out.push( Agent.manifestBlock( section, ContextAssembler.manifestTable( members, section ) ) );
		}
		return out;
	}

	/** One manifest-table block — synthetic ( no single source artifact, so tagged neutrally ), `region:
	 *  'know'` since it's routing content, never Care identity prose. */
	static manifestBlock( section: string, text: string ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** This agent's overrides for one package's injection, keyed by package id, so the host and the compile read one entry. */
	contributionSettings( id: string ): ContributionSettings {
		const bag = ( this.system[ 'contributions' ] ?? {} ) as Record<string, ContributionSettings>;
		return bag[ id ] ?? {};
	}

	/** Whether this agent takes package `id`'s injection. Default on. */
	injectionEnabled( id: string ): boolean {
		return this.contributionSettings( id ).enabled !== false;
	}

	/** One injected block. `sourceLayer: 'injected'` is the ranking. The heading rides in the text so packages sharing a tier keep their own; `section` carries the package id. */
	static contributionBlock( c: Contribution ): TaggedBlock {
		return { region: 'know', section: c.id, mergeKey: null, text: `## ${ c.heading }

${ c.text }`,
			sourceLayer: 'injected', path: '', artifactType: 'unknown', habitClass: null };
	}

	/**
	 * A manifest-section block sourced from outside the lens graph. It owes both `text` (what a lone-block preview renders)
	 * and `rows` (what survives a merge): a caller that passes text alone loses the whole table in the merge.
	 */
	static sectionBlock( section: string, text: string, rows: SlotRow[] = [] ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, rows, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/**
	 * Every habit class's candidates and winner, for the Slot UI. Resolved by the same `SlotResolver` over `getContextBlocks()`,
	 * so it cannot show a winner the compiled text does not carry.
	 */
	slots(): SlotResolution[] {
		if ( !this.lenses.length ) return [];
		return SlotResolver.describe( this.getContextBlocks() );
	}

	/**
	 * The habit cascade as a composition surface sees it: every habit from either layer, whether or not it wins its slot.
	 *
	 * Built from the inventory rather than from `slots()`, which shows only the winners. Pure: it never mutates the
	 * compile's state. Classless habits ride along as single-candidate entries with `habitClass: null`.
	 */
	habitSlots(): HabitSlotView[] {
		const candidates: HabitSlotCandidate[] = [];
		const seen = new Set<string>();
		const add = ( node: KCDPrimitive, sourceLayer: SourceLayer ): void => {
			const path = node.getPath();
			// One artifact is one candidate, from its most specific layer: agent is added first, so the lens copy is skipped.
			if ( seen.has( path ) ) return;
			seen.add( path );
			const cls = node.getFrontmatter()[ 'habit-class' ];
			candidates.push( {
				path,
				habitClass: typeof cls === 'string' && cls ? cls : null,
				sourceLayer,
				mode: sourceLayer === 'agent' ? ( this.isHabitLoaded( path ) ? 'load' : 'on' ) : this.lensMode( path ) ?? 'on',
				won: false
			} );
		};
		for ( const n of this.baseHabitNodes ) add( n, 'agent' );
		for ( const n of this.getNodes() ) if ( n.getType() === 'habit' ) add( n, 'lens' );

		const views: HabitSlotView[] = [];
		const byClass = new Map<string, HabitSlotCandidate[]>();
		for ( const c of candidates ) {
			if ( !c.habitClass ) { views.push( { habitClass: null, winner: { ...c, won: true }, candidates: [ { ...c, won: true } ] } ); continue; }
			if ( !byClass.has( c.habitClass ) ) byClass.set( c.habitClass, [] );
			byClass.get( c.habitClass )!.push( c );
		}
		for ( const [ habitClass, group ] of byClass ) {
			const winner = group.reduce( ( best, c ) => SlotResolver.rank( c.sourceLayer ) < SlotResolver.rank( best.sourceLayer ) ? c : best );
			views.push( {
				habitClass,
				winner:     { ...winner, won: true },
				candidates: group.map( c => ( { ...c, won: c.path === winner.path } ) )
			} );
		}
		return views;
	}

	/** The separator between system-prompt layers, shared by every text joiner so none can drift from `joinSegments`. */
	static readonly SYSTEM_SEP = '\n\n---\n\n';

	/** The id every `Vault.buildAgent` agent carries: a lens substrate, compiled then discarded. Never persisted, which is why `AgentRow.model` stays concrete while `Agent.model` is nullable. */
	static readonly VAULT_AGENT_ID = 'vault-agent';

	/** Joins raw strings with the canonical separator, dropping empties. For callers with no block list to project, such as `identity()`. */
	static assembleSystem( parts: ( string | null | undefined )[] ): string {
		return parts.filter( Boolean ).join( Agent.SYSTEM_SEP );
	}

	/**
	 * The frozen identity: `systemPrompt` over the lens contribution. A snapshot, so no bound root context, memory or tool
	 * manifest. What the agent sends is `wireSystem()`; the breakdown is `contextSegments()`.
	 */
	identity(): string {
		return Agent.assembleSystem( [ this.systemPrompt, this.compile() ] );
	}

}
