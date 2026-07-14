import { LensObject } from '../primitives/framework/LensObject';
import { SlotResolver } from '../primitives/framework/SlotResolver';
import type { SlotResolution } from '../primitives/framework/SlotResolver';
import { ContextAssembler, MANIFEST_SECTIONS } from '../primitives/framework/ContextAssembler';
import { KcdContext } from '../core/html/KcdContext';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SerializedArtifact, SerializedLens, SlotMode, TaggedBlock } from '../primitives/types';
import { DEFAULT_MODEL_KEY } from './Model';
import type { ToolMode } from './ToolMode';

export type AgentStatus = 'idle' | 'thinking';

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
	/** A ModelDescriptor registry key (see Model.ts). Concrete — defaulted, never null. */
	model: string;
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
	status: AgentStatus;
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
	model?: string;
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
	status?: AgentStatus;
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
	model: string;
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
	status: AgentStatus;
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

	private constructor(
		id: string,
		name: string,
		icon: string | null,
		color: string | null,
		model: string,
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
		status: AgentStatus,
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
		this.status         = status;
		this.folder         = folder;
		this.notes          = notes;
		this.compose();   // materialize composed{X} from the lenses on the way in
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Compose an agent. A lensless draft is legal — running is what demands a lens. */
	static create( opts: AgentOptions = {} ): Agent {
		const lenses = opts.lenses ?? [];
		return new Agent(
			opts.id ?? crypto.randomUUID(),
			opts.name ?? lenses[ 0 ]?.getName() ?? 'agent',
			opts.icon ?? null,
			opts.color ?? null,
			opts.model ?? DEFAULT_MODEL_KEY,
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
			opts.status ?? 'idle',
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
			json.model ?? DEFAULT_MODEL_KEY,
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
			json.status,
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
			status:         this.status,
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

	/** The effective slot mode of one INHERITED lens habit ( keyed by path ): this agent's override if it
	 *  authored one, else the lens's own dredged mode ( `suggested` when the node rides its body, `on`
	 *  otherwise ). The habit sibling of `effectiveToolModes` — the ONE read the compile and the agent
	 *  screen share, so the row's colour ( overridden vs inherited ) and what actually compiles can't drift.
	 *  `null` for a path this agent carries no lens habit for. */
	effectiveHabitMode( path: string ): SlotMode | null {
		const override = this.habitModes[ path ];
		if ( override ) return override;
		const lensNode = this.getNodes().find( n => n.getType() === 'habit' && n.getPath() === path );
		if ( lensNode ) return lensNode.included ? 'suggested' : 'on';
		// an agent's OWN pick has no lens policy to inherit from — its un-overridden default is `suggested`
		// ( full body ), matching `habitOff`'s long-standing binary default ( absent from `habitOff` = on,
		// carrying its full body ) now that `habitModes` can express the third tier for these paths too.
		const ownNode = this.baseHabitNodes.find( n => n.getPath() === path );
		if ( ownNode ) return this.habitOff.includes( path ) ? 'off' : 'suggested';
		return null;
	}

	/** The effective slot mode of one reference ( keyed by path ) — EITHER a lens-inherited reference OR
	 *  one of this agent's own `baseReferences`, the reference sibling of `effectiveHabitMode`. This agent's
	 *  override wins if it authored one; else a lens-inherited reference reads its own dredged mode ( off
	 *  `included`, same convention as `effectiveHabitMode` ); else an own pick falls back to the legacy
	 *  binary `referenceOff` default. `null` for a path this agent carries no reference for at all. */
	effectiveReferenceMode( path: string ): SlotMode | null {
		const override = this.referenceModes[ path ];
		if ( override ) return override;
		const lensNode = this.getNodes().find( n => n.getType() === 'reference' && n.getPath() === path );
		if ( lensNode ) return lensNode.included ? 'suggested' : 'on';
		const ownNode = this.baseReferenceNodes.find( n => n.getPath() === path );
		if ( ownNode ) return this.referenceOff.includes( path ) ? 'off' : 'suggested';
		return null;
	}

	// ── Lens surface ──────────────────────────────────────────────────────────

	/** The primary lens, or null for a draft. */
	get primaryLens(): LensObject | null { return this.lenses[ 0 ] ?? null; }

	/** A draft cannot run: no lens has been composed onto it yet. */
	isDraft(): boolean { return this.lenses.length === 0; }

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
	 * sorted Care-first / injected-last ). A draft ( no lens ) contributes nothing. ( The `systemPrompt`
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
	 * request ) block is dropped — the References table already carries those rows. A draft ( no lens )
	 * compiles to nothing.
	 */
	compile(): string {
		return this.compiledBlocks().map( b => b.text ).join( '\n\n' );
	}

	/**
	 * THE compiled-block currency ( the compiled-context plan, 2026-07-12/13 ) — the flat, merged,
	 * post-resolution `TaggedBlock[]` `compile()` now projects to text. Shape ( band model re-ratified
	 * 2026-07-13 ): the merged body — **Lenses** ( per-lens-named care, `buildLensBand` ) → **Memory**
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
	 * `memory` ( memory-system plan, 2026-07-13 ) — the system-fired PRELOAD baseline ( `Agent.memoryBlock`,
	 * built by the orchestrator from `database.baseline_memories` ). Unlike `before`/`after` it does NOT
	 * bracket the join: it joins the BODY block list and sorts into the `memory` tier ( now BETWEEN the
	 * Lenses band and Knowledge — `ContextAssembler.tierOf` ), because its position is a property of the
	 * merged sort, not a fixed lead/trail slot. Its `## Memory` band heading is spliced by
	 * `withBandHeadings` like any other body tier; while no memory rides ( the reserved-but-empty case ),
	 * `withBandHeadings` emits nothing for the tier, so the wire carries no bare `## Memory`.
	 */
	compiledBlocks( extras: { before?: TaggedBlock[]; after?: TaggedBlock[]; memory?: TaggedBlock[] } = {} ): TaggedBlock[] {
		const before = extras.before ?? [];
		const after  = extras.after ?? [];
		const memory = extras.memory ?? [];
		if ( !this.lenses.length ) return Agent.joinSegments( [ before, memory, after ] );
		const blocks  = [ ...SlotResolver.compilePlan( this.getContextBlocks() ).survivors, ...memory ];
		const inIndex = ( b: TaggedBlock ): boolean => b.section !== null && Agent.INDEX_SECTIONS.has( b.section );
		// The body is everything that ISN'T an index table and isn't the legacy Available-on-request stub.
		const body = blocks.filter( b => !inIndex( b ) && b.section !== 'stub' );

		// The Lenses band ( band model re-ratified 2026-07-13 ): the care-region prose, grouped + NAMED
		// per active lens with `_lens_base`'s care folded into each ( see `buildLensBand` ). Pulled out of
		// the generic assemble so it can carry the per-lens `### {name}` sub-headings the flat merge can't —
		// then handed BACK into the same assemble as ordinary care-tier blocks, so `withBandHeadings` still
		// brackets it with the single `## Lenses` heading and the sort keeps care first.
		const careBlocks = body.filter( b => b.region === 'care' );
		const rest       = body.filter( b => b.region !== 'care' );
		const lensBand   = this.buildLensBand( careBlocks );

		// Band headings ( Lenses / Memory / Knowledge over the body's care/memory/core tiers; Manifest over
		// the manifest ) — real headings on the real wire text, not a view-only re-skin. `withBandHeadings`
		// only fires per NON-EMPTY tier, so an agent with no core content never gets a bare "## Knowledge"
		// heading over nothing, and the reserved `memory` tier emits nothing on the wire while empty.
		const bodyBlocks  = ContextAssembler.withBandHeadings( ContextAssembler.assembleBlocks( [ ...lensBand, ...rest ] ) );
		const rawManifest = this.manifestBlocks( blocks.filter( inIndex ) );
		const manifestBlocks = rawManifest.length
			? [ ContextAssembler.headingBlock( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )! ), ...rawManifest ]
			: [];
		return Agent.joinSegments( [ before, bodyBlocks, manifestBlocks, after ] );
	}

	/**
	 * The per-lens **`## {Name} - Lens`** bands ( compiled-context plan, band model re-ratified 2026-07-13,
	 * refined to attention-grouped output ) — the care-region identity prose, grouped and NAMED per active
	 * lens. Each real lens gets its OWN top-level `## {Name} - Lens` heading ( the primary annotated
	 * `( Primary )` ) — NO "## Lenses" wrapper: the output is grouped by kind, and a lens's personality is a
	 * top-level block, not a child of a Lenses container ( Bryan, 2026-07-13: lens/agent/source are
	 * COMPOSITION artifacts, not output artifacts ). Then its own care blocks, then `_lens_base`'s care
	 * folded in AFTER ( repeated per lens: base is global behavior, "not its own band", so it merges into
	 * each lens rather than standing alone ). Base contributes NO heading of its own.
	 *
	 * Care blocks carry their source lens's `path` ( a lens's own Purpose/Philosophy come from
	 * `super.getContextBlocks()` with `path = this.path` — the same identity `dedupeBySource` keys on ), so
	 * grouping is a plain path match against `this.lenses`. The `## {Name} - Lens` rows are care-tagged
	 * synthetic headings, so they sort into the care tier; `bandHeading( care )` returns null, so
	 * `withBandHeadings` adds no wrapper around them. Base clones drop their `mergeKey` so a shared care
	 * merge key ( rare ) can't fuse the per-lens repeats back into one. A care block matching no active lens
	 * ( e.g. an injected-care node ) rides after the named groups, never silently dropped.
	 */
	buildLensBand( careBlocks: TaggedBlock[] ): TaggedBlock[] {
		const norm   = ( s: string ): string => s.replace( /\\/g, '/' );
		const isBase = ( l: LensObject ): boolean => norm( l.getPath() ?? '' ).endsWith( '_lens_base.html' );
		const bases  = this.lenses.filter( isBase );
		const reals  = this.lenses.filter( l => !isBase( l ) );
		const basePaths = new Set( bases.map( l => norm( l.getPath() ?? '' ) ) );
		const baseCare  = careBlocks.filter( b => basePaths.has( norm( b.path ) ) );

		// Base is global behavior folded into each REAL lens ( repeated per lens, no band of its own ).
		// The degenerate base-only agent ( no real lens to fold into — the SDK's `loadBase` construct )
		// falls back to showing base AS the lens, so its identity prose is never silently dropped; there's
		// nothing to fold in that case, so `foldCare` is empty ( base isn't folded into itself ).
		const groupLenses = reals.length ? reals : bases;
		const foldCare    = reals.length ? baseCare : [];

		const out: TaggedBlock[] = [];
		for ( let i = 0; i < groupLenses.length; i++ ) {
			const lens = groupLenses[ i ];
			const own = careBlocks.filter( b => norm( b.path ) === norm( lens.getPath() ?? '' ) );
			if ( !own.length && !foldCare.length ) continue;
			// The first REAL lens is the primary ( base-only agents have no primary to annotate ).
			const primaryTag = ( reals.length && i === 0 ) ? ' ( Primary )' : '';
			out.push( ContextAssembler.headingBlock( `# ${ lens.getName() } - Lens${ primaryTag }`, 'care' ) );
			out.push( ...own );
			out.push( ...foldCare.map( b => ( { ...b, mergeKey: null } ) ) );
		}
		// Care blocks belonging to no active lens ( shouldn't happen for a lens's own prose, but an
		// injected-care drop could ) ride after the named groups rather than vanishing.
		const allPaths = new Set( this.lenses.map( l => norm( l.getPath() ?? '' ) ) );
		out.push( ...careBlocks.filter( b => !allPaths.has( norm( b.path ) ) ) );
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

	/** The separator between system-prompt layers — the one place the live turn and the Constellation
	 *  commit-bake agree on how the layers join, so they can never drift apart. */
	static readonly SYSTEM_SEP = '\n\n---\n\n';

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
