import { LensObject } from '../primitives/framework/LensObject';
import type { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ArtifactType, ContextSegment, PolicyEntry, SerializedLens } from '../primitives/types';
import { DEFAULT_MODEL_KEY } from './Model';

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
		return new Agent(
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
			json.fields ?? [],
			json.system ?? {},
			json.createdAt,
			json.status,
			json.folder,
			json.notes ?? null,
		);
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
			fields:         this.fields.map( ( f ) => ( { ...f } ) ),
			system:         { ...this.system },
			createdAt:      this.createdAt,
			status:         this.status,
			folder:         this.folder,
			notes:          this.notes,
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
	 * The recursive context query — Σ over lenses of (the lens block + each of its nodes'
	 * contributions). A draft contributes nothing. (The `systemPrompt` lever rides the wire
	 * but is not yet prepended here — that concatenation lands with deploy-time assembly; and
	 * the `base*` strings join the blob once the resolver seam turns them into objects.)
	 */
	contribute(): string {
		if ( !this.lenses.length ) return '';
		const parts: string[] = [];
		for ( const lens of this.lenses ) {
			parts.push( lens.toContextBlock() );
			for ( const node of lens.getNodes() ) {
				const block = node.contribute();
				if ( block ) parts.push( block );
			}
		}
		return parts.join( Agent.SYSTEM_SEP );
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
	 * The agent's identity BROKEN OUT by source — the structured twin of `identity()`. Same content, same
	 * order (systemPrompt, then per lens its header block + each contributing node), just kept as labelled
	 * segments instead of one joined string, so the telemetry/transcript can show what each context source
	 * contributed. Joining the segment texts with the canonical separator reproduces `identity()` exactly,
	 * so the structured and flat forms can't drift. Token counts are filled at run time (null here — the
	 * tokenizer lives main-side, on the connector).
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
