import * as path from 'path';
import { KCDPrimitive, clampDepth, classifyRelPath } from './KCDPrimitive';
import { SlotResolver } from './SlotResolver';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens, SlotMode, TaggedBlock } from '../types';

const LENS_DEFAULT_DEPTH = 2;

/** The default disk reader — a stub that throws. Core never touches `fs`; the main side injects
 *  a real reader at load(). On the renderer this stays the stub, because render never dredges —
 *  it receives finished graphs. Reaching for it there is a bug, and it says so. */
const DISK_IS_MAIN_ONLY: ReaderFn = ( absPath ) => {
	throw new Error( `LensObject.read: disk read is a main-process capability (path: ${ absPath })` );
};

export interface LensLoadOptions {
	/** Required — core can't infer it (inferProjectRoot is node-side). Main passes its root. */
	projectRoot: string;
	depth?: number;
	/**
	 * Eager dredge: follow ALL internal Know links, not only the `always` ones.
	 * This is the DISPLAY axis, orthogonal to `depth` (the recursion axis). The
	 * extra (non-`always`) nodes enter the graph marked `setIncluded(false)`, so
	 * they are inspectable but do NOT contribute to the assembled context —
	 * `always` stays the auto-load gate, this only widens what the graph SHOWS.
	 * Default false preserves context-assembly behavior (only `always` is loaded).
	 */
	eager?: boolean;
	/** The injected disk reader. Main supplies fsReader; render never calls load(), so never sets it. */
	read: ReaderFn;
}

/**
 * A lens is the spine: it owns its projectRoot, reads files (via an injected `read`
 * strategy — main attaches fs, the renderer never dredges), orchestrates its own dredge,
 * and assembles the loaded nodes into an AI context blob. Ask a lens — instantiate with
 * a path and it does the rest.
 *
 * Path resolution utilities live here as static methods because LensObject is the
 * only current consumer. If a second class needs them, move them then — not before.
 */
export class LensObject extends KCDPrimitive {

	// ── Path resolution utilities ─────────────────────────────────────────────

	static readonly DEFAULT_DOC_ROOT = '_Claude';

	// inferProjectRoot moved node-side (it needs fs) → @kcd/node `inferProjectRoot`.

	static resolveHref( href: string, projectRoot: string ): string {
		return path.resolve( projectRoot, href );
	}

	/** Absolute path → ArtifactType. A thin wrapper: relativize, then the one shared taxonomy. */
	static classifyByPath( absPath: string, projectRoot: string, docRoot = LensObject.DEFAULT_DOC_ROOT ): ArtifactType {
		return classifyRelPath( path.relative( projectRoot, absPath ), docRoot );
	}

	// ── Spine state ───────────────────────────────────────────────────────────

	protected policy: PolicyEntry[] = [];
	protected nodes: KCDPrimitive[] = [];
	/** Dynamically injected Know nodes — dropped onto the agent at session time (the
	 *  GUI equivalent of pasting context into a chat window). NOT dredged from the lens
	 *  markdown; kept apart from `nodes` so a re-dredge never clobbers them and so they
	 *  serialize distinctly (they ride the wire but never reach disk). They contribute
	 *  as always-loaded Know — see getNodes / addInjected. */
	protected injected: KCDPrimitive[] = [];
	/** Per-tool three-state inclusion the lens CONTRIBUTES ( tool name → mode ), parsed from the lens's
	 *  Tools table. Unlike references/habits a tool is not a dredged node, so it lives here, not in `nodes`.
	 *  The composition baseline an agent's own `toolModes` overrides per-tool ( Agent.effectiveToolModes ). */
	protected toolModes: Record<string, SlotMode> = {};
	protected projectRoot?: string;
	protected dredgeDepth = LENS_DEFAULT_DEPTH;
	/** When set, the dredge follows conditional (non-`always`) links too, marking
	 *  them not-included. See LensLoadOptions.eager — the display-vs-context axis. */
	protected eager = false;
	/** Injected disk capability (Strategy). Default throws — main attaches a real reader at load(). */
	protected read: ReaderFn = DISK_IS_MAIN_ONLY;

	protected constructor( filePath: string ) {
		super( filePath, 'lens' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static load( lensPath: string, opts: LensLoadOptions ): LensObject {
		const abs = path.resolve( lensPath );
		const raw = opts.read( abs );

		// HTML is the substrate: the lens hydrates through the validate-first parser ( a malformed
		// document throws here, all-or-nothing ). fromHtml yields the right prototype via the
		// hydrator table, so this is a LensObject with its policy already carried from the parse.
		const lens = KCDPrimitive.fromHtml( raw, abs ) as LensObject;

		lens.projectRoot = opts.projectRoot;
		lens.read        = opts.read;
		lens.eager       = opts.eager ?? false;

		const depth = clampDepth( opts.depth ?? lens.dredgeDepth );
		// dredgeFrom returns [ self, ...descendants ]; nodes holds the children only.
		lens.nodes  = lens.dredgeFrom( lens, depth, new Set( [abs] ) ).slice( 1 );
		return lens;
	}

	/**
	 * Rebuild a lens from wire JSON — and recurse: each dredged child is hydrated through its
	 * OWN registered fromSerialized, so a habit comes back a HabitObject. `nodes` is absent on a
	 * shallow (non-dredged) serialization; an empty graph is the honest result there.
	 */
	static fromSerialized( json: SerializedArtifact ): LensObject {
		const obj = new LensObject( json.path );
		obj.hydrateFrom( json );
		// Policy is computed once by the parser ( the HTML front end owns it ) and rides the wire.
		// A lens whose sections hold inner HTML has no re-parseable table to fall back to.
		obj.policy     = json.policy ?? [];
		const children = ( json as SerializedLens ).nodes ?? [];
		obj.nodes      = children.map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		const injected = ( json as SerializedLens ).injected ?? [];
		obj.injected   = injected.map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		// Tool modes arrive from BOTH doors through this one: the parse ( ParsedArtifact.toolModes, computed
		// from the Tools table ) and the wire ( serializeForWire below ). A lens with no Tools table carries {}.
		obj.toolModes  = { ...( json as SerializedLens ).toolModes ?? {} };
		return obj;
	}

	/** Carry policy on the wire. The receiver prefers it over re-deriving — load-bearing for an
	 *  HTML lens, whose sections hold inner HTML, not a re-parseable markdown dredge table. */
	serialize(): SerializedArtifact {
		return { ...super.serialize(), policy: [ ...this.policy ] };
	}

	/** The wire form for crossing the bridge: this lens plus its dredged children and any
	 *  injected nodes (each serialized, children only — the lens isn't its own child). The
	 *  receiver rebuilds via fromSerialized. */
	serializeForWire(): SerializedLens {
		return {
			...this.serialize(),
			nodes:     this.nodes.map( ( n ) => n.serialize() ),
			injected:  this.injected.map( ( n ) => n.serialize() ),
			toolModes: { ...this.toolModes },
		};
	}

	// ── Dredge orchestration ──────────────────────────────────────────────────

	private dredgeFrom( node: KCDPrimitive, remaining: number, visited: Set<string> ): KCDPrimitive[] {
		const out: KCDPrimitive[] = [node];
		if ( remaining <= 1 ) return out;

		for ( const entry of node.getPolicy() ) {
			if ( entry.type !== 'internal' ) continue;
			// Dredge follows a slot's MODE ( Bryan, 2026-07-12, corrected 2026-07-12 — the first pass made
			// EVERY fetched child not-included, which silently stripped `suggested` of its whole meaning:
			// toggling a lens reference On↔Suggested changed the UI but never the compiled context ). `off`
			// drops the slot entirely; `on` still fetches ( eager display needs the object either way — the
			// Atlas graph, the reader drawer — but is marked not-included below, so it rides only as the
			// routing ROW `Agent.compile`'s manifest already carries ); `suggested` is marked INCLUDED, so its
			// full text joins `dredged` in `getContextBlocks()` below — the one case where a slot's body
			// actually rides the wire. Plans are the sole exception that outlives mode entirely ( see the
			// carve-out a few lines down ).
			if ( entry.mode === 'off' ) continue;
			if ( !this.eager ) continue;

			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );

			// Plans are LINK-ONLY in assembled context ( Bryan, 2026-07-12 ): a plan is an informational,
			// volatile working doc — not standing identity or reference prose — so its body must never ride
			// the wire automatically. No matter what mode a slot marks it ( short of `off`, already skipped
			// above, and `on`, which never fetches anyway ), a plan is NEVER dredged into `nodes`. Its
			// reference SURVIVES as a routing row instead: a plan slot on the lens itself renders through
			// `stubBlock`; a plan reached via some reference's own slot rides as a row inside that reference's
			// routing table. This is the one deliberate type carve-out that outlives the general slot-mode
			// ruling — it's the plan's volatility, not its role, that keeps its full text out of context.
			if ( LensObject.classifyByPath( childAbs, this.projectRoot! ) === 'plan' ) continue;

			if ( visited.has( childAbs ) ) continue;
			visited.add( childAbs );

			let child: KCDPrimitive;
			try {
				const raw = this.read( childAbs );
				child = KCDPrimitive.fromHtml( raw, childAbs );
			} catch {
				continue;
			}

			// `suggested` rides full-body; `on` fetches for display ( the Atlas graph, the reader drawer )
			// but is excluded from `getContextBlocks()` — the routing row is its whole contribution.
			child.setIncluded( entry.mode === 'suggested' );

			out.push( ...this.dredgeFrom( child, remaining - 1, visited ) );
		}

		return out;
	}

	// ── Policy ────────────────────────────────────────────────────────────────
	// The dredge policy is computed by the parser ( know-region slots, the `always` gate ) and
	// rides the wire; the lens just exposes it. The markdown Know-table parse is gone.

	getPolicy(): PolicyEntry[]  { return [ ...this.policy ]; }

	/** The vault root this lens was loaded against — the base every loaded file's path is relativized to
	 *  for the compiled manifest. Undefined on a wire-hydrated lens ( render never dredges ). */
	getProjectRoot(): string | undefined { return this.projectRoot; }

	/** An absolute path in vault-relative, forward-slashed form — the file's ID in the compiled manifest
	 *  ( Bryan, 2026-07-12: vault-relative paths, no project-resolution magic yet ). Passthrough when no
	 *  projectRoot is known. */
	vaultRelative( abs: string ): string {
		return this.projectRoot ? path.relative( this.projectRoot, abs ).replace( /\\/g, '/' ) : abs;
	}

	/** The full Know graph: dredged children plus any session-injected nodes. The single
	 *  percolation point — the spiral, the count, Composition, and contribute() all read
	 *  through here, so injected context appears everywhere with no per-consumer wiring. */
	getNodes(): KCDPrimitive[]  { return [ ...this.nodes, ...this.injected ]; }

	/** The context contributors in order: the lens itself, then every node (dredged + injected). */
	getContributors(): KCDPrimitive[] { return [ this, ...this.getNodes() ]; }

	/**
	 * Inject a Know node at session time — the GUI "drop context onto the agent" hook
	 * (equivalent to pasting context into a chat window). The node joins the Know graph
	 * as always-loaded context: it shows in the spiral/count and rides contribute(). Not
	 * dredged, not written to disk — it lives only on the live object and its wire form.
	 * Forces included on; a dropped item is an intent to load.
	 */
	addInjected( node: KCDPrimitive ): void {
		node.setIncluded( true );
		this.injected.push( node );
	}

	/** The per-tool modes this lens contributes ( tool name → mode ) — the composition baseline the agent
	 *  layers its own `toolModes` over. A tool is not a node, so this is its own read, not `getNodes()`. */
	getToolModes(): Record<string, SlotMode> { return { ...this.toolModes }; }

	getRole(): KCDRole { return 'lens'; }

	// ── Context assembly ──────────────────────────────────────────────────────

	/**
	 * This lens's full region-block set ( context-optimization plan, Phase 2 ) — its own Know/Care/Do
	 * content, then each dredged node's blocks, then the "Available on request" stub (if any), then
	 * each INJECTED node's blocks retagged `sourceLayer: 'injected'`. `ContextAssembler` does the
	 * actual Care-hoist / injected-sink sort; this method only needs to get injected blocks tagged
	 * correctly, since `getNodes()`'s simple append-order is no longer what guarantees "injected
	 * last" once multiple lenses are in play.
	 */
	/**
	 * A lens's region-block set for the compiled context. The MODEL ( ruling corrected, Bryan 2026-07-12,
	 * superseding the overzealous "links-only for `suggested`" framing ): a slot's mode is a
	 * suggestion surface, NOT a fetch policy — `off` excludes; `on` is the DECK POINTER ( a routing ROW
	 * only, ~90% of habits live here ); `suggested` is an IMPLICIT INJECTION — the target's body rides,
	 * a deliberate "this one matters" highlight the user operates. A session-INJECTED node is the same
	 * force by another door ( retagged `injected` ). A habit body that rides projects to the dense
	 * four-field form ( `KcdContext.projectHabit` ), never a raw file dump. Routing rows render from this
	 * lens's own section ( `references` / `habits` / `contracts` ) and hoist into the bottom-of-context
	 * manifest ( `Agent.compile` ); the agent reads a deck file by its manifest path on demand.
	 *
	 * ⚠ The `dredgeFrom` mechanism BELOW is mid-rework and does NOT yet cleanly realize this model for
	 * every mode ( it half-fetches, half-links ). Dredge is being redesigned around this behavior and is
	 * NOT canonical for habits — do not treat the current fetch/links split as the intended contract.
	 */
	getContextBlocks(): TaggedBlock[] {
		if ( !this.isIncluded ) return [];
		const own      = super.getContextBlocks();
		const dredged  = this.nodes.flatMap( n => n.getContextBlocks() );
		const injected = this.injected
			.flatMap( n => n.getContextBlocks() )
			.map( b => ( { ...b, sourceLayer: 'injected' as const } ) );
		const stub = this.stubBlock();
		return [ ...own, ...dredged, ...( stub ? [ stub ] : [] ), ...injected ];
	}

	/** The "Available on request" stub — every `on`-mode internal link this lens's policy names (the
	 *  routing-row case, any artifact type), plus any `suggested` link the current dredge depth
	 *  didn't reach. One synthetic block, folded into `getContextBlocks()` so the unified assembler
	 *  sees it like any other contribution instead of `serializeForContext()` special-casing it.
	 *  `off`-mode links never appear here — the user excluded them entirely, not just deferred them.
	 *  Silently omitted (not thrown) with no projectRoot — a display nicety, not something that
	 *  should crash a context call from an unloaded lens.
	 *
	 *  Dedupe is against CONTRIBUTING paths ( `.included`, i.e. `suggested` content already rendered
	 *  full-body elsewhere ), not merely FETCHED paths — Bryan, 2026-07-13: an `on`-mode habit is
	 *  fetched too ( `dredgeFrom` needs its `habit-class` regardless of mode ) but contributes nothing
	 *  to `getContextBlocks()` while excluded; the old "already loaded ⇒ skip" filter caught that
	 *  fetch-for-metadata case and silently dropped the row it was the ONLY source for. */
	stubBlock(): TaggedBlock | null {
		if ( !this.projectRoot ) return null;
		const included = new Set( this.getContributors().filter( n => n.included ).map( n => n.getPath() ) );
		const byPath   = new Map( this.nodes.map( n => [ n.getPath(), n ] as const ) );
		const stubs = this.policy.filter(
			e => e.type === 'internal' && e.mode !== 'off' && !included.has( LensObject.resolveHref( e.href, this.projectRoot! ) )
		);
		if ( !stubs.length ) return null;
		const rows = stubs.map( e => {
			const why = LensObject.resolveWhy( e, byPath.get( LensObject.resolveHref( e.href, this.projectRoot! ) ) );
			return `- ${ e.what } — ${ why } (${ e.href })`;
		} ).join( '\n' );
		// section 'stub' tags this as the legacy Available-on-request block so `Agent.compile()` can drop it —
		// the manifest's References table already lists every reference slot ( on-mode included ), so the stub
		// is redundant there ( Bryan, 2026-07-12: exists once, shave tokens ). The old contribute() path still
		// renders it.
		return { region: 'know', section: 'stub', mergeKey: null, text: `# Available on request\n\n${ rows }`, sourceLayer: 'lens', path: this.path, artifactType: 'lens', habitClass: null };
	}

	/** The reason text a routing/stub row shows. The Care-table Why cell is now a tri-state: real
	 *  hand-written prose is an override and rides as-is; `always`, `habit`, or an empty cell are all
	 *  "no override" sentinels — Bryan, 2026-07-13 — that DEFER to the target's own declared `why`
	 *  ( `habit` is the authoring default, so most rows never restate a reason at all ). Duck-typed
	 *  ( `getWhy` ) rather than importing `HabitObject` here — only habits carry this field today, and
	 *  the check degrades safely for any other artifact type or an unfetched target. */
	private static resolveWhy( entry: PolicyEntry, node: KCDPrimitive | undefined ): string {
		const cell = entry.why.trim().toLowerCase();
		const isSentinel = cell === '' || cell === 'habit' || cell === 'always';
		if ( !isSentinel ) return entry.why;
		const getWhy = ( node as unknown as { getWhy?: () => string } | undefined )?.getWhy;
		const why = typeof getWhy === 'function' ? getWhy.call( node ) : '';
		return why || entry.why;
	}

	serializeForContext(): string {
		if ( !this.projectRoot ) throw new Error( 'serializeForContext requires a loaded lens (no projectRoot)' );
		return SlotResolver.compile( this.getContextBlocks() );
	}

}
