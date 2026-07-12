import { LensObject } from '../primitives/framework/LensObject';
import { SlotResolver } from '../primitives/framework/SlotResolver';
import type { SlotResolution } from '../primitives/framework/SlotResolver';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SerializedArtifact, SerializedLens, TaggedBlock } from '../primitives/types';
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
	/**
	 * Per-TOOL three-state inclusion, keyed by tool name ( the wire's currency ): `off` ( absent =
	 * off ), `on` ( advertised as a one-liner in the system-prompt manifest, server stays lazy ), or
	 * `suggested` ( full tool surface injected into context ). This is the AUTHORED tool composition —
	 * the renderer's per-tool control writes it; the turn assembly reads it to split the manifest from
	 * the injected surface. Distinct from `baseTools` ( the dumb inventory ), which stays untouched. */
	toolModes: Record<string, ToolMode>;
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

	/**
	 * The agent's OWN base habits as LOADED objects ( the `agent` source layer at composition ). Disk is
	 * a main capability, so main materializes these from `baseHabits` ( the paths ) and they ride the wire
	 * for the renderer's structured view. Never persisted to the DB ( `baseHabits` is ) — rebuilt from the
	 * paths on every load/save so it can't go stale. Empty until materialized ( a draft, or a bare wire ). */
	baseHabitNodes: KCDPrimitive[] = [];

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
			json.fields ?? [],
			json.system ?? {},
			json.createdAt,
			json.status,
			json.folder,
			json.notes ?? null,
		);
		// The materialized base habits ride the wire ( the renderer can't dredge disk ). Main re-materializes
		// from the paths on every load/save, so an absent field just means "not materialized yet", never a loss.
		agent.baseHabitNodes = ( json.baseHabitNodes ?? [] ).map( ( n ) => KCDPrimitive.fromSerialized( n ) );
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
			fields:         this.fields.map( ( f ) => ( { ...f } ) ),
			system:         { ...this.system },
			createdAt:      this.createdAt,
			status:         this.status,
			folder:         this.folder,
			notes:          this.notes,
			baseHabitNodes: this.baseHabitNodes.map( ( n ) => n.serialize() ),
		};
	}

	// ── Composition (flush-and-fill; trust the children) ──────────────────────

	/**
	 * Rebuild every `composed{X}` from the current lenses — wholesale, no deltas. Ask each lens
	 * for its Know graph and sort the contributed paths by artifact type. Cheap (in-memory; the
	 * expensive dredge already happened when the lens was loaded), so call it freely: at
	 * construction, and whenever a base string or a lens changes.
	 *
	 * `composedTools` stays empty for now — lenses don't expose a tool/plugin contribution yet;
	 * that lands when the per-category resolver seam is wired (the strings-to-objects step).
	 */
	compose(): void {
		const nodes = this.lenses.flatMap( ( l ) => l.getNodes() );
		this.composedReferences = _pathsOfType( nodes, 'reference' );
		this.composedPlans      = _pathsOfType( nodes, 'plan' );
		this.composedHabits     = _pathsOfType( nodes, 'habit' );
		this.composedTools      = [];
	}

	/** What this agent actually carries = bolted-on ∪ inherited-from-lenses. The permissions
	 *  gate reads `effectiveTools`; the composer reads each pair to show base (editable here)
	 *  vs composed (edit at the lens). */
	effectiveTools():      string[] { return _union( this.baseTools,      this.composedTools ); }
	effectiveHabits():     string[] { return _union( this.baseHabits,     this.composedHabits ); }
	effectiveReferences(): string[] { return _union( this.baseReferences, this.composedReferences ); }
	effectivePlans():      string[] { return _union( this.basePlans,      this.composedPlans ); }

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
		const lensBlocks  = this.lenses.flatMap( lens => lens.getContextBlocks() );
		const habitBlocks = this.baseHabitNodes.flatMap( node =>
			node.getContextBlocks().map( b => ( { ...b, sourceLayer: 'agent' as const } ) )
		);
		return Agent.dedupeBySource( [ ...lensBlocks, ...habitBlocks ] );
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
		return Agent.assembleSystem( [ this.systemPrompt, this.contribute() ] );
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
