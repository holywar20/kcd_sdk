import { LensObject } from '../primitives/framework/LensObject';
import { SlotResolver } from '../primitives/framework/SlotResolver';
import type { SlotResolution } from '../primitives/framework/SlotResolver';
import { ContextAssembler, MANIFEST_SECTIONS } from '../primitives/framework/ContextAssembler';
import { KcdContext } from '../core/html/KcdContext';
import { InstallManifest } from '../core/InstallManifest';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SerializedArtifact, SerializedLens, SlotMode, SourceLayer, TaggedBlock } from '../primitives/types';

/**
 * One habit in the COMPOSITION view — an inventory entry, not a compiled block. Carries the two modes a
 * composition surface needs to tell inheritance from decision: `natural` ( what it is with no override )
 * and `mode` ( what it actually is ). A row at `mode: 'off'` is still here — that is the whole point of
 * this view versus `slots()`. See `Agent.habitSlots()`.
 */
export interface HabitSlotCandidate {
	path:        string;
	/** the mutual-exclusion class, or null for a bare drop-in that contends nothing. */
	habitClass:  string | null;
	sourceLayer: SourceLayer;
	/** the mode in force ( this agent's override, else the natural mode ). */
	mode:        SlotMode;
	/** the mode with NO agent override — what a click must match to CLEAR rather than write. */
	natural:     SlotMode;
	won:         boolean;
}

/**
 * One FILE in an agent's compiled context, with what it actually costs — the composition currency.
 *
 * A row per artifact, not per block: the question this answers is "what is this object built from, and what
 * does each piece cost me", which is what a composition surface ( the CLI chart, the agent screen ) shows.
 * `tokens` is read from the real compiled output at the artifact's effective mode — a full body at
 * `suggested`, its surviving routing row at `on`, zero at `off` — never a re-derived estimate.
 */
export interface CompositionRow {
	/** The artifact's own path — the row's identity. */
	path:   string;
	name:   string;
	kind:   ArtifactType;
	/** The lens that contributes this file, or `agent` for one the agent itself bolted on. An artifact
	 *  declared by several lenses is attributed once, to the first that carries it — matching the dedup the
	 *  compile itself applies. */
	source: string;
	/** The mutual-exclusion SLOT this file competes in, from its own `habit-class` frontmatter, or null for
	 *  a file that contends nothing. Habits are what use it today; the field is the artifact's, not the
	 *  habit type's, so anything that later declares a class surfaces here without a change. Two files
	 *  sharing a slot means only one of them reaches the compiled context. */
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
import { DEFAULT_MODEL_KEY } from './Model';
import type { ToolMode } from './ToolMode';
import type { ToolDef } from './ToolDef';

/*
 * An Agent deliberately has NO status ( removed 2026-07-21 ). It used to carry
 * `status: 'idle' | 'thinking'`, which was run-state living on the wrong noun: an agent is a
 * CONFIGURATION — an identity, a lens stack, a tool composition — and configuration does not run.
 * A turn runs, inside a session. So the flag moved to `Session.turnStatus`, where the thing being
 * described actually exists.
 *
 * It was also, in fact, dead: it was set around each turn, broadcast on an `agent_status` event, and
 * mirrored renderer-side, but NO component ever read it — the UI's real busy signal was the Session
 * store's local `pending`. Two sessions of the same agent running at once would also clobber it
 * ( whichever finished first flipped the shared flag to idle while the other was still going ), so
 * even its intended reading was wrong. Moving it onto the session makes that case correct by
 * construction: each run owns its own flag.
 */

/**
 * The wire / DB-seed form of an Agent. Deliberately LIGHT and DECLARATIVE: the lens
 * graphs (main dredges them; the renderer can't) plus the `base*` dumb-string inventories
 * and the runtime envelope. The `composed*` materialization is NOT here — it is rebuilt
 * from this seed on arrival (see Agent.compose), so it can never ride the wire stale.
 */
export interface SerializedAgent {
	id: string;
	name: string;
	/** Presentation — a Glyph name + a color token string (e.g. `var(--generator)`). Null = fall back. */
	icon: string | null;
	color: string | null;
	/** A ModelDescriptor registry key (see Model.ts), or null for an agent that never dispatches.
	 *  Null is the VAULT case: a `Vault.buildAgent` agent exists only to compile context for delivery as
	 *  CLI text or a tool result, so there is no model to name — and defaulting one would be a lie a later
	 *  reader acts on. An authored agent is always concrete; the default still applies when none is given. */
	model: string | null;
	/** The visible top-of-context lever. Null = none; '' is a deliberately empty one. */
	systemPrompt: string | null;
	/** The composed lenses, serialized whole. `[]` = a draft (cannot run yet). `[0]` is primary. */
	lenses: SerializedLens[];
	/**
	 * `base*` — the components BOLTED DIRECTLY onto this agent: the user's add/subtract
	 * surface, stored as dumb strings (paths for artifacts, ids/names for tools). They are
	 * the declarative source of truth; the proper objects are fetched at composition. This
	 * is what makes the agent the enforced/composable unit a free-form lens file can't be.
	 */
	baseTools: string[];
	baseHabits: string[];
	baseReferences: string[];
	basePlans: string[];
	/**
	 * The agent's `baseHabits` MATERIALIZED into loaded artifacts — the dumb-string inventory turned
	 * into objects the SlotResolver can rank ( main reads them from disk; the renderer can't, so they
	 * ride the wire ). Derived, NOT a second source of truth: `baseHabits` ( the paths ) is authoritative
	 * and persisted; these are rebuilt from it on every main-side load/save. Optional on the wire ( a seed
	 * that predates them, or a draft, carries none ).
	 */
	baseHabitNodes?: SerializedArtifact[];
	/** The agent's `baseReferences` MATERIALIZED into loaded artifacts — the reference sibling of
	 *  `baseHabitNodes`, identical shape and identical reason ( main reads disk; the renderer can't ). */
	baseReferenceNodes?: SerializedArtifact[];
	/**
	 * Per-TOOL three-state inclusion, keyed by tool name ( the wire's currency ): `off` ( absent =
	 * off ), `on` ( advertised as a one-liner in the system-prompt manifest, server stays lazy ), or
	 * `suggested` ( full tool surface injected into context ). This is the AUTHORED tool composition —
	 * the renderer's per-tool control writes it; the turn assembly reads it to split the manifest from
	 * the injected surface. Distinct from `baseTools` ( the dumb inventory ), which stays untouched. */
	toolModes: Record<string, ToolMode>;
	/**
	 * On/off EXCLUSION sets for the agent's own `baseReferences` / `baseHabits` — presence in here means
	 * OFF ( absent = on, the default ), so a fresh agent's whole base inventory starts fully live with no
	 * seed data required. Distinct from REMOVING a path from `baseReferences`/`baseHabits` outright: off
	 * keeps it in the agent's own inventory ( still shown, still re-enable-able ), just excluded from
	 * `getContextBlocks()`. The LEGACY binary layer — `referenceModes`/`habitModes` ( the three-state tier )
	 * now supersede this for any path they hold an entry for; these stay as the fallback default a path with
	 * no explicit mode falls back to ( off ⇒ `off`, else ⇒ `suggested` — see `effectiveReferenceMode`/
	 * `effectiveHabitMode` ), so an agent with no explicit mode set behaves exactly as before either tier
	 * existed.
	 */
	referenceOff: string[];
	habitOff: string[];
	/**
	 * Per-REFERENCE three-state OVERRIDE, keyed by the reference's path — the exact `habitModes` idiom, on
	 * the reference axis: an agent-level override of EITHER a lens-contributed reference's slot mode OR one
	 * of the agent's own `baseReferences` picks. ABSENT for a path = inherit ( a lens's own dredged mode, or
	 * the `referenceOff` binary default for an own pick ); PRESENT = the agent forces that reference to `off`
	 * ( excluded, its manifest row dropped ), `on` ( routing row only ), or `suggested` ( full body rides ),
	 * regardless of the lens's policy. The reference sibling of `habitModes` — unifies references onto the
	 * exact same three-state composition every other component ( tools, habits ) already carries. */
	referenceModes?: Record<string, SlotMode>;
	/**
	 * Per-HABIT three-state OVERRIDE, keyed by the habit's path — the exact `toolModes` idiom for habits:
	 * an agent-level override of a LENS-contributed habit's slot mode. ABSENT for a path = inherit the
	 * lens's own mode ( the agent screen greys the row to say "not overridden" ); PRESENT = the agent forces
	 * that habit to `off` ( excluded, its manifest row dropped ), `on` ( routing row only ), or `suggested`
	 * ( full four-field body rides ), regardless of what the lens said. Distinct from `habitOff` ( the binary
	 * exclusion of the agent's OWN `baseHabits` ) — this overrides INHERITED habits, and carries the on↔suggested
	 * tier `habitOff` can't express. The composability of behaviour, same shape as `effectiveToolModes()`. */
	habitModes?: Record<string, SlotMode>;
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
}

export interface AgentOptions {
	id?: string;
	name?: string;
	icon?: string | null;
	color?: string | null;
	/** Omit for the default; pass null explicitly for an agent that never dispatches ( see the field ). */
	model?: string | null;
	systemPrompt?: string | null;
	lenses?: LensObject[];
	baseTools?: string[];
	baseHabits?: string[];
	baseReferences?: string[];
	basePlans?: string[];
	toolModes?: Record<string, ToolMode>;
	referenceOff?: string[];
	referenceModes?: Record<string, SlotMode>;
	habitOff?: string[];
	habitModes?: Record<string, SlotMode>;
	fields?: Record<string, unknown>[];
	system?: Record<string, unknown>;
	folder?: string;
	notes?: string | null;
}

/** Pull the paths of every node of a given artifact type out of a flat node list. */
function _pathsOfType( nodes: KCDPrimitive[], type: ArtifactType ): string[] {
	return nodes.filter( ( n ) => n.getType() === type ).map( ( n ) => n.getPath() );
}

/** Union of two string inventories, de-duplicated, base first. */
function _union( base: string[], composed: string[] ): string[] {
	return [ ...new Set( [ ...base, ...composed ] ) ];
}

/**
 * Agent — THE composition primitive (formerly split across Recipe + Agent). Pure data plus
 * a single composition method; no `fs`, no file backing — it persists as a DB row, and crosses
 * the bridge whole via serialize / fromSerialized. (Its only disk-capable member, LensObject,
 * keeps disk behind an injected main-only reader the renderer never calls.)
 *
 * The model in one breath: a **lens is a reusable, unenforced partial** (a file — it can be
 * anything); an **agent is the enforced, composable unit** that bolts components on directly.
 *
 *   • `lenses` + `base*` (dumb strings) are the DECLARATIVE SOURCE OF TRUTH — stored, light.
 *   • `composed*` is MATERIALIZED by `compose()`: ask each lens what it contributes, concat.
 *     Trust the children — a wrong contribution is a bug in the child, not corrected here.
 *   • `effective*` = `base* ∪ composed*` — what a permissions gate or the composer reads.
 *
 * Composition is FLUSH-AND-FILL, never delta-managed: `compose()` blows `composed*` away and
 * rebuilds from the current lenses. It runs at construction (so a hydrated agent arrives whole)
 * and again whenever the base strings or lenses change. `composed*` is never persisted — that
 * is the one move that would let it go stale (a lens is a file, editable out-of-band).
 *
 * A draft is simply an agent with no lenses (`isDraft()`); "deploy" is a state transition on
 * this one object, not a different class.
 */
export class Agent {

	readonly id: string;
	name: string;
	icon: string | null;
	color: string | null;
	model: string | null;
	systemPrompt: string | null;

	/** The composed lenses (materialized graphs). `[]` = draft; `[0]` = primary. */
	lenses: LensObject[];

	// ── base{X}: bolted directly here; dumb strings; the user's add/subtract surface ──
	baseTools: string[];
	baseHabits: string[];
	baseReferences: string[];
	basePlans: string[];

	/** Per-tool three-state inclusion, keyed by tool name (see SerializedAgent.toolModes). */
	toolModes: Record<string, ToolMode>;

	/** On/off exclusion sets for the agent's own base references/habits (see SerializedAgent.referenceOff). */
	referenceOff: string[];
	habitOff: string[];

	/** Per-reference override — EITHER a lens-inherited reference OR one of this agent's own `baseReferences`
	 *  (see SerializedAgent.referenceModes). Absent key = inherit; present = the agent forces off/on/suggested. */
	referenceModes: Record<string, SlotMode>;
	/** Per-habit override of an INHERITED lens habit's slot mode (see SerializedAgent.habitModes). Absent
	 *  key = inherit the lens's mode; present = the agent forces off/on/suggested. */
	habitModes: Record<string, SlotMode>;

	fields: Record<string, unknown>[];
	system: Record<string, unknown>;

	// ── Runtime identity ──
	readonly createdAt: number;
	folder: string | undefined;
	notes: string | null;

	// ── composed{X}: MATERIALIZED by compose(); never persisted, never crosses the wire ──
	composedTools: string[] = [];
	composedHabits: string[] = [];
	composedReferences: string[] = [];
	composedPlans: string[] = [];
	/** Per-tool modes CONTRIBUTED by the lenses ( tool name → mode ), materialized in compose() from each
	 *  lens's `getToolModes()`. The composition baseline; `effectiveToolModes()` overlays this agent's own
	 *  authored `toolModes` on top, agent-wins-per-tool. Never persisted — rebuilt from the lenses. */
	composedToolModes: Record<string, ToolMode> = {};

	/**
	 * The agent's OWN base habits as LOADED objects ( the `agent` source layer at composition ). Disk is
	 * a main capability, so main materializes these from `baseHabits` ( the paths ) and they ride the wire
	 * for the renderer's structured view. Never persisted to the DB ( `baseHabits` is ) — rebuilt from the
	 * paths on every load/save so it can't go stale. Empty until materialized ( a draft, or a bare wire ). */
	baseHabitNodes: KCDPrimitive[] = [];
	/** The agent's OWN base references as LOADED objects — the reference sibling of `baseHabitNodes`,
	 *  identical shape and identical reason. Never persisted; rebuilt from `baseReferences` on every
	 *  load/save. Empty until materialized ( a draft, or a bare wire ). */
	baseReferenceNodes: KCDPrimitive[] = [];

	// ── Bound environment: the wire's EXTERNAL layers, injected post-hydration ( `bindEnv` ) ──
	// The inputs the compiled context needs that aren't the agent's own object graph: the model-bound
	// root context, the live MCP tool defs ( for the manifest + suggested surface ), the baseline PRELOAD
	// memory + its tag vocabulary, and the session's attachments. Set from OUTSIDE ( the renderer's Agent
	// store, the main orchestrator ) the same way `baseHabitNodes` is — never persisted, never crosses the
	// wire, flush-and-filled on change.
	// With these bound, the agent answers `compiledContext()`/`wireSystem()`/`estimateTokens()` ALONE.

	/** The model-bound root-context text ( CLAUDE.md / Winston.html et al. ) — leads the compiled context.
	 *  '' when the agent's model declares none. */
	rootContext: string = '';
	/** The live tool defs available to this agent — the flat set the manifest + suggested surface read,
	 *  each carrying its BAKED per-mode counts. Bound from the MCP store; `[]` until bound. */
	toolDefs: ToolDef[] = [];
	/** The baseline PRELOAD memory prose ( the system-fired top-N selection ). Rides only when the agent's
	 *  own `system.memoryEnabled` gate is on. '' until bound / when the query came back dry. */
	memory: string = '';
	/** The memory store's WHOLE tag vocabulary — one list every agent shares ( no params, never varies by
	 *  agent, changes only when we seed a new tag ). Bound like `memory`; `[]` when no memory store is
	 *  wired at all, which is what lets `memoryVocabulary()` fall silent instead of rendering an empty
	 *  header. Read by that one method — see it for why this rides the band instead of a tool. */
	memoryTags: string[] = [];
	/** The bound session's PREFILL attachments, already composed ( `Session.attachmentManifest()` ). A
	 *  STRING like rootContext and memory, not the entry array: the array lives on the session, which owns
	 *  it and composes it, and an agent reaching into `session/` would invert the layering — a session is a
	 *  run of an agent, not the reverse. '' when nothing is attached. */
	attachments: string = '';
	/** The bound session's CANONIZED grants, already composed ( `Session.grantManifest()` ) — the what/where/
	 *  why rows for everything the user handed this run whose turns have since been compacted.
	 *
	 *  A STRING for the same reason `attachments` is: the session owns the grants and composes them, and an
	 *  agent reaching into `session/` would invert the layering.
	 *
	 *  Only the HOISTED set arrives here. A grant whose turn still rides already carries its reference line
	 *  in the transcript, and a manifest row beside it would state one fact twice; promotion waits for the
	 *  compaction that removed the line. '' when nothing has been canonized yet, which is most sessions. */
	grants: string = '';

	private constructor(
		id: string,
		name: string,
		icon: string | null,
		color: string | null,
		model: string | null,
		systemPrompt: string | null,
		lenses: LensObject[],
		baseTools: string[],
		baseHabits: string[],
		baseReferences: string[],
		basePlans: string[],
		toolModes: Record<string, ToolMode>,
		referenceOff: string[],
		referenceModes: Record<string, SlotMode>,
		habitOff: string[],
		habitModes: Record<string, SlotMode>,
		fields: Record<string, unknown>[],
		system: Record<string, unknown>,
		createdAt: number,
		folder: string | undefined,
		notes: string | null,
	) {
		this.id             = id;
		this.name           = name;
		this.icon           = icon;
		this.color          = color;
		this.model          = model;
		this.systemPrompt   = systemPrompt;
		this.lenses         = lenses;
		this.baseTools      = baseTools;
		this.baseHabits     = baseHabits;
		this.baseReferences = baseReferences;
		this.basePlans      = basePlans;
		this.toolModes      = toolModes;
		this.referenceOff   = referenceOff;
		this.referenceModes = referenceModes;
		this.habitOff       = habitOff;
		this.habitModes     = habitModes;
		this.fields         = fields;
		this.system         = system;
		this.createdAt      = createdAt;
		this.folder         = folder;
		this.notes          = notes;
		this.compose();   // materialize composed{X} from the lenses on the way in
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Compose an agent. A lensless draft is legal — running is what demands a lens. The unnamed-agent
	 *  fallback takes the first AUTHORED lens's name, never `lenses[ 0 ]`: the base floor now rides on every
	 *  agent including a draft ( see `domainLenses` ), and a draft named `_lens-base` would be the floor
	 *  leaking out as identity. A draft with no name given is just `'agent'`, as it always was. */
	static create( opts: AgentOptions = {} ): Agent {
		const lenses = opts.lenses ?? [];
		const domain = lenses.filter( ( l ) => !InstallManifest.isBaseLens( l.getPath() ) );
		return new Agent(
			opts.id ?? crypto.randomUUID(),
			opts.name ?? domain[ 0 ]?.getName() ?? 'agent',
			opts.icon ?? null,
			opts.color ?? null,
			// `=== undefined`, never `??` — the two differ exactly where it matters. ABSENT means "give me the
			// default" ( an authored agent built without a model ); explicit NULL means "this agent never
			// dispatches" ( the vault case ). `??` collapses both to the default, which would hand a vault
			// agent the Test Brain and quietly reintroduce the dishonest field this widening removed.
			opts.model === undefined ? DEFAULT_MODEL_KEY : opts.model,
			opts.systemPrompt ?? null,
			lenses,
			opts.baseTools ?? [],
			opts.baseHabits ?? [],
			opts.baseReferences ?? [],
			opts.basePlans ?? [],
			opts.toolModes ?? {},
			opts.referenceOff ?? [],
			opts.referenceModes ?? {},
			opts.habitOff ?? [],
			opts.habitModes ?? {},
			opts.fields ?? [],
			opts.system ?? {},
			Date.now(),
			opts.folder,
			opts.notes ?? null,
		);
	}

	/** Rebuild from the wire / DB seed — each lens hydrates through its own registered hydrator;
	 *  the constructor re-runs compose() so the materialized graph arrives fresh, never stale. */
	static fromSerialized( json: SerializedAgent ): Agent {
		const lenses = ( json.lenses ?? [] ).map( ( l ) => LensObject.fromSerialized( l ) );
		const agent = new Agent(
			json.id,
			json.name,
			json.icon,
			json.color,
			json.model === undefined ? DEFAULT_MODEL_KEY : json.model,   // absent → default; null → stays null ( see create )
			json.systemPrompt ?? null,
			lenses,
			json.baseTools ?? [],
			json.baseHabits ?? [],
			json.baseReferences ?? [],
			json.basePlans ?? [],
			json.toolModes ?? {},
			json.referenceOff ?? [],
			json.referenceModes ?? {},
			json.habitOff ?? [],
			json.habitModes ?? {},
			json.fields ?? [],
			json.system ?? {},
			json.createdAt,
			json.folder,
			json.notes ?? null,
		);
		// The materialized base habits/references ride the wire ( the renderer can't dredge disk ). Main
		// re-materializes from the paths on every load/save, so an absent field just means "not materialized
		// yet", never a loss.
		agent.baseHabitNodes     = ( json.baseHabitNodes ?? [] ).map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		agent.baseReferenceNodes = ( json.baseReferenceNodes ?? [] ).map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		return agent;
	}

	/** One function, many purposes: the bridge wire form, the save form, the reconstruction source.
	 *  Ships base strings + serialized lenses only — composed{X} is rebuilt on arrival. */
	serializeForWire(): SerializedAgent {
		return {
			id:             this.id,
			name:           this.name,
			icon:           this.icon,
			color:          this.color,
			model:          this.model,
			systemPrompt:   this.systemPrompt,
			lenses:         this.lenses.map( ( l ) => l.serializeForWire() ),
			baseTools:      [ ...this.baseTools ],
			baseHabits:     [ ...this.baseHabits ],
			baseReferences: [ ...this.baseReferences ],
			basePlans:      [ ...this.basePlans ],
			toolModes:      { ...this.toolModes },
			referenceOff:   [ ...this.referenceOff ],
			referenceModes: { ...this.referenceModes },
			habitOff:       [ ...this.habitOff ],
			habitModes:     { ...this.habitModes },
			fields:         this.fields.map( ( f ) => ( { ...f } ) ),
			system:         { ...this.system },
			createdAt:      this.createdAt,
			folder:         this.folder,
			notes:          this.notes,
			baseHabitNodes:     this.baseHabitNodes.map( ( n ) => n.serialize() ),
			baseReferenceNodes: this.baseReferenceNodes.map( ( n ) => n.serialize() ),
		};
	}

	// ── Composition (flush-and-fill; trust the children) ──────────────────────

	/**
	 * Rebuild every `composed{X}` from the current lenses — wholesale, no deltas. Ask each lens
	 * for its Know graph and sort the contributed paths by artifact type. Cheap (in-memory; the
	 * expensive dredge already happened when the lens was loaded), so call it freely: at
	 * construction, and whenever a base string or a lens changes.
	 *
	 * `composedTools` ( the dumb inventory of tool NAMES ) stays empty — a tool is not a dredged node, so
	 * the lens's tool contribution is a per-tool MODE map ( `composedToolModes` ), materialized from each
	 * lens's `getToolModes()`. Later lenses override earlier per-tool; the agent's own `toolModes` then
	 * overrides all of them ( `effectiveToolModes()` ).
	 */
	compose(): void {
		const nodes = this.lenses.flatMap( ( l ) => l.getNodes() );
		this.composedReferences = _pathsOfType( nodes, 'reference' );
		this.composedPlans      = _pathsOfType( nodes, 'plan' );
		this.composedHabits     = _pathsOfType( nodes, 'habit' );
		this.composedTools      = [];
		this.composedToolModes  = {};
		for ( const l of this.lenses ) Object.assign( this.composedToolModes, l.getToolModes() as Record<string, ToolMode> );
	}

	/**
	 * Bind the wire's EXTERNAL layers onto the agent — the environment `compiledContext()` needs beyond the
	 * agent's own object graph. Flush-and-fill, like `compose()`: pass the whole environment ( a partial
	 * overwrites only the keys it names ), call it whenever a source changes, and trust the fresh rebuild.
	 * Cheap; there is no delta path to keep in sync. The renderer's Agent store calls this when the MCP tool
	 * defs / model root context / baseline memory change ( then `triggerRef` ); the orchestrator calls it per
	 * round on the canonical agent. Never persisted — this is live environment, not agent identity.
	 */
	bindEnv( env: { rootContext?: string; toolDefs?: ToolDef[]; memory?: string; memoryTags?: string[]; attachments?: string; grants?: string } ): void {
		if ( env.rootContext !== undefined ) this.rootContext = env.rootContext;
		if ( env.toolDefs    !== undefined ) this.toolDefs    = env.toolDefs;
		if ( env.memory      !== undefined ) this.memory      = env.memory;
		if ( env.memoryTags  !== undefined ) this.memoryTags  = env.memoryTags;
		if ( env.attachments !== undefined ) this.attachments = env.attachments;
		if ( env.grants      !== undefined ) this.grants      = env.grants;
	}

	/** What this agent actually carries = bolted-on ∪ inherited-from-lenses. The permissions
	 *  gate reads `effectiveTools`; the composer reads each pair to show base (editable here)
	 *  vs composed (edit at the lens). */
	effectiveTools():      string[] { return _union( this.baseTools,      this.composedTools ); }
	effectiveHabits():     string[] { return _union( this.baseHabits,     this.composedHabits ); }
	effectiveReferences(): string[] { return _union( this.baseReferences, this.composedReferences ); }
	effectivePlans():      string[] { return _union( this.basePlans,      this.composedPlans ); }

	/** The per-tool modes actually in force: the lenses' contribution ( `composedToolModes` ) with this
	 *  agent's OWN authored `toolModes` overlaid on top — agent wins per-tool, so an agent can promote,
	 *  demote, or `off`-out any tool a lens set. THE surface every tool-wire reader should consult ( the
	 *  turn manifest + suggested-injection ), so the composability of tools mirrors habits' lens→agent
	 *  override. A draft with no lens just returns its own `toolModes`. */
	effectiveToolModes(): Record<string, ToolMode> {
		return { ...this.composedToolModes, ...this.toolModes };
	}

	/**
	 * What a LENS supplies for one path, before any agent override — the authored mode off the lens POLICY,
	 * or `on` for a node a lens dredges without naming in its table. `null` when no lens supplies the path
	 * at all, which is also the "is there anything to inherit?" question every composition surface asks.
	 *
	 * Read from POLICY, deliberately — never from the node's live `included` flag, which `getContextBlocks`
	 * MUTATES on every compile ( see its doc comment: "never off the node's live `included`, which we
	 * mutate here" ). `effectiveHabitMode` used to read exactly that mutated flag, so the inherited mode it
	 * reported depended on whether a compile had run since — and the agent screen's "is this overridden?"
	 * could disagree with the write path's idea of the natural mode, writing a same-value override that
	 * could never be cleared. Policy is authored state; it holds still.
	 *
	 * Floored at `on`: a lens that authors `off` is declining to push the thing, not forcing it out of an
	 * agent that wears the lens — taking something fully off is the AGENT's call, and that floor is what
	 * makes `off` unambiguously an agent-level decision on every row.
	 */
	lensNaturalMode( path: string ): SlotMode | null {
		const norm  = ( s: string ): string => s.replace( /\\/g, '/' );
		const entry = this.getPolicy().find( e => e.href && norm( path ).endsWith( norm( e.href ) ) );
		if ( entry ) return entry.mode === 'off' ? 'on' : entry.mode;
		return this.getNodes().some( n => n.getPath() === path ) ? 'on' : null;
	}

	/** One habit's NATURAL resting mode — what it is with no agent override at all: the lens's authored
	 *  mode where a lens supplies it, else `suggested` for the agent's own pick ( adding a habit means
	 *  wanting it; the legacy binary `habitOff` set still forces `off` ). `null` for a path this agent
	 *  carries no habit for. THE read the write path compares a click against, so clicking a row's own
	 *  resting value clears the override instead of re-storing it. */
	naturalHabitMode( path: string ): SlotMode | null {
		const lensMode = this.lensNaturalMode( path );
		if ( lensMode !== null ) return lensMode;
		if ( this.baseHabitNodes.some( n => n.getPath() === path ) ) return this.habitOff.includes( path ) ? 'off' : 'suggested';
		return null;
	}

	/** The reference sibling of `naturalHabitMode` — identical shape, identical reason, one inventory
	 *  ( `baseReferenceNodes` / `referenceOff` ) different. */
	naturalReferenceMode( path: string ): SlotMode | null {
		const lensMode = this.lensNaturalMode( path );
		if ( lensMode !== null ) return lensMode;
		if ( this.baseReferenceNodes.some( n => n.getPath() === path ) ) return this.referenceOff.includes( path ) ? 'off' : 'suggested';
		return null;
	}

	/** The effective slot mode of one habit ( keyed by path ) — this agent's override if it authored one,
	 *  else the natural mode. The habit sibling of `effectiveToolModes`: the ONE read the compile and the
	 *  agent screen share, so a row's colour and what actually compiles can't drift. */
	effectiveHabitMode( path: string ): SlotMode | null {
		return this.habitModes[ path ] ?? this.naturalHabitMode( path );
	}

	/** The effective slot mode of one reference ( keyed by path ) — EITHER a lens-inherited reference OR one
	 *  of this agent's own `baseReferences`. The reference sibling of `effectiveHabitMode`. */
	effectiveReferenceMode( path: string ): SlotMode | null {
		return this.referenceModes[ path ] ?? this.naturalReferenceMode( path );
	}

	// ── Lens surface ──────────────────────────────────────────────────────────

	/**
	 * The AUTHORED lenses — the composed stack minus the inherited base floor, in stack order.
	 *
	 * THE distinction this surface exists to draw ( 2026-07-30 ): `lenses` is what COMPILES, `domainLenses`
	 * is what the agent WEARS. `_lens-base` is inherited, not composed — nobody chose it, every agent has
	 * it, and it carries no identity — so every question about the agent's own composition ( is it a draft?
	 * what is its primary? what gets persisted to `agent_lens`? ) has to be asked of this list, never of
	 * `lenses`. Conflating the two is what kept the base floor OUT of a lensless draft's context: Starmind's
	 * `Agents.withBase` refused to append base to an empty stack precisely because `isDraft()` read
	 * `lenses.length`, so appending it would have deployed the draft. With draft-ness asked of the authored
	 * list instead, base can ride on every agent — including a draft — the way inheritance always meant.
	 */
	get domainLenses(): LensObject[] { return this.lenses.filter( l => !InstallManifest.isBaseLens( l.getPath() ) ); }

	/**
	 * THE base-floor policy — the one place either face decides how the inherited floor joins a lens stack.
	 *
	 * The rule, all of it:
	 *
	 * - **Appended LAST, never first.** `SlotResolver.compilePlan`'s same-rank tie breaks toward the
	 *   FIRST-encountered candidate ( every lens collapses to source layer `'lens'`, with no distinct
	 *   base/primary rank ), so a named lens must PRECEDE base for its own habit to win the class. An
	 *   authored override beating the floor is the entire point of an override.
	 * - **Once.** A stack already carrying a floor is returned untouched, so this is safe at every choke
	 *   point that rebuilds a stack — including ones that start from an already-floored list.
	 * - **Tolerant.** A null base ( missing or unreadable file ) yields the stack unchanged: a half-installed
	 *   or hand-built vault still compiles, just without a floor.
	 *
	 * `base` is passed IN rather than loaded here because loading needs disk and this class is deliberately
	 * Node-free — and because the two faces genuinely resolve it differently ( a `Vault` against its own
	 * root pair, Starmind against the active project's vault path ). What must not differ is the rule, and
	 * that is what lives here.
	 *
	 * CALLER CONTRACT — pass a FRESH instance, never a cached or shared one. A `LensObject` carries mutable
	 * dredge state ( `setIncluded` flips per-agent ), so one shared base would leak one agent's toggles into
	 * every other agent wearing the floor.
	 *
	 * This exists because the rule was previously spelled once per face, kept in step by a comment asking
	 * them to agree — and they silently stopped agreeing: Starmind's copy grew an exception that skipped the
	 * floor for a lensless draft, which the vault-side copy had no way to notice.
	 */
	static withFloor( lenses: LensObject[], base: LensObject | null ): LensObject[] {
		if ( !base ) return lenses;
		if ( lenses.some( l => InstallManifest.isBaseLens( l.getPath() ) ) ) return lenses;
		return [ ...lenses, base ];
	}

	/**
	 * THE composition surface — every file in this agent's compiled context, priced at what it really costs.
	 *
	 * The read a composition view wants, as opposed to `compiledBlocks()`, which is the read the WIRE wants.
	 * Same underlying compile, projected by artifact instead of by block, so a chart built on this and the
	 * text that ships can never disagree. Rows come out in load order: each lens, then the files it brings.
	 *
	 * Where each weight comes from:
	 *
	 * - **A lens** — its own non-care body plus its share of the merged care bands. The bands merge every
	 *   lens's prose into one block, so a share is apportioned proportionally against the band's REAL weight
	 *   rather than by summing the parts ( the merge strips each section's heading and adds its own labels,
	 *   so the parts do not equal the whole ). Without this the inheritance floor prices at zero, because
	 *   base is care prose and routing tables and nothing else.
	 * - **`suggested`** — the artifact's own blocks in the compiled body. Real text, real weight.
	 * - **`on`** — its surviving row in the deduped manifest ( `ContextAssembler.manifestRows` ). An `on`
	 *   artifact contributes a pointer, not a body, and that row is the only text it puts on the wire.
	 * - **`off`, or a slot nothing fills** — zero, and still listed. What an object declines is part of how
	 *   it is composed, so the inventory keeps it.
	 *
	 * Walks POLICY rather than the dredged node list, because the dredge drops `off` targets and plans
	 * entirely — the inventory has to survive that. An artifact several lenses declare is attributed once,
	 * to the first, matching the compile's own dedup.
	 */
	composition(): CompositionRow[] {
		const norm      = ( s: string ): string => s.replace( /\\/g, '/' );
		const weigh     = ( t: string ): number => t ? KCDPrimitive._estimateTokens( t ) : 0;
		const survivors = SlotResolver.compilePlan( this.getContextBlocks() ).survivors;
		const isIndex   = ( b: TaggedBlock ): boolean => b.section !== null && Agent.INDEX_SECTIONS.has( b.section );

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

		const root = this.primaryLens;
		const rel  = ( abs: string ): string => norm( ( root ?? this.lenses[ 0 ] )?.vaultRelative( abs ) ?? abs );

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
				mode: 'suggested', tokens: ( core.get( lp ) ?? 0 ) + careFor( lp ),
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

				const mode = ( this.habitModes[ p ] ?? this.referenceModes[ p ] ?? entry.mode ) as SlotMode;
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

		// The agent's OWN bolted-on artifacts ( Starmind's base habits / references ) — no lens declares them,
		// so they are attributed to the agent itself rather than borrowed onto one.
		for ( const node of [ ...this.baseHabitNodes, ...this.baseReferenceNodes ] ) {
			const p = norm( node.getPath() );
			if ( seen.has( p ) ) continue;
			seen.add( p );
			const mode = ( this.habitModes[ p ] ?? this.referenceModes[ p ] ?? 'suggested' ) as SlotMode;
			out.push( {
				path: p, name: node.getName(), kind: node.getType(), source: 'agent', slot: slotOf( node ),
				mode, tokens: mode === 'off' ? 0 : ( core.get( p ) ?? rowWeight.get( rel( node.getPath() ) ) ?? 0 ),
			} );
		}

		return out;
	}

	/** The primary lens — the first AUTHORED lens ( base is never primary ), or null for a draft. */
	get primaryLens(): LensObject | null { return this.domainLenses[ 0 ] ?? null; }

	/** A draft cannot run: no lens has been COMPOSED onto it yet. Base doesn't count — it is inherited,
	 *  not chosen, so a base-only agent is still a draft ( it stands on the floor; it has no identity ). */
	isDraft(): boolean { return this.domainLenses.length === 0; }

	/** The primary lens's path — the agent's path identity — or null for a draft. */
	getPath(): string | null { return this.primaryLens?.getPath() ?? null; }

	// ── The lens read surface, aggregated across every composed lens (null-safe) ──

	getNodes(): KCDPrimitive[]        { return this.lenses.flatMap( ( l ) => l.getNodes() ); }
	getPolicy(): PolicyEntry[]        { return this.lenses.flatMap( ( l ) => l.getPolicy() ); }
	getContributors(): KCDPrimitive[] { return this.lenses.flatMap( ( l ) => l.getContributors() ); }
	getFrontmatter(): Record<string, unknown> { return this.primaryLens?.getFrontmatter() ?? {}; }
	getSections(): Record<string, string>      { return this.primaryLens?.getSections() ?? {}; }

	// ── Context assembly ────────────────────────────────────────────────────────

	/**
	 * THE context-composition point — the fat-object query, and the ONE source of truth every reader
	 * below shares. It asks each lens for its region-blocks ( a lens recursively folds its own dredged +
	 * injected nodes ), then adds this agent's OWN materialized base habits tagged the `agent` source
	 * layer ( so they OUTRANK the lens in a contended slot — an agent's habit choice supersedes the
	 * lens's, the composability of behaviour ). Deduped so one artifact contributes ONCE, from its most
	 * specific source. `contribute()` ( the wire text ) and `slots()` ( the structured view ) are both
	 * thin reads of this, so a composition screen can never show a resolution the compiled context
	 * doesn't honour, and neither can drift into a leak the other doesn't see.
	 */
	getContextBlocks(): TaggedBlock[] {
		// Apply this agent's OVERRIDES ( `habitModes` / `referenceModes` ) to the inherited lens habits AND
		// references BEFORE assembly: re-mode each dredged node to its EFFECTIVE mode ( the agent's override,
		// else the lens's own authored mode read off policy — never off the node's live `included`, which we
		// mutate here, so clearing an override reverts cleanly instead of sticking ). `suggested` rides the
		// full body; `on` demotes it to a routing row only; `off` excludes it ( its manifest row is struck
		// below ). One mechanism, two axes: the same `included` gate that governs every node
		// ( `KCDPrimitive.getContextBlocks` ) governs an overridden habit OR reference alike — no per-mode
		// block surgery. Injected / policy-less nodes are left untouched ( an injected drop is always-on ).
		const norm       = ( s: string ): string => s.replace( /\\/g, '/' );
		const offHabits  = new Set<string>();
		const offRefs    = new Set<string>();
		for ( const lens of this.lenses ) {
			const policy = lens.getPolicy();
			const lensModeFor = ( p: string ): SlotMode =>
				policy.find( e => e.href && norm( p ).endsWith( norm( e.href ) ) )?.mode ?? 'on';
			for ( const node of lens.getNodes() ) {
				const type = node.getType();
				if ( type !== 'habit' && type !== 'reference' ) continue;
				const path      = node.getPath();
				const overrides = type === 'habit' ? this.habitModes : this.referenceModes;
				const override  = overrides[ path ];
				const inPolicy  = policy.some( e => e.href && norm( path ).endsWith( norm( e.href ) ) );
				if ( !override && !inPolicy ) continue;
				const effective = override ?? lensModeFor( path );
				node.setIncluded( effective === 'suggested' );
				if ( effective === 'off' ) ( type === 'habit' ? offHabits : offRefs ).add( path );
			}
		}

		let lensBlocks = this.lenses.flatMap( lens => lens.getContextBlocks() );
		if ( offHabits.size ) lensBlocks = Agent.dropRows( lensBlocks, offHabits, 'habits' );
		if ( offRefs.size )   lensBlocks = Agent.dropRows( lensBlocks, offRefs, 'references' );
		// The agent's OWN picks get the SAME three-state treatment as an inherited-lens override, through the
		// SAME `habitModes`/`referenceModes` maps ( keyed by path — nothing restricts them to lens paths ):
		// `off` excludes entirely, `on` demotes to a stub ( `setIncluded(false)` ), `suggested` rides the full
		// body. Absent from the map falls back to the legacy binary `habitOff`/`referenceOff` read ( off ⇒
		// excluded, else ⇒ `suggested`, full body ), so an agent with no explicit mode set for a pick behaves
		// exactly as before this tier existed. `habitOff`/`referenceOff` themselves are UNCHANGED ( still the
		// fast on/off exclusion set the agent screen's blank-slot-fill path also honors ) — this only adds a
		// finer layer on top, never removes the coarse one.
		const ownBlocks = ( nodes: KCDPrimitive[], modes: Record<string, SlotMode>, off: string[] ): TaggedBlock[] =>
			nodes
				.map( node => {
					const path      = node.getPath();
					const effective: SlotMode = modes[ path ] ?? ( off.includes( path ) ? 'off' : 'suggested' );
					if ( effective === 'off' ) return null;
					node.setIncluded( effective === 'suggested' );
					return node;
				} )
				.filter( ( n ): n is KCDPrimitive => n !== null )
				.flatMap( node => node.getContextBlocks().map( b => ( { ...b, sourceLayer: 'agent' as const } ) ) );
		const habitBlocks     = ownBlocks( this.baseHabitNodes, this.habitModes, this.habitOff );
		const referenceBlocks = ownBlocks( this.baseReferenceNodes, this.referenceModes, this.referenceOff );
		return Agent.dedupeBySource( [ ...lensBlocks, ...habitBlocks, ...referenceBlocks ] );
	}

	/** Strike `off`-overridden rows from a manifest section table ( `habits` or `references` ). A habit's
	 *  or reference's row lives in its lens's own SECTION block ( not on the node itself ), so an agent `off`
	 *  override that already excluded the body must also drop the row — matched by the row's `where` href
	 *  being the tail of the off artifact's absolute path. Rows-only surgery: the routing tier re-renders
	 *  every table from `rows` ( `ContextAssembler.mergeManifest` ), so the wire + manifest both follow this
	 *  filter with no text rewrite. A block whose rows are unchanged passes through by identity. */
	static dropRows( blocks: TaggedBlock[], offPaths: Set<string>, section: string ): TaggedBlock[] {
		const norm    = ( s: string ): string => s.replace( /\\/g, '/' );
		const offNorm = [ ...offPaths ].map( norm );
		const isOff   = ( where: string | undefined ): boolean =>
			!!where && offNorm.some( p => p.endsWith( norm( where ) ) );
		return blocks.map( b => {
			const cur = b.rows ?? [];
			if ( b.section !== section || !cur.length ) return b;
			const rows = cur.filter( r => !isOff( r.where ) );
			return rows.length === cur.length ? b : { ...b, rows };
		} );
	}

	/**
	 * The anti-leak core: one ARTIFACT contributes once, from its most-specific ( lowest-rank ) source
	 * layer. When the same path arrives from two layers — a base habit the lens also dredges, an injected
	 * node already loaded — the more specific layer's blocks win and every block of the losing layer is
	 * dropped BEFORE slot resolution, so a duplicate can never survive into the corpus. Same-path,
	 * same-rank blocks all stay ( one artifact's several regions ), and load order is preserved throughout.
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
	 * The recursive context query as one source-blind string: `getContextBlocks()` run through
	 * `SlotResolver` ( habit-class contention resolved — a losing session-log-never never rides alongside
	 * the session-log-aggressive it lost to ) and `ContextAssembler` ( merged by `data-kcd-merge-key`,
	 * sorted Care-first / injected-last ). A DRAFT still contributes its inherited base floor — base rides
	 * on every agent, composed or not ( see `domainLenses` ); the empty-array guard below is the genuinely
	 * lensless case ( an SDK-built agent, or a vault with no base file ), not draft-ness. ( The `systemPrompt`
	 * lever rides the wire but is not yet prepended here — that lands with deploy-time assembly; base
	 * references + tools join once their own resolver seams turn them into objects, the way base habits
	 * now do. )
	 */
	contribute(): string {
		if ( !this.lenses.length ) return '';
		return SlotResolver.compile( this.getContextBlocks(), Agent.SYSTEM_SEP );
	}

	/**
	 * THE compiled context surface ( the context-compiler, 2026-07-12 ) — the Agent owns the WHOLE
	 * assembly, not just identity. Shape: the merged body FIRST, then a MANIFEST at the very bottom
	 * ( once ). The lens's identity + prose is the cache-stable prefix that rarely changes turn to turn,
	 * so it leads; the manifest is the changeable, curated surface of affordances, so it trails ( Bryan,
	 * 2026-07-12: "place all manifest at the bottom of the context window" ).
	 *
	 * The manifest is what/where/why tables — the one format ( `- what — why (where)` ) that stays
	 * identical for agents and engineers all the way through: a `Files` table naming every loaded lens
	 * ( name — description — vault-relative path, the file's ID ), then one deduped routing table per
	 * `MANIFEST_SECTIONS` entry ( References / Domains / Habits / Contracts ) listing every affordance the
	 * agent can hit indirectly. It is NOT an index of "where the content is" — it is a section of tools /
	 * interactable surfaces, and its curation is a first-class lever.
	 *
	 * The body is every loaded artifact's full text, habit-class-resolved ( `SlotResolver` ) then merged
	 * + sorted ( `ContextAssembler` ), with NO per-artifact header: a loaded file's identity lives once
	 * in the manifest, its content merges into the body at its point. The legacy `stub` ( Available-on-
	 * request ) block is dropped — the References table already carries those rows. A draft compiles to its
	 * inherited base floor alone ( base is on every agent — `domainLenses` ); only a genuinely lensless
	 * agent compiles to nothing.
	 */
	compile(): string {
		return this.compiledBlocks().map( b => b.text ).join( '\n\n' );
	}

	/**
	 * THE compiled-block currency ( the compiled-context plan, 2026-07-12/13 ) — the flat, merged,
	 * post-resolution `TaggedBlock[]` `compile()` now projects to text. Shape ( band model re-ratified
	 * 2026-07-13 ): the merged body — **Care** ( by-kind `# Purpose` / `# Philosophy` bands, `buildCareBands` ) → **Memory**
	 * ( reserved, empty ) → **Knowledge** ( core, forced-read ), via `ContextAssembler.assembleBlocks` +
	 * `withBandHeadings` — first, then the bottom-of-context **Manifest** blocks ( `manifestBlocks()` —
	 * Files, then each non-empty `MANIFEST_SECTIONS` table, in `INDEX_ORDER` ), each pair of PRESENT
	 * segments separated by a literal `---` divider block. Kept as TWO separate assembles rather than one
	 * combined pass through `ContextAssembler.sort` on purpose: a single pass would tier `injected` BELOW
	 * `manifest` ( matching `ContextAssembler`'s own documented intent ), but today's actual wire puts
	 * injected content ABOVE the manifest — unifying the sort would silently change output whenever a
	 * session has injected content, which is a real behavior change, not a refactor. Flagged in the plan;
	 * not resolved either way here.
	 *
	 * `extras` ( Phase 2, 2026-07-13 ): `before` rides ahead of the body ( the model-bound root context —
	 * the ONE layer that genuinely leads everything else ), `after` trails the manifest ( the on-mode
	 * tool manifest, every suggested tool's full schema — today assembled renderer-side in
	 * `Session.wireSystemFor` ). A flat trailing array couldn't express "some extras lead, some trail";
	 * this is the real positioning the Phase 1 doc comment deferred to Phase 2.
	 *
	 * `memory` ( memory-system plan, 2026-07-13 ) — the Memory band ( `Agent.memoryBlock` over
	 * `memoryBand()`: the tag-vocabulary constant, then the system-fired PRELOAD baseline the orchestrator
	 * bound from `database.baseline_memories` ). Unlike `before`/`after` it does NOT
	 * bracket the join: it joins the BODY block list and sorts into the `memory` tier ( now BETWEEN the
	 * Lenses band and Knowledge — `ContextAssembler.tierOf` ), because its position is a property of the
	 * merged sort, not a fixed lead/trail slot. Its `## Memory` band heading is spliced by
	 * `withBandHeadings` like any other body tier; while no memory rides ( the reserved-but-empty case ),
	 * `withBandHeadings` emits nothing for the tier, so the wire carries no bare `## Memory`.
	 */
	compiledBlocks( extras: { before?: TaggedBlock[]; after?: TaggedBlock[]; memory?: TaggedBlock[]; sections?: TaggedBlock[] } = {} ): TaggedBlock[] {
		const before = extras.before ?? [];
		const after  = extras.after ?? [];
		const memory = extras.memory ?? [];
		// `sections` joins the BLOCK LIST rather than bracketing the join, for the reason `memory` does: its
		// position is a property of the merged sort, not a fixed lead/trail slot. A manifest-tagged block
		// sinks to the manifest tier and fuses with the lens graph's own rows for that section — which is
		// how a SESSION-sourced table ( grants ) lands in the same place an artifact-sourced one does.
		const sections = extras.sections ?? [];
		if ( !this.lenses.length ) return Agent.joinSegments( [ before, memory, sections, after ] );
		const blocks  = [ ...SlotResolver.compilePlan( this.getContextBlocks() ).survivors, ...memory, ...sections ];
		const inIndex = ( b: TaggedBlock ): boolean => b.section !== null && Agent.INDEX_SECTIONS.has( b.section );
		// The body is everything that ISN'T an index table and isn't the legacy Available-on-request stub.
		const body = blocks.filter( b => !inIndex( b ) && b.section !== 'stub' );

		// The care bands ( compilation pass, 2026-07-19 ): the care-region prose, grouped by KIND — one
		// `# Purpose` / `# Philosophy` block merging every lens's contribution as labeled `## {lens}`
		// sub-sections ( primary marked + leading, base last ). Built here ( `buildCareBands` ) rather than
		// in the generic merge because it needs lens NAMES + primacy; handed back as ordinary care-tier
		// blocks, so `withBandHeadings` still keeps care first with no wrapper heading over it.
		const careBlocks = body.filter( b => b.region === 'care' );
		const rest       = body.filter( b => b.region !== 'care' );
		const careBands  = this.buildCareBands( careBlocks );

		// Band headings ( Lenses / Memory / Knowledge over the body's care/memory/core tiers; Manifest over
		// the manifest ) — real headings on the real wire text, not a view-only re-skin. `withBandHeadings`
		// only fires per NON-EMPTY tier, so an agent with no core content never gets a bare "## Knowledge"
		// heading over nothing, and the reserved `memory` tier emits nothing on the wire while empty.
		const bodyBlocks  = ContextAssembler.withBandHeadings( ContextAssembler.assembleBlocks( [ ...careBands, ...rest ] ) );
		const rawManifest = this.manifestBlocks( blocks.filter( inIndex ) );
		const manifestBlocks = rawManifest.length
			? [ ContextAssembler.headingBlock( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )! ), ...rawManifest ]
			: [];
		return Agent.joinSegments( [ before, bodyBlocks, manifestBlocks, after ] );
	}

	// ── Self-assembling context ( the fat-object surface; fed by `bindEnv` ) ──────
	// Everything the Session store used to hand-gather into `compiledBlocks`'s extras bag now comes off the
	// agent's own bound environment, so ONE zero-arg call answers "what is my context" and both the renderer
	// preview and ( Phase 5 ) the send path read the SAME method — no second door, no drift by construction.

	/**
	 * THE compiled context for this agent's live wire — `compiledBlocks()` with the bound environment folded
	 * in as real blocks: the model root context LEADS ( `before` ), the baseline memory sorts into its tier,
	 * and the `on`-mode tool manifest + every `suggested` tool's full schema TRAIL ( `after` ). Memory rides
	 * only when the agent's own `system.memoryEnabled` gate is on. Zero-arg: the extras that used to be
	 * hand-gathered in `Session.compiledBlocksFor` are the agent's own bound env now.
	 */
	compiledContext(): TaggedBlock[] {
		const manifest  = this.toolManifest();
		const suggested = this.suggestedToolDefs();
		// The band, not the bare prose — the tag vocabulary heads it ( `memoryVocabulary` ). Both halves sit
		// behind the SAME `memoryEnabled` gate: an agent with memory switched off carries no memories and no
		// vocabulary either, since the vocabulary exists only to make `learn`/`recall` calls land.
		const memory    = ( this.system[ 'memoryEnabled' ] !== false ) ? this.memoryBand() : '';
		// Canonized grants ride as a real MANIFEST section, not as a trailing extra — they are a what/where/why
		// lookup table exactly like References and Habits, and tagging them as one is what puts them under the
		// `# Manifest` band with its read-on-demand directive rather than inside required reading. Being a
		// section also means the compressive merge dedupes them for free.
		const grants = this.grants ? [ Agent.sectionBlock( 'grants', this.grants ) ] : [];
		return this.compiledBlocks( {
			sections: grants,
			before: Agent.joinSegments( [
				// The agent's OWN authored instruction leads everything — it is the most specific statement of
				// who this agent is, and it led the wire long before the compile existed ( the orchestrator's
				// old `assembleSystem([ systemPrompt, ... ])` put it first ). Folding it in HERE is what closes
				// the preview ≠ wire gap on the system half: the preview showed the compile WITHOUT the system
				// prompt while the wire always carried it, so every context gauge read low by its weight.
				this.systemPrompt ? [ Agent.extraBlock( 'system-prompt', this.systemPrompt ) ] : [],
				this.rootContext  ? [ Agent.extraBlock( 'root-context',  this.rootContext  ) ] : []
			] ),
			memory: memory ? [ Agent.memoryBlock( memory ) ] : [],
			after: Agent.joinSegments( [
				manifest  ? [ Agent.extraBlock( 'tool-manifest', manifest ) ] : [],
				suggested ? [ Agent.extraBlock( 'suggested-tools', suggested ) ] : [],
				// Attachments TRAIL the whole system half, deliberately. They are its most volatile part — a
				// user attaches and detaches mid-conversation while root context and lens identity sit still —
				// and prefix caching invalidates from the earliest edit forward, so the churning thing belongs
				// last. Placed beside root context it would re-prefill the lens + tool weight on every attach.
				this.attachments ? [ Agent.extraBlock( 'attachments', this.attachments ) ] : []
			] )
		} );
	}

	/** The system half a real turn sends — `compiledContext()` projected to text. THE one string: the
	 *  renderer preview and the orchestrator's `_buildReq` both read this method, so preview == wire on
	 *  the stable half by construction. Its dynamic twin is `session.wireMessages()`. */
	wireSystem(): string {
		return this.compiledContext().map( b => b.text ).join( '\n\n' );
	}

	/** This agent's whole-context token ESTIMATE — a single pile over its assembled `wireSystem()`, so it
	 *  equals the estimate of the exact string that rides ( the atom the budget gauge reads ). The agent's
	 *  own `estimateTokens` ( it is not a `KCDPrimitive`, but shares the shape one level up ). Deliberately
	 *  loose; only the wire `usage` is exact. */
	estimateTokens(): number {
		return KCDPrimitive._estimateTokens( this.wireSystem() );
	}

	/** The compiled currency summed by coarse budget bucket — System ( root context ) / Lenses ( the agent's
	 *  own identity + routing ) / Tools ( manifest + suggested ). Read per-block off `compiledContext()`'s own
	 *  `section` tags, the same split the ring + legend group by. Attached files + conversation turns aren't
	 *  compiled blocks, so they stay their own reads wherever this is summed. */
	compiledBudget(): { system: number; lenses: number; tools: number } {
		const out = { system: 0, lenses: 0, tools: 0 };
		for ( const b of this.compiledContext() ) out[ Agent.bucketOf( b ) ] += ( b.text ? KCDPrimitive._estimateTokens( b.text ) : 0 );
		return out;
	}

	/** Group tool defs by their owning MCP server ( `ToolDef.server`, stamped main-side ), preserving
	 *  first-seen order — the folder split the roster + drawer already show, now shared onto the wire. A def
	 *  with no `server` ( a test double / pre-seam ) falls into a trailing "Other tools" bucket so nothing is
	 *  ever dropped from the manifest. */
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

	/** The system-prompt tool MANIFEST — grouped by SERVER ( folder ): each server heads its block with its
	 *  own description, then one `- name — description` line per `on`-mode tool, so the agent knows the tool
	 *  exists and can request it while its server stays lazy. Off the bound `toolDefs` + `effectiveToolModes()`;
	 *  '' when nothing is `on`. The `###` server headings let the fold view + drawer reproduce the folders. */
	toolManifest(): string {
		const modes = this.effectiveToolModes();
		const on = this.toolDefs.filter( t => modes[ t.name ] === 'on' );
		if ( !on.length ) return '';
		const sections = Agent.groupByServer( on ).map( g => {
			const head = g.doc ? `### ${ g.name }\n${ g.doc }` : `### ${ g.name }`;
			return head + '\n' + g.tools.map( t => `- ${ t.name } — ${ t.description }` ).join( '\n' );
		} );
		return '## Available tools\n\n' + sections.join( '\n\n' );
	}

	/** Every `suggested`-mode tool's FULL definition ( name + description + input schema — the real wire
	 *  weight of the injected surface ), grouped by SERVER the same way the manifest is: a `###` server band
	 *  ( name + description ) over its tools' `####` full defs. '' when nothing is `suggested`. */
	suggestedToolDefs(): string {
		const modes = this.effectiveToolModes();
		const suggested = this.toolDefs.filter( t => modes[ t.name ] === 'suggested' );
		if ( !suggested.length ) return '';
		const sections = Agent.groupByServer( suggested ).map( g => {
			const head = g.doc ? `### ${ g.name }\n${ g.doc }` : `### ${ g.name }`;
			const defs = g.tools.map( t => `#### ${ t.name }\n\n${ t.description }\n\n\`\`\`json\n${ JSON.stringify( t.inputSchema, null, 2 ) }\n\`\`\`` ).join( '\n\n' );
			return head + '\n\n' + defs;
		} );
		return '## Suggested tools\n\n' + sections.join( '\n\n' );
	}

	/** The tool names this agent injects as `suggested` — the set that rides the wire as structured `tools`,
	 *  distinct from the `on` manifest. */
	suggestedToolNames(): string[] {
		const modes = this.effectiveToolModes();
		return Object.entries( modes ).filter( ( [ , m ] ) => m === 'suggested' ).map( ( [ n ] ) => n );
	}

	/** A plain string wrapped as a synthetic wire-order `TaggedBlock` — root context / tool manifest /
	 *  suggested schemas ride `compiledBlocks()`'s one list this way instead of being hand-concatenated onto
	 *  its text a second time. `section` labels which extra it is ( the budget bucket keys off it ); never
	 *  read by the compiler itself. */
	static extraBlock( section: string, text: string ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** The coarse budget bucket one compiled block groups under — read straight off its `section` tag ( the
	 *  system-prompt + root-context extras are System, the tool extras are Tools, everything else —
	 *  identity, routing, memory, headings — is Lenses ). One read of a field the block already carries,
	 *  no second compilation. */
	static bucketOf( b: TaggedBlock ): 'system' | 'lenses' | 'tools' {
		// `attachments` is PARKED on system, knowingly. It is not lens identity and not tools, and a fourth
		// bucket is probably right — the whole point of the gauge is seeing what context costs what, and
		// folding files into "Root context" hides the exact number a user attaches a file to watch. That is
		// a compiledBudget() signature change plus the inspector band, so it lands with the renderer slice
		// rather than being half-done here.
		if ( b.section === 'system-prompt' || b.section === 'root-context' || b.section === 'attachments' ) return 'system';
		if ( b.section === 'tool-manifest' || b.section === 'suggested-tools' ) return 'tools';
		return 'lenses';
	}

	/**
	 * The by-KIND care bands ( compilation pass, 2026-07-19 ) — Purpose and Philosophy each become ONE
	 * block that MERGES every active lens's contribution as a labeled sub-section, instead of one band per
	 * lens. The primary lens leads and is marked `( Primary )` ( disputes resolve in its favor ); `_lens-base`
	 * follows, labeled `Base lens`. This is the true "group by KIND, decouple from source" output — the
	 * reader sees each identity kind ONCE, its sources folded underneath — where the earlier per-lens
	 * `# {Name} - Lens` band was a half-step ( it repeated base's care into every lens, the duplicate chips ).
	 *
	 * Each merged block is `# {Kind}` over, per contributing lens, `## {label}` over that lens's care prose.
	 * A care block carries its section's OWN surviving `### heading` ( the `data-kcd-heading` survivor ) —
	 * stripped here so the `# {Kind}` band isn't shadowed by a near-duplicate, keeping only the prose. Kinds
	 * surface in first-appearance order ( Purpose before Philosophy — natural authoring order ). The block
	 * keeps its first member's care/section tagging ( so it sorts into the care tier and labels as its kind );
	 * only `text` is synthesized. A care block belonging to no active lens ( an injected-care drop ) rides at
	 * the tail of its kind, never dropped. A base-only agent shows base AS the lens, unmarked.
	 */
	buildCareBands( careBlocks: TaggedBlock[] ): TaggedBlock[] {
		const norm   = ( s: string ): string => s.replace( /\\/g, '/' );
		const isBase = ( l: LensObject ): boolean => InstallManifest.isBaseLens( l.getPath() );
		const reals  = this.domainLenses;
		const bases  = this.lenses.filter( isBase );
		// Sub-section order: primary first, then any other real lens, then base last ( labeled "Base lens" ).
		// A base-only agent ( the SDK `loadBase` construct ) shows base AS the lens, no primary annotation.
		const ordered  = reals.length ? [ ...reals, ...bases ] : bases;
		const allPaths = new Set( this.lenses.map( l => norm( l.getPath() ?? '' ) ) );

		const title     = ( k: string ): string => k ? k.charAt( 0 ).toUpperCase() + k.slice( 1 ) : 'Care';
		const lensLabel = ( l: LensObject ): string =>
			( isBase( l ) && reals.length ) ? 'Base lens' : `${ l.getName() }${ l === reals[ 0 ] ? ' ( Primary )' : '' }`;
		// Drop a care section's own leading `### {title}` heading ( the survivor of the parser's heading nuke ),
		// so the `# {Kind}` band above it isn't shadowed by a near-duplicate; everything after it is the prose.
		const prose = ( text: string ): string => {
			const lines = text.split( '\n' );
			let i = 0;
			while ( i < lines.length && lines[ i ].trim() === '' ) i++;
			return ( i < lines.length && /^#{1,6}\s/.test( lines[ i ].trim() ) )
				? lines.slice( i + 1 ).join( '\n' ).trim()
				: text.trim();
		};

		// Distinct care KINDS in first-appearance order ( Purpose, then Philosophy ).
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
			// Care belonging to no active lens ( an injected-care drop ) — kept under its own label, never dropped.
			const orphans = members.filter( b => !allPaths.has( norm( b.path ) ) );
			if ( orphans.length ) { parts.push( '## Injected' ); for ( const o of orphans ) parts.push( prose( o.text ) ); }
			out.push( { ...members[ 0 ], text: parts.join( '\n\n' ), mergeKey: null } );
		}
		return out;
	}

	/** Join several block-list SEGMENTS with a literal `---` divider block between each pair of
	 *  segments that BOTH have content — an empty segment ( no root context bound, no `suggested`
	 *  tools armed, a draft with no body ) contributes nothing, not even a stray divider. The same
	 *  `.filter(Boolean).join(SEP)` semantics `wireSystemFor` used to hand-roll over raw strings, now a
	 *  block-list operation any caller stitching wire-order layers can reuse. */
	static joinSegments( segments: TaggedBlock[][] ): TaggedBlock[] {
		const out: TaggedBlock[] = [];
		for ( const seg of segments.filter( s => s.length ) ) {
			if ( out.length ) out.push( Agent.dividerBlock() );
			out.push( ...seg );
		}
		return out;
	}

	/** The literal `---` boundary block between two wire-order segments ( see `joinSegments` ).
	 *  Synthetic — no source artifact — so it carries the same neutral tagging every other
	 *  compiler-synthesized block does. */
	static dividerBlock(): TaggedBlock {
		return { region: 'know', section: null, mergeKey: null, text: '---', sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** The KCD manifest sections — the what/where/why routing tables. Each is hoisted OUT of the body and
	 *  into the bottom-of-context manifest as its own deduped table; every other section is prose that
	 *  stays in the body. Derived from `MANIFEST_SECTIONS` ( the ONE registry shared with
	 *  `ContextAssembler`, so the hoist set and the routing-tier/heading logic can never drift apart );
	 *  `INDEX_ORDER` is the manifest's table order after `## Files`. */
	static readonly INDEX_ORDER = MANIFEST_SECTIONS;
	static readonly INDEX_SECTIONS = new Set<string>( MANIFEST_SECTIONS );

	/**
	 * The bottom-of-context manifest ( see `compiledBlocks` ), AS BLOCKS: a `Files` block naming every
	 * loaded lens, then one routing-table block per non-empty manifest section ( References / Domains /
	 * Habits / Contracts ), in `INDEX_ORDER`. Every row is one what/where/why line; every file appears
	 * exactly once, deduped across sources by `ContextAssembler.manifestTable` so a manifest table and an
	 * inline merge can't differ. The `Files` heading is itself a manifest section — single-sourced via
	 * `ContextAssembler.title` so no caller hardcodes a `###` string. Paths are vault-relative — the
	 * primary lens's `vaultRelative`, so a stack sharing a vault root all resolve against it.
	 */
	manifestBlocks( index: TaggedBlock[] ): TaggedBlock[] {
		const root = this.primaryLens;
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

	/** One PRELOAD-memory block — the system-fired baseline selection ( memory-system plan, 2026-07-13 ),
	 *  passed to `compiledBlocks({ memory })`. `section: 'memory'` is the single marker that ( a ) sorts it
	 *  into the `memory` tier ( `ContextAssembler.tierOf` — after the lens body, before the routing
	 *  manifest ) and ( b ) keeps it OUT of the manifest hoist ( 'memory' is not a `MANIFEST_SECTIONS`
	 *  name, so `INDEX_SECTIONS` never claims it ). Synthetic ( no source artifact ), so tagged neutrally
	 *  like the manifest/divider blocks. The `## Memory` heading is a band heading spliced at render, so
	 *  `text` is the bare prose dump — the ONE factory both the live wire ( Orchestrator ) and the
	 *  renderer preview ( Session ) build from, so injection parity holds by construction. */
	static memoryBlock( text: string ): TaggedBlock {
		return { region: 'know', section: 'memory', mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** A block tagged as one of the MANIFEST sections — the door for a manifest table sourced from OUTSIDE
	 *  the lens graph. Identical to `extraBlock` but for what the tag means downstream: a section in
	 *  `INDEX_SECTIONS` sinks to the manifest tier, merges compressively with any other source's rows for
	 *  that section, and wears the canonical heading rather than an ad-hoc one. */
	static sectionBlock( section: string, text: string ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/**
	 * The Memory band's standing header — the tag vocabulary, as a CONSTANT rather than a tool.
	 *
	 * This replaces the retired `known_tags` tool ( Bryan, 2026-07-31 ). The list is ~20 short strings
	 * that cannot change mid-turn, so a tool round-trip to fetch it was always pure overhead — and worse,
	 * agents were LOOPING on it, spending turns rediscovering something cheap enough to simply carry. A
	 * standing line in the cached system half costs a few tokens once; the tool cost a full schema in
	 * every context ( it rode at mode `suggested` ) plus a round-trip whenever an agent reached for it.
	 *
	 * `lens:*` tags are filtered OUT deliberately: they are system-authoritative — `insertMemory`
	 * find-or-creates `lens:{slug}` on every save — so an agent never passes one, and listing them would
	 * be the bulk of the line for no gain. What remains is the open vocabulary an agent actually selects
	 * from. Empty `memoryTags` ( no memory store wired ) yields '' and the header simply doesn't ride.
	 */
	memoryVocabulary(): string {
		const open = this.memoryTags.filter( t => !t.startsWith( 'lens:' ) );
		if ( !open.length ) return '';
		return `Tags: ${ open.join( ', ' ) }\n`
			+ 'These are the only tags that exist — an unlisted tag is dropped on save, and you cannot mint '
			+ 'new ones. Your lens tag is applied automatically; never pass one.';
	}

	/** The whole Memory band text — the vocabulary constant, then the baseline prose. Either half may be
	 *  empty ( no store wired, a dry query ), and both empty means no band rides at all — `compiledContext`
	 *  gates on this being truthy, so the reserved-but-empty tier still emits nothing on the wire. THE one
	 *  composer: the live wire, the renderer preview, and the turn's context breakdown all read it, so the
	 *  band can't differ between what is sent, what is previewed, and what is counted. */
	memoryBand(): string {
		return [ this.memoryVocabulary(), this.memory ].filter( Boolean ).join( '\n\n' );
	}

	/**
	 * The habit-class slot resolution across this agent's WHOLE composed set — the visualization twin of
	 * `contribute()`, for the Slot UI to show every class's candidates and which one won. Reads the exact
	 * same `getContextBlocks()` and resolves it through the same `SlotResolver`, so this view can never
	 * show a different winner than the one actually compiled into the wire text.
	 */
	slots(): SlotResolution[] {
		if ( !this.lenses.length ) return [];
		return SlotResolver.describe( this.getContextBlocks() );
	}

	/**
	 * The habit cascade as a COMPOSITION surface sees it — every habit this agent carries, from either
	 * layer, each with its effective mode, whether or not it currently rides the wire.
	 *
	 * This exists because `slots()` is the wrong source for an editor and always was. `slots()` reads
	 * `getContextBlocks()` — the COMPILE — which correctly drops anything at `off`: an off habit emits no
	 * blocks, so it vanishes from the resolution, its class reads uncovered, and the agent screen redrew
	 * the row as an empty slot. Turning a habit off LOOKED like deleting it. The compile is right to drop
	 * it; the editor is wrong to read the compile. This read is built from the INVENTORY instead — the
	 * lens's dredged habit nodes plus the agent's own `baseHabitNodes` — so `off` is a state a row is IN,
	 * not an absence, exactly as the four-state model requires.
	 *
	 * Same `SlotResolver.RANK` as the real resolution ( agent beats lens ), so the winner shown here is
	 * still the winner that compiles. Pure: no `setIncluded` mutation, so calling it never perturbs what a
	 * later compile produces — the bug that made the old path order-dependent.
	 *
	 * Classless habits ride along, one entry each with `habitClass: null` and a single candidate: nothing
	 * contends a slot they don't have, but a composition surface still wants them in the same currency.
	 */
	habitSlots(): HabitSlotView[] {
		const candidates: HabitSlotCandidate[] = [];
		const seen = new Set<string>();
		const add = ( node: KCDPrimitive, sourceLayer: SourceLayer ): void => {
			const path = node.getPath();
			// one artifact contributes ONE candidate, from its most specific layer — the agent's own pick of
			// a habit its lens also carries is the same artifact, not a rival of itself. Agent is added first,
			// so the lens copy of the same path is skipped.
			if ( seen.has( path ) ) return;
			seen.add( path );
			const cls = node.getFrontmatter()[ 'habit-class' ];
			candidates.push( {
				path,
				habitClass: typeof cls === 'string' && cls ? cls : null,
				sourceLayer,
				mode: ( sourceLayer === 'agent' ? this.effectiveHabitMode( path ) : this.habitModes[ path ] ?? this.lensNaturalMode( path ) ) ?? 'on',
				natural: this.naturalHabitMode( path ) ?? 'on',
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

	/** The separator between system-prompt layers — the one place the live turn and the Constellation
	 *  commit-bake agree on how the layers join, so they can never drift apart. */
	static readonly SYSTEM_SEP = '\n\n---\n\n';

	/** The id every `Vault.buildAgent` agent carries — a lens substrate with no authored identity, built to
	 *  compile and then discarded. Reserved and deliberately SHARED across every vault build: it makes "this
	 *  is not an authored agent" legible on the object itself, rather than a fact known only to whoever wrote
	 *  the call site. Never persisted — the database only ever holds authored agents, which is why
	 *  `AgentRow.model` stays concrete while `Agent.model` is nullable. */
	static readonly VAULT_AGENT_ID = 'vault-agent';

	/**
	 * Join system layers in order, dropping empties, with the canonical separator. The ONE formula shared
	 * by the live turn (the orchestrator's per-round system assembly) and the Constellation commit-bake —
	 * extract-once so the two surfaces can't drift.
	 */
	static assembleSystem( parts: ( string | null | undefined )[] ): string {
		return parts.filter( Boolean ).join( Agent.SYSTEM_SEP );
	}

	/**
	 * This agent's frozen IDENTITY — the "who": its `systemPrompt` over its recursive lens contribution
	 * (Know/Care/Do). The Constellation bakes this onto a work node at commit, so the run carries the
	 * agent's whole KCD framework rather than a bare model. (The live session interleaves the — currently
	 * empty — above-lens layer between the two; here there is nothing between them.)
	 */
	identity(): string {
		return Agent.assembleSystem( [ this.systemPrompt, this.compile() ] );
	}

	/**
	 * The agent's identity BROKEN OUT by source — the PRE-MERGE, per-source twin of `identity()`, in
	 * flat load order (systemPrompt, then per lens its header block + each contributing node). This
	 * is the Atlas's human-audience view — the context-optimization plan's design deliberately keeps
	 * it separate from the wire: `identity()`/`contribute()` now run every lens's blocks through
	 * `ContextAssembler` (Care-hoisted, `data-kcd-merge-key` groups fused, injected sunk last), so
	 * joining these segments no longer reproduces `identity()` byte-for-byte once a session has
	 * Care content, a merge group, or injected context. Reconciling the two views is Phase 5; today
	 * they intentionally diverge — see the plan's "Atlas is the human audience; the wire is the AI
	 * audience" ruling. Token counts are filled at run time (null here — the tokenizer lives
	 * main-side, on the connector).
	 */
	identitySegments(): ContextSegment[] {
		const segs: ContextSegment[] = [];
		if ( this.systemPrompt ) segs.push( { source: 'system', label: 'system prompt', text: this.systemPrompt, tokens: null } );
		for ( const lens of this.lenses ) {
			const block = lens.toContextBlock();
			if ( block ) segs.push( { source: 'lens', label: lens.getPath() ?? 'lens', text: block, tokens: null } );
			for ( const node of lens.getNodes() ) {
				const text = node.contribute();
				if ( text ) segs.push( { source: node.getType(), label: node.getName(), text, tokens: null } );
			}
		}
		return segs;
	}
}
