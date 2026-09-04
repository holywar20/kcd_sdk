import { LensObject } from '../primitives/framework/LensObject';
import { SlotResolver } from '../primitives/framework/SlotResolver';
import type { SlotResolution } from '../primitives/framework/SlotResolver';
import { ContextAssembler, MANIFEST_SECTIONS } from '../primitives/framework/ContextAssembler';
import { KcdContext } from '../core/html/KcdContext';
import type { Command } from '../core/Command';
import type { SlotRow } from '../core/html/KcdContext';
import { InstallManifest } from '../core/InstallManifest';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SegmentKey, SerializedArtifact, SerializedLens, SlotMode, SourceLayer, TaggedBlock } from '../primitives/types';

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
import type { Policy, Surface } from '../primitives/ToolAccess';
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
	/** The workspace this agent belongs to ( `projects.id` ). An agent's lens paths are vault-relative,
	 *  so it only means anything inside its own project — which is why the project rides WITH the agent
	 *  rather than being inferred from whichever one happens to be open. '' only before a row is read. */
	projectId: string;
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
	 *
	 * THERE IS NO `baseTools` HERE ANY MORE. It was the tool half of this inventory and it never had a
	 * consumer — `toolPolicies` answers both "does this agent hold it" and "may it run", because those were
	 * always the same question. Two fields meant two answers that could disagree, on the axis where a
	 * disagreement is silent permission.
	 */
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
	 * MAY IT RUN — this agent's contribution to the run's passport, keyed by tool IDENTITY ( `group.tool` ).
	 *
	 * PRESENCE IS THE ALLOWANCE. A tool absent from here and from every lens is denied, because absence and
	 * deny are one fact rather than two — which is what makes a denial unable to leak: it is not there. There
	 * is deliberately no second field saying which tools this agent HOLDS, since inclusion and permission
	 * terminate on the same state and writing both was one concept spelled twice.
	 *
	 * `allow` is what an add writes, in the same gesture — there is no state a tool sits in waiting to be
	 * switched on. `ask` is a later, deliberate tightening. `off` is a SUBTRACTION of something a lens
	 * supplied, and it is spent at assembly rather than carried; see `toolAllowances`. */
	toolPolicies: Record<string, Policy>;

	/** HOW MUCH OF EACH HELD TOOL RIDES IN THE PROMPT — `manifest` ( a name and a line ) or `preload` ( the
	 *  whole schema, before the agent asks ). Absent = `manifest`, the cheap answer. Read only for tools that
	 *  survived assembly: a thing that is not there has no cost to answer for. */
	toolSurfaces: Record<string, Surface>;
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
	 * Per-HABIT three-state OVERRIDE, keyed by the habit's path — the exact `toolPolicies` idiom for habits:
	 * an agent-level override of a LENS-contributed habit's slot mode. ABSENT for a path = inherit the
	 * lens's own mode ( the agent screen greys the row to say "not overridden" ); PRESENT = the agent forces
	 * that habit to `off` ( excluded, its manifest row dropped ), `on` ( routing row only ), or `suggested`
	 * ( full four-field body rides ), regardless of what the lens said. Distinct from `habitOff` ( the binary
	 * exclusion of the agent's OWN `baseHabits` ) — this overrides INHERITED habits, and carries the on↔suggested
	 * tier `habitOff` can't express. The composability of behaviour, same shape as `toolAllowances()`. */
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
	/** The owning workspace ( `projects.id` ). Omitted by a bare or test agent; the callers that know it
	 *  ( the row loader, the two birth paths ) supply it. */
	projectId?: string;
	name?: string;
	icon?: string | null;
	color?: string | null;
	/** Omit for the default; pass null explicitly for an agent that never dispatches ( see the field ). */
	model?: string | null;
	systemPrompt?: string | null;
	lenses?: LensObject[];
	baseHabits?: string[];
	baseReferences?: string[];
	basePlans?: string[];
	toolPolicies?: Record<string, Policy>;
	toolSurfaces?: Record<string, Surface>;
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
 * THE KEY ONE TOOL'S MODE IS FILED UNDER — its wire identity, and the bare name only when it has none.
 *
 * ONE READING, so the surfaces that WRITE a mode and the projections that READ one cannot disagree. They
 * did: the agent panel wrote a bare name and the capability deck wrote a qualified one into the same map,
 * while the manifest read bare and the harness cut read qualified — so each reader was blind to one writer
 * and a tool switched off on the wrong surface stayed on the wire. The identity rides on the def now ( see
 * `ToolDef.id` ), and this is the only place a reader decides what to look up.
 *
 * The bare fallback is for a def that never crossed the priced serve seam — a test double, which has no
 * server and therefore no identity to be filed under.
 */
/** The tool identities this agent holds, as a set — every reader below asks the same question of the same
 *  list, and none of them re-derives it. A def with no identity cannot be held: policy keys on `group.tool`,
 *  so a def that never crossed the priced serve seam has no name the allowances could have been written
 *  under. That used to fall back to the bare name, which is precisely how one map came to be written under
 *  two spellings and read under two more. */
function _heldIds( defs: readonly ToolDef[] ): ToolDef[] {
	return defs.filter( ( d ) => !!d.id );
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
	/** The workspace this agent belongs to ( see SerializedAgent.projectId ). READONLY: because its lens
	 *  paths are vault-relative, moving an agent between projects is a migration, not a field write. */
	readonly projectId: string;
	name: string;
	icon: string | null;
	color: string | null;
	model: string | null;
	systemPrompt: string | null;

	/** The composed lenses (materialized graphs). `[]` = draft; `[0]` = primary. */
	lenses: LensObject[];

	// ── base{X}: bolted directly here; dumb strings; the user's add/subtract surface ──
	baseHabits: string[];
	baseReferences: string[];
	basePlans: string[];

	/** MAY IT RUN, by tool identity — presence IS the allowance (see SerializedAgent.toolPolicies). */
	toolPolicies: Record<string, Policy>;
	/** What each held tool costs in prompt (see SerializedAgent.toolSurfaces). */
	toolSurfaces: Record<string, Surface>;

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
	composedHabits: string[] = [];
	composedReferences: string[] = [];
	composedPlans: string[] = [];
	/** The tool allowances CONTRIBUTED by the lenses, materialized in compose(). The baseline this agent's
	 *  own `toolPolicies` overlays, agent-wins-per-tool. Never persisted — rebuilt from the lenses. */
	composedToolPolicies: Record<string, Policy> = {};
	/** The lenses' contribution on the COST axis, overlaid the same way and INDEPENDENTLY: an agent that
	 *  tightens a lens's tool has said nothing about what that tool costs. */
	composedToolSurfaces: Record<string, Surface> = {};

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

	/** What the HOST — Starmind itself — says to every agent running inside it. Leads the compiled context,
	 *  above even the agent's own identity.
	 *
	 *  BOUND like the rest of the environment rather than authored here, and that is the layering: an agent
	 *  knows WHERE the host's voice sits, never what it says. It is written in code by the dispatch tier —
	 *  never in the vault, never through a link, and never user-editable, because a user cannot be allowed
	 *  to rewrite the app's own description of its own surfaces. '' when nothing binds it, which is every
	 *  SDK-built agent outside a dispatch. */
	hostPrompt: string = '';
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
	/** The bound session's CANONIZED grants ( `Session.grantRows()` ) — the what/where/why rows for
	 *  everything the user handed this run whose turns have since been compacted.
	 *
	 *  STRUCTURED ROWS, unlike `attachments`, and the difference is not a style choice — it is what the
	 *  destination requires. Attachments ride as an `extraBlock`, which passes through the assembler
	 *  untouched, so a composed string is exactly right there. Grants ride as a manifest SECTION, and a
	 *  manifest section is merged: the assembler reads each block's `rows` and re-renders from them, never
	 *  parsing text back apart. Held as a string, this contributed nothing and every canonized grant was
	 *  dropped between here and the wire.
	 *
	 *  Only the HOISTED set arrives here. A grant whose turn still rides already carries its reference line
	 *  in the transcript, and a manifest row beside it would state one fact twice; promotion waits for the
	 *  compaction that removed the line. Empty until something has been canonized, which is most sessions. */
	grantRows: SlotRow[] = [];
	/** THE COMMANDS THIS RUN MAY RUN — the objects, not a rendering of them. Bound with the denied ones
	 *  ALREADY REMOVED: a command a person switched off is ABSENT here rather than present-and-refused, which
	 *  is the only shape in which "the agent has not heard of it" can be true. `[]` until bound, and `[]` is a
	 *  legitimate answer — holding no commands is not a failure to bind. */
	commandRows: readonly Command[] = [];
	/**
	 * THE MANIFEST BANDS this run's tools author for themselves — each a `##` section under `# Manifest`,
	 * composed by the HOST and bound here already rendered.
	 *
	 * A TOOL MAY BE A DOOR ONTO MORE THAN ITSELF. Every tool earns an ordinary manifest row saying what it
	 * is; a few also OWN a band, which is what turns one tool into the entry point to a body of
	 * functionality no schema could express — and what lets a person extend an agent's reach by authoring
	 * content rather than by touching architecture. The command roster is the first: somebody writes a
	 * command, and this grows a section describing it.
	 *
	 * ALREADY NARROWED, AND ALREADY SORTED, both by the host. Narrowed because a band describing something
	 * the gate would refuse is the same defect as a manifest naming a tool the wire omits, and the passport
	 * is the only thing entitled to answer that. Sorted because the ORDER is a prefix-cache contract: the
	 * same holdings must compose the same context every turn, and nothing here is entitled to decide which
	 * band matters more.
	 *
	 * `[]` is a legitimate answer — holding no bands is not a failure to bind.
	 */
	manifestGroups: readonly { heading: string; body: string }[] = [];
	/** WHAT THIS RUN HOLDS, said to the agent itself — composed by the HOST from the run's passport and bound
	 *  here as opaque text.
	 *
	 *  DELIBERATELY NOT DERIVED BY THIS OBJECT, and the reason is the same one `hostPrompt` carries: an agent
	 *  describing its own permissions would be a second author on a question the permission authority already
	 *  answers, and the failure mode of two authors on that question is a description that is reassuring and
	 *  wrong. This holds the sentence; it does not write it. '' when nothing governs the run. */
	capability: string = '';
	/** The CALLER's layer above the lens — a room frame, a Constellation step frame, whatever framed this
	 *  particular turn. Bound per ROUND like the rest of the environment; '' when nothing framed it.
	 *
	 *  It trails the agent's own identity for the reason attachments do: general before specific. A standing
	 *  identity is true of every turn this agent will ever take; a frame is true of exactly one. */
	frame: string = '';
	/** The turn's prompt-SHAPING line — today, the thinking-mode request to reason in the visible reply.
	 *  Opaque bound TEXT, deliberately not something this object derives: deciding what shapes a turn is
	 *  dispatch policy, and the agent's only job is knowing where it sits. '' when nothing shapes it. */
	modeLine: string = '';

	private constructor(
		id: string,
		projectId: string,
		name: string,
		icon: string | null,
		color: string | null,
		model: string | null,
		systemPrompt: string | null,
		lenses: LensObject[],
		baseHabits: string[],
		baseReferences: string[],
		basePlans: string[],
		toolPolicies: Record<string, Policy>,
		toolSurfaces: Record<string, Surface>,
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
		this.projectId      = projectId;
		this.name           = name;
		this.icon           = icon;
		this.color          = color;
		this.model          = model;
		this.systemPrompt   = systemPrompt;
		this.lenses         = lenses;
		this.baseHabits     = baseHabits;
		this.baseReferences = baseReferences;
		this.basePlans      = basePlans;
		this.toolPolicies   = toolPolicies;
		this.toolSurfaces   = toolSurfaces;
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
			opts.projectId ?? '',
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
			opts.baseHabits ?? [],
			opts.baseReferences ?? [],
			opts.basePlans ?? [],
			opts.toolPolicies ?? {},
			opts.toolSurfaces ?? {},
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
			json.projectId ?? '',   // absent on a payload written before agents carried their project
			json.name,
			json.icon,
			json.color,
			json.model === undefined ? DEFAULT_MODEL_KEY : json.model,   // absent → default; null → stays null ( see create )
			json.systemPrompt ?? null,
			lenses,
			json.baseHabits ?? [],
			json.baseReferences ?? [],
			json.basePlans ?? [],
			json.toolPolicies ?? {},
			json.toolSurfaces ?? {},
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
			projectId:      this.projectId,
			name:           this.name,
			icon:           this.icon,
			color:          this.color,
			model:          this.model,
			systemPrompt:   this.systemPrompt,
			lenses:         this.lenses.map( ( l ) => l.serializeForWire() ),
			baseHabits:     [ ...this.baseHabits ],
			baseReferences: [ ...this.baseReferences ],
			basePlans:      [ ...this.basePlans ],
			toolPolicies:   { ...this.toolPolicies },
			toolSurfaces:   { ...this.toolSurfaces },
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
	 * A TOOL IS NOT A DREDGED NODE, so a lens contributes tools as two per-tool maps rather than as paths —
	 * an ALLOWANCE map and a COST map, read off each lens and overlaid in order. Later lenses override
	 * earlier ones per tool; this agent's own maps then override all of them ( `toolAllowances()` ).
	 */
	compose(): void {
		const nodes = this.lenses.flatMap( ( l ) => l.getNodes() );
		this.composedReferences = _pathsOfType( nodes, 'reference' );
		this.composedPlans      = _pathsOfType( nodes, 'plan' );
		this.composedHabits     = _pathsOfType( nodes, 'habit' );
		this.composedToolPolicies = {};
		this.composedToolSurfaces = {};
		for ( const l of this.lenses ) {
			Object.assign( this.composedToolPolicies, l.getToolPolicies() );
			Object.assign( this.composedToolSurfaces, l.getToolSurfaces() );
		}
	}

	/**
	 * Bind the wire's EXTERNAL layers onto the agent — the environment `compiledContext()` needs beyond the
	 * agent's own object graph. Flush-and-fill, like `compose()`: pass the whole environment ( a partial
	 * overwrites only the keys it names ), call it whenever a source changes, and trust the fresh rebuild.
	 * Cheap; there is no delta path to keep in sync. The renderer's Agent store calls this when the MCP tool
	 * defs / model root context / baseline memory change ( then `triggerRef` ); the orchestrator calls it per
	 * round on the canonical agent. Never persisted — this is live environment, not agent identity.
	 */
	bindEnv( env: { hostPrompt?: string; rootContext?: string; toolDefs?: ToolDef[]; memory?: string; memoryTags?: string[]; attachments?: string; grants?: SlotRow[]; commands?: readonly Command[]; manifestGroups?: readonly { heading: string; body: string }[]; capability?: string; frame?: string; modeLine?: string } ): void {
		if ( env.hostPrompt  !== undefined ) this.hostPrompt  = env.hostPrompt;
		if ( env.rootContext !== undefined ) this.rootContext = env.rootContext;
		if ( env.toolDefs    !== undefined ) this.toolDefs    = env.toolDefs;
		if ( env.memory      !== undefined ) this.memory      = env.memory;
		if ( env.memoryTags  !== undefined ) this.memoryTags  = env.memoryTags;
		if ( env.attachments !== undefined ) this.attachments = env.attachments;
		if ( env.grants      !== undefined ) this.grantRows   = env.grants;
		if ( env.commands    !== undefined ) this.commandRows = env.commands;
		if ( env.manifestGroups !== undefined ) this.manifestGroups = env.manifestGroups;
		if ( env.capability  !== undefined ) this.capability  = env.capability;
		if ( env.frame       !== undefined ) this.frame       = env.frame;
		if ( env.modeLine    !== undefined ) this.modeLine    = env.modeLine;
	}

	/** What this agent actually carries = bolted-on ∪ inherited-from-lenses. The permissions
	 *  gate reads `effectiveTools`; the composer reads each pair to show base (editable here)
	 *  vs composed (edit at the lens). */
	effectiveHabits():     string[] { return _union( this.baseHabits,     this.composedHabits ); }
	effectiveReferences(): string[] { return _union( this.baseReferences, this.composedReferences ); }
	effectivePlans():      string[] { return _union( this.basePlans,      this.composedPlans ); }

	/**
	 * THE ALLOWANCES this agent contributes — the lenses' baseline with this agent's own layered over it,
	 * agent-wins-per-tool, and every subtraction spent on the way out.
	 *
	 * NOTHING DENIED SURVIVES. A tool an agent turned off is ABSENT here rather than present with an `off`
	 * beside it, and that is the whole guarantee rather than a tidiness: every later reader — the gate, the
	 * manifest, the preloaded schema, the harness cut — works from a list that cannot express a denial, so
	 * none of them can be the one that forgets to check for one. It cannot leak because it is not there.
	 *
	 * A draft with no lens just returns its own map, which for a fresh agent is empty — and an agent that
	 * holds nothing reaches nothing. That is the model rather than a gap in it.
	 */
	toolAllowances(): Record<string, Policy> {
		const merged: Record<string, Policy> = { ...this.composedToolPolicies, ...this.toolPolicies };
		for ( const [ id, policy ] of Object.entries( merged ) ) if ( policy === 'off' ) delete merged[ id ];
		return merged;
	}

	/** What one held tool COSTS — the same lens-then-agent overlay on the other axis, resolved per tool
	 *  because that is how every reader asks. INDEPENDENT of the allowance overlay, deliberately: an agent
	 *  that tightens a lens's tool to `ask` has said nothing about what that tool costs, and an override is
	 *  only ever a difference. `manifest` is the answer when nobody has said otherwise. */
	toolSurfaceFor( id: string ): Surface {
		return this.toolSurfaces[ id ] ?? this.composedToolSurfaces[ id ] ?? 'manifest';
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
	 *  else the natural mode. The habit sibling of `toolAllowances`: the ONE read the compile and the
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

		// A habit a more specific layer displaced puts nothing on the wire, so the chart must not price
		// it as though it did — chart and compile are two projections of one plan, and the whole reason the
		// slot bug read as correct behaviour was that they disagreed.
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

				const declared = ( this.habitModes[ p ] ?? this.referenceModes[ p ] ?? entry.mode ) as SlotMode;
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

		// The agent's OWN bolted-on artifacts ( Starmind's base habits / references ) — no lens declares them,
		// so they are attributed to the agent itself rather than borrowed onto one.
		for ( const node of [ ...this.baseHabitNodes, ...this.baseReferenceNodes ] ) {
			const p = norm( node.getPath() );
			if ( seen.has( p ) ) continue;
			seen.add( p );
			const declared = ( this.habitModes[ p ] ?? this.referenceModes[ p ] ?? 'suggested' ) as SlotMode;
			const mode     = displaced.has( rel( node.getPath() ) ) ? 'off' as SlotMode : declared;
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
	 * `SlotResolver` ( habit-class contention resolved — a losing log-session-never never rides alongside
	 * the log-session-liberal it lost to ) and `ContextAssembler` ( merged by `data-kcd-merge-key`,
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
		// Habit-class contention has to be settled over the NODE inventory, not the blocks: an `on`-mode
		// habit emits no blocks at all, so `SlotResolver` never sees it contend ( see `displacedHabitPaths` ).
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

	/**
	 * THE compiled context for this agent's live wire — `compiledBlocks()` with the bound environment folded
	 * in as real blocks: the model root context LEADS ( `before` ), the baseline memory sorts into its tier,
	 * and the `on`-mode tool manifest, every `suggested` tool's full schema, the attachments and the two
	 * caller layers TRAIL ( `after` ). Memory rides only when the agent's own `system.memoryEnabled` gate is
	 * on. Zero-arg: the extras that used to be hand-gathered in `Session.compiledBlocksFor` are the agent's
	 * own bound env now.
	 *
	 * This list is TOTAL — every layer that reaches the system wire is a block in it, including the caller's
	 * frame and the turn's shaping line, which the dispatcher used to join onto the projected text from
	 * outside. Totality is the point rather than a tidiness: it is what lets the wire, the round breakdown,
	 * the budget and the renderer preview all be projections of one object instead of four descriptions of
	 * the same thing, which is how they drifted before.
	 */
	compiledContext(): TaggedBlock[] {
		const manifest  = this.toolManifest();
		const suggested = this.preloadedToolDefs();
		const bands     = this.manifestBands();
		// The band, not the bare prose — the tag vocabulary heads it ( `memoryVocabulary` ). Both halves sit
		// behind the SAME `memoryEnabled` gate: an agent with memory switched off carries no memories and no
		// vocabulary either, since the vocabulary exists only to make `learn`/`recall` calls land.
		const memory    = ( this.system[ 'memoryEnabled' ] !== false ) ? this.memoryBand() : '';
		// Canonized grants ride as a real MANIFEST section, not as a trailing extra — they are a what/where/why
		// lookup table exactly like References and Habits, and tagging them as one is what puts them under the
		// `# Manifest` band with its read-on-demand directive rather than inside required reading. Being a
		// section also means the compressive merge dedupes them for free.
		// EMPTY MEANS ABSENT, and it has to be checked on the rows rather than on a composed string: a
		// heading with nothing under it is not a harmless artifact of an empty session, it is what a dropped
		// table looks like, and it told every reader the section was working.
		const grants = this.grantRows.length
			? [ Agent.sectionBlock( 'grants', this.grantRows.map( ( r ) => KcdContext.renderRow( r ) ).join( '\n' ), this.grantRows ) ]
			: [];
		return this.compiledBlocks( {
			sections: grants,
			before: Agent.joinSegments( [
				// The HOST's own prompt leads everything — Starmind describing the environment the agent is
				// running inside, above the agent's identity rather than beside it. Ordered first for the
				// prefix cache as much as for meaning: it is the most-SHARED layer on the wire, identical for
				// every agent in every session, and a cache invalidates from the earliest edit forward, so the
				// layer that never varies belongs where nothing beneath it can force it to be re-prefilled.
				this.hostPrompt   ? [ Agent.extraBlock( 'host-prompt',   this.hostPrompt   ) ] : [],
				// The agent's OWN authored instruction follows it — the most specific statement of
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
				// THE AUTHORED BANDS CLOSE THE MANIFEST — second categories beside the tool manifest, never
				// subsections inside it. The command roster is the one that made the argument and it generalizes
				// unchanged: a command is not a tool from a different source, it has no tier, no deferred schema
				// and its own call convention, and the same is true of whatever a later tool authors for itself.
				// Sat with the manifests rather than with the volatile trailers below because a roster is STABLE
				// across a conversation, and the prefix cache wants the settled things above the churning ones.
				//
				// ONE BLOCK FOR ALL OF THEM, not one block each. The tag names the CATEGORY, and a per-band tag
				// would let the set of blocks change shape with a person's authoring — which is a compiled-context
				// surface moving for a reason no reader of it could see.
				bands     ? [ Agent.extraBlock( 'manifest-groups', bands ) ] : [],
				// WHAT IT MAY DO closes the band that said what it HOLDS. Last of the three because it is the
				// most run-specific: tools and commands are configuration, while this is one run's resolved
				// policy and moves the moment a person touches the deck. The prefix cache wants the churning
				// layer below the settled ones — and when it does churn, invalidating from here is correct
				// rather than unfortunate: the agent's capability actually changed.
				this.capability ? [ Agent.extraBlock( 'capability', this.capability ) ] : [],
				// Attachments TRAIL the whole system half, deliberately. They are its most volatile part — a
				// user attaches and detaches mid-conversation while root context and lens identity sit still —
				// and prefix caching invalidates from the earliest edit forward, so the churning thing belongs
				// last. Placed beside root context it would re-prefill the lens + tool weight on every attach.
				this.attachments ? [ Agent.extraBlock( 'attachments', this.attachments ) ] : [],
				// The two CALLER layers close the system half. They were joined onto this string from OUTSIDE
				// until the one-assembly pass; folding them in is what makes this list TOTAL, so the wire, the
				// round breakdown, the budget and the renderer preview each project from one place instead of
				// three of them rebuilding it separately. The order is the order the hand-assembly used —
				// frame, then shaping — which is what keeps the projection byte-identical to what it replaced.
				this.frame    ? [ Agent.extraBlock( 'frame', this.frame ) ] : [],
				this.modeLine ? [ Agent.extraBlock( 'mode-line', this.modeLine ) ] : []
			] )
		} );
	}

	/** The system half a real turn sends — `compiledContext()` projected to text. THE one string, and the
	 *  WHOLE of it: `_buildReq` sends exactly this, with nothing joined on afterwards, and the renderer
	 *  preview reads the same method — so preview == wire by construction rather than by two formulas kept
	 *  in step. Its dynamic twin is `session.wireMessages()`. */
	wireSystem(): string {
		return this.compiledContext().map( b => b.text ).join( '\n\n' );
	}

	/**
	 * The same compiled list, projected to the per-source BREAKDOWN the round record and the inspector read
	 * — `wireSystem()`'s sibling, and the second of the two projections this object exists to serve.
	 *
	 * A projection, never a second derivation. The breakdown used to be rebuilt from the agent's parts by a
	 * different method under different rules, which is precisely how it came to disagree with the string
	 * that shipped. Reading the one list makes the two incapable of drifting, and the property is
	 * CHECKABLE rather than merely intended: joining these segments' text reproduces `wireSystem()` exactly,
	 * because every block's text reaches exactly one segment.
	 *
	 * Adjacent blocks sharing an identity merge into one segment, which is what keeps structure out of the
	 * reader's way — a divider does not become a row that says nothing, and one source does not appear
	 * twice under the same name. Counts are null here: the tokenizer lives main-side on the connector, and
	 * a guess would be worse than an absence.
	 */
	contextSegments(): ContextSegment[] {
		const out: ContextSegment[] = [];
		// Structural blocks waiting for the segment they introduce — see the `!owner` branch below.
		let pending: string[] = [];

		for ( const block of this.compiledContext() ) {
			const owner = Agent.segmentKey( block );

			// STRUCTURAL — a `---` divider or a band heading. It has no identity of its own, and it belongs
			// to the segment it INTRODUCES rather than to the one before it, so hold it until that segment
			// arrives. Holding rather than dropping is what keeps this a projection: every block's text
			// reaches exactly one segment, so joining the segments reproduces the wire.
			if ( !owner ) {
				pending.push( block.text );
				continue;
			}

			const text = [ ...pending, block.text ].join( '\n\n' );
			pending = [];

			// The open segment already carries this identity, so this block continues it rather than
			// starting a second segment under the same name.
			const open = out[ out.length - 1 ];
			if ( open && open.source === owner.source && open.label === owner.label ) {
				open.text = open.text + '\n\n' + text;
				continue;
			}

			out.push( { source: owner.source, label: owner.label, text, tokens: null } );
		}

		// A TRAILING divider has nothing after it to introduce, so it joins the last segment instead. A
		// compile of nothing but structure has no segment to join, and produces none.
		const last = out[ out.length - 1 ];
		if ( pending.length && last ) last.text = last.text + '\n\n' + pending.join( '\n\n' );

		return out;
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
	 *  own description, then one `- name — description` line per manifest-surface tool, so the agent knows
	 *  the tool exists and can request it while its server stays lazy. The `###` server headings let the fold
	 *  view + drawer reproduce the folders.
	 *
	 *  NO POLICY IS READ HERE, and that is the point. `toolDefs` is bound to the tools this run may actually
	 *  call, so a denied tool was never in the list — the compiler cannot advertise one because it is not
	 *  holding one. This asks the only question left: what does each of them cost. */
	toolManifest(): string {
		const on = _heldIds( this.toolDefs ).filter( t => this.toolSurfaceFor( t.id! ) === 'manifest' );
		if ( !on.length ) return '';
		const sections = Agent.groupByServer( on ).map( g => {
			const head = g.doc ? `### ${ g.name }\n${ g.doc }` : `### ${ g.name }`;
			return head + '\n' + g.tools.map( t => `- ${ t.name } — ${ t.description }` ).join( '\n' );
		} );
		return '## Available tools\n\n' + sections.join( '\n\n' );
	}

	/** Every PRELOAD-surface tool's FULL definition ( name + description + input schema — the real wire
	 *  weight of the injected surface ), grouped by SERVER the same way the manifest is: a `###` server band
	 *  ( name + description ) over its tools' `####` full defs. '' when nothing is preloaded. */
	preloadedToolDefs(): string {
		const suggested = _heldIds( this.toolDefs ).filter( t => this.toolSurfaceFor( t.id! ) === 'preload' );
		if ( !suggested.length ) return '';
		const sections = Agent.groupByServer( suggested ).map( g => {
			const head = g.doc ? `### ${ g.name }\n${ g.doc }` : `### ${ g.name }`;
			const defs = g.tools.map( t => `#### ${ t.name }\n\n${ t.description }\n\n\`\`\`json\n${ JSON.stringify( t.inputSchema, null, 2 ) }\n\`\`\`` ).join( '\n\n' );
			return head + '\n\n' + defs;
		} );
		return '## Suggested tools\n\n' + sections.join( '\n\n' );
	}

	/**
	 * THE AUTHORED BANDS, rendered — each `##` heading with its body under it.
	 *
	 * IT RENDERS AND NOTHING ELSE. What the bands say, which ones exist, and what order they come in were
	 * all decided by the host before they were bound; this method cannot narrow, sort or edit them, and that
	 * is the point of it being this short. The composer does not reach the passport, so anything it could
	 * decide here it would be deciding blind.
	 *
	 * WHAT STOOD HERE was `commandManifest()`, which hard-coded ONE band for ONE tool — the heading, the
	 * calling convention, and the roster's rendering, all in the composer, for a capability that belongs to
	 * `sm_core.command_run`. It reads its own section now, and every other tool may author one too. The
	 * text is unchanged; only its author moved.
	 *
	 * EMPTY IS ABSENT. No bands means no block at all rather than a `# Manifest` band with nothing under it.
	 */
	manifestBands(): string {
		if ( !this.manifestGroups.length ) return '';
		return this.manifestGroups.map( g => `## ${ g.heading }\n\n${ g.body }` ).join( '\n\n' );
	}

	/** The tool IDENTITIES this agent PRELOADS — the set that rides the wire as structured `tools`, distinct
	 *  from the manifest's one-liners.
	 *
	 *  IDENTITIES RATHER THAN BARE NAMES, because everything about a tool is keyed by identity and a resolver
	 *  matching on the bare half would admit a same-named tool belonging to another server — the exact
	 *  collision the group segment exists to make impossible. Read off the DEFS rather than off any map's
	 *  keys, so a setting left behind for a tool no longer served cannot name a tool that is not there. */
	preloadedToolIds(): string[] {
		return _heldIds( this.toolDefs ).filter( t => this.toolSurfaceFor( t.id! ) === 'preload' ).map( t => t.id! );
	}

	/** A plain string wrapped as a synthetic wire-order `TaggedBlock` — root context / tool manifest /
	 *  suggested schemas ride `compiledBlocks()`'s one list this way instead of being hand-concatenated onto
	 *  its text a second time. `section` labels which extra it is ( the budget bucket keys off it ); never
	 *  read by the compiler itself. */
	static extraBlock( section: string, text: string ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** The compiled sections that price as SYSTEM rather than as lens identity — the layers above and around
	 *  the lens rather than the lens itself.
	 *
	 *  `attachments` is PARKED here knowingly. It is not lens identity and not tools, and a fourth bucket is
	 *  probably right — the whole point of the gauge is seeing what context costs what, and folding files
	 *  into "Root context" hides the exact number a user attaches a file to watch. That is a
	 *  `compiledBudget()` signature change plus the inspector band, so it lands with the renderer slice
	 *  rather than being half-done here. `frame` and `mode-line` join for the same reason and carry the same
	 *  reservation. */
	private static readonly SYSTEM_SECTIONS = new Set<string>( [ 'host-prompt', 'system-prompt', 'root-context', 'attachments', 'frame', 'mode-line' ] );
	/** The compiled sections that price as TOOLS — the surface, not the identity that may reach for it. */
	private static readonly TOOL_SECTIONS = new Set<string>( [ 'tool-manifest', 'suggested-tools' ] );
	/** Every section the bottom-of-context manifest emits — the routing tables a reader finds filed together.
	 *
	 *  `files` is deliberately NOT a `MANIFEST_SECTIONS` entry: no lens slots into it, the agent synthesizes
	 *  it from its own lens list. But it is a routing table exactly like the rest, so the breakdown files it
	 *  with them. Reading `MANIFEST_SECTIONS` alone dropped it through to the artifact branch, where a
	 *  synthetic block has no artifact to be named after and reported its source as `unknown`. */
	private static readonly ROUTING_SECTIONS = new Set<string>( [ 'files', ...MANIFEST_SECTIONS ] );

	/** The coarse budget bucket one compiled block groups under — read straight off its `section` tag
	 *  against the two tables above; everything they do not claim — identity, routing, memory, headings,
	 *  dividers — is Lenses. One read of a field the block already carries, no second compilation. */
	static bucketOf( b: TaggedBlock ): 'system' | 'lenses' | 'tools' {
		if ( !b.section ) return 'lenses';
		if ( Agent.SYSTEM_SECTIONS.has( b.section ) ) return 'system';
		if ( Agent.TOOL_SECTIONS.has( b.section ) )   return 'tools';
		return 'lenses';
	}

	/** The human label for a synthetic section — the name a reader sees in the breakdown beside a block
	 *  that has no source artifact to be named after. A section absent from this table labels itself.
	 *
	 *  Read through `labelFor` from OUTSIDE, never copied. What a block is CALLED belongs here beside what
	 *  it is; a view that keeps its own list of the same names is a second answer to one question, and the
	 *  two only ever agree until one of them is edited. */
	private static readonly SECTION_LABELS: Record<string, string> = {
		'host-prompt':     'host prompt',
		'system-prompt':   'agent instruction',
		'root-context':    'root context',
		'attachments':     'attachments',
		'frame':           'caller frame',
		'mode-line':       'shaping line',
		'tool-manifest':   'available tools',
		'suggested-tools': 'suggested tools'
	};

	/** This section's canonical name, or `null` for one that has none — a lens section, a routing table, or
	 *  anything that already names itself off its source artifact. Lowercase, as the wire breakdown wants
	 *  it; a display surface that wants it capitalized or decorated does that to the answer rather than
	 *  keeping a second copy of the question. */
	static labelFor( section: string ): string | null {
		return Agent.SECTION_LABELS[ section ] ?? null;
	}

	/**
	 * Where one compiled block files in the per-source breakdown, or `null` when it is STRUCTURAL — a `---`
	 * divider or a band heading, which has no identity of its own and belongs to the segment it introduces.
	 *
	 * `source` is the reader's FOLDER, deliberately not `bucketOf`'s pricing bucket. Pricing asks what a
	 * block costs against; this asks where a person should find it — and an artifact body wants its own
	 * type either way, so the two questions genuinely have different answers.
	 */
	static segmentKey( b: TaggedBlock ): SegmentKey | null {
		if ( !b.section ) return null;
		if ( Agent.SYSTEM_SECTIONS.has( b.section ) ) return { source: 'system', label: Agent.SECTION_LABELS[ b.section ] ?? b.section };
		if ( b.section === 'memory' )                 return { source: 'memory', label: 'memory' };
		if ( Agent.TOOL_SECTIONS.has( b.section ) )   return { source: 'tools',  label: Agent.SECTION_LABELS[ b.section ] ?? b.section };
		if ( Agent.ROUTING_SECTIONS.has( b.section ) ) return { source: 'index', label: b.section };
		if ( b.region === 'care' )                    return { source: 'lens',   label: b.section };
		return { source: b.artifactType, label: Agent.basename( b.path ) || b.section };
	}

	/** A path's file name without its extension — the human label for an artifact-sourced segment. Plain
	 *  string work rather than the `path` module, so this stays Node-free like the rest of core. */
	private static basename( p: string ): string {
		const tail = p.split( /[\\/]/ ).pop() ?? '';
		return tail.replace( /\.[^.]+$/, '' );
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
	/**
	 * Vault-relative hrefs of habits that LOST their habit-class contest — the rows a manifest must not
	 * advertise.
	 *
	 * `SlotResolver` already drops a losing habit's own blocks, and for a `suggested` habit that is the
	 * whole story. But an `on`-mode habit ( ~90% of them ) emits NO blocks — a routing ROW in its
	 * declaring lens's habits table is its entire contribution, and that table is the LENS's block:
	 * classless, therefore never a contender, therefore surviving the cascade with the loser's row still
	 * inside it. The compiled manifest then advertised two occupants of one mutually-exclusive slot
	 * ( `write-memory-never` beside `write-memory-sparing` ), which is the exact contradiction §6 exists
	 * to prevent, and it failed SILENTLY — nothing errors, the agent simply reads both.
	 *
	 * So the contest is settled here over the node INVENTORY, which knows every habit regardless of mode.
	 * Specificity, most specific first: the agent's own bolted-on habits, then each lens in load order,
	 * then the inheritance floor — which is last by definition, not by accident. `withFloor` appends it,
	 * and a floor a lens cannot correct is not a floor, it is a ceiling. Ties inside one rank keep the
	 * incumbent, so a habit two lenses both declare is one artifact, not a rival of itself.
	 */
	displacedHabitPaths(): Set<string> {
		const norm = ( s: string ): string => s.replace( /\\/g, '/' );
		const root = this.primaryLens ?? this.lenses[ 0 ] ?? null;
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
		// Stable sort: domain lenses keep their load order, the floor sinks to the end.
		const ordered = [ ...this.lenses ].sort( ( a, b ) =>
			Number( InstallManifest.isBaseLens( a.getPath() ) ) - Number( InstallManifest.isBaseLens( b.getPath() ) ) );
		ordered.forEach( ( lens, i ) => { for ( const n of lens.getNodes() ) consider( n, 1 + i ); } );

		const out = new Set<string>();
		for ( const c of all ) if ( best.get( c.cls )!.path !== c.path ) out.add( c.path );
		return out;
	}

	/** Manifest index blocks with the named rows removed — the projection `displacedHabitPaths` feeds.
	 *  Copies rather than mutates: the same blocks are read again by `composition()`, and a compile that
	 *  edited them in place would make the chart depend on whether anyone had compiled first. */
	static withoutRows( index: TaggedBlock[], drop: Set<string> ): TaggedBlock[] {
		if ( !drop.size ) return index;
		const norm = ( s: string ): string => s.replace( /\\/g, '/' );
		return index.map( b => b.rows?.length
			? { ...b, rows: b.rows.filter( r => !drop.has( norm( r.where ?? '' ) ) ) }
			: b );
	}

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
	 *  that section, and wears the canonical heading rather than an ad-hoc one.
	 *
	 *  TAKES ITS ROWS, and a caller that omits them gets a heading and nothing else. That is not a defensive
	 *  note — it is what happened: the grants section passed text alone, the merge read `rows` as it is
	 *  documented to, and the whole table evaporated. `text` is what a lone-block preview renders; `rows` is
	 *  what survives a merge. A manifest section owes BOTH.
	 */
	static sectionBlock( section: string, text: string, rows: SlotRow[] = [] ): TaggedBlock {
		return { region: 'know', section, mergeKey: null, text, rows, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
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

	/** The separator between system-prompt layers — the one place any caller stitching wire-order layers
	 *  agrees on how they join, so no two of them can drift apart. `joinSegments` spells the same boundary
	 *  as a block, which is what lets a hand-joined string and a compiled block list produce identical
	 *  text. */
	static readonly SYSTEM_SEP = '\n\n---\n\n';

	/** The id every `Vault.buildAgent` agent carries — a lens substrate with no authored identity, built to
	 *  compile and then discarded. Reserved and deliberately SHARED across every vault build: it makes "this
	 *  is not an authored agent" legible on the object itself, rather than a fact known only to whoever wrote
	 *  the call site. Never persisted — the database only ever holds authored agents, which is why
	 *  `AgentRow.model` stays concrete while `Agent.model` is nullable. */
	static readonly VAULT_AGENT_ID = 'vault-agent';

	/**
	 * Join system layers in order, dropping empties, with the canonical separator — for a caller stitching
	 * RAW STRINGS rather than blocks.
	 *
	 * The live turn no longer does: its system half is one projection of `compiledContext()`, and the
	 * boundary is a real block ( `joinSegments` ) rather than a separator spliced between strings. What is
	 * left here are the callers that genuinely have no block list to project — a tier that assembles an
	 * identity as text, and `identity()` below.
	 */
	static assembleSystem( parts: ( string | null | undefined )[] ): string {
		return parts.filter( Boolean ).join( Agent.SYSTEM_SEP );
	}

	/**
	 * This agent's frozen IDENTITY — the "who": its `systemPrompt` over its recursive lens contribution.
	 *
	 * The ONE remaining caller that freezes an identity to text instead of letting the agent project it
	 * live, and therefore the one place an agent's context is decided anywhere other than
	 * `compiledContext()`. A run that carries this string carries a snapshot: no bound root context, no
	 * memory, no tool manifest, and no way to reflect anything tuned after the freeze.
	 *
	 * That is a limitation of the caller, not a second design. Anything asking "what does this agent send"
	 * wants `wireSystem()`; anything asking "what did it send, broken out" wants `contextSegments()`.
	 */
	identity(): string {
		return Agent.assembleSystem( [ this.systemPrompt, this.compile() ] );
	}

}
