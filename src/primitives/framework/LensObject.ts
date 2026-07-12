import * as path from 'path';
import { KCDPrimitive, clampDepth, classifyRelPath } from './KCDPrimitive';
import { SlotResolver } from './SlotResolver';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens, TaggedBlock } from '../types';

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
			nodes:    this.nodes.map( ( n ) => n.serialize() ),
			injected: this.injected.map( ( n ) => n.serialize() ),
		};
	}

	// ── Dredge orchestration ──────────────────────────────────────────────────

	private dredgeFrom( node: KCDPrimitive, remaining: number, visited: Set<string> ): KCDPrimitive[] {
		const out: KCDPrimitive[] = [node];
		if ( remaining <= 1 ) return out;

		for ( const entry of node.getPolicy() ) {
			if ( entry.type !== 'internal' ) continue;
			// `mode` gates context auto-loading — the one idiom for every artifact kind (reference,
			// habit, contract, anything routable). `off` never dredges, full stop, even in eager
			// display mode: the user turned it off. `on` (the default) skips the fetch entirely in
			// normal assembly — cheap, it only ever needs to render as a routing row from `policy`
			// (see stubBlock) — but eager mode still follows it FOR DISPLAY, marking it not-included
			// below so the assembled context never widens past the `suggested` set.
			if ( entry.mode === 'off' ) continue;
			if ( entry.mode === 'on' && !this.eager ) continue;

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

			// Only `suggested` rides full text; `on` nodes reached here are eager-display-only.
			if ( entry.mode !== 'suggested' ) child.setIncluded( false );

			out.push( ...this.dredgeFrom( child, remaining - 1, visited ) );
		}

		return out;
	}

	// ── Policy ────────────────────────────────────────────────────────────────
	// The dredge policy is computed by the parser ( know-region slots, the `always` gate ) and
	// rides the wire; the lens just exposes it. The markdown Know-table parse is gone.

	getPolicy(): PolicyEntry[]  { return [ ...this.policy ]; }

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
	 * The general `contract`/`habit` type carve-out is retired ( 2026-07-12 — see the mode ruling in
	 * `_Claude/plans/context-optimization.html` ): the SAME `data-kcd-mode` idiom every artifact uses
	 * does that job structurally now. `dredgeFrom` only ever fetches-and-includes a node when its slot's
	 * mode is `suggested` ( `on`-mode targets are never fetched into `nodes` at all in normal, non-eager
	 * assembly — they render as a routing row straight from `policy`, see `stubBlock` ). So `this.nodes`
	 * can only ever contain `suggested` targets by construction, and no downstream filter is needed to keep
	 * a habit's or a contract's full body off the wire by default — a lens author who sets
	 * `data-kcd-mode="suggested"` on such a slot gets full text, because they asked for it.
	 *
	 * PLANS are the ONE surviving type exception ( Bryan, 2026-07-12 ): `dredgeFrom` refuses to fetch a
	 * plan into `nodes` no matter its slot mode, so a plan can never reach `this.nodes` and its full body
	 * never rides context. A plan is always a link — its routing row survives ( `stubBlock`, or the
	 * referencing artifact's own routing table ); only its body is suppressed. See `dredgeFrom`.
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
	 *  should crash a context call from an unloaded lens. */
	stubBlock(): TaggedBlock | null {
		if ( !this.projectRoot ) return null;
		const loadedPaths = new Set( this.getContributors().map( n => n.getPath() ) );
		const stubs = this.policy.filter(
			e => e.type === 'internal' && e.mode !== 'off' && !loadedPaths.has( LensObject.resolveHref( e.href, this.projectRoot! ) )
		);
		if ( !stubs.length ) return null;
		const rows = stubs.map( e => `- ${ e.what } — ${ e.why } (${ e.href })` ).join( '\n' );
		return { region: 'know', section: null, mergeKey: null, text: `# Available on request\n\n${ rows }`, sourceLayer: 'lens', path: this.path, artifactType: 'lens', habitClass: null };
	}

	serializeForContext(): string {
		if ( !this.projectRoot ) throw new Error( 'serializeForContext requires a loaded lens (no projectRoot)' );
		return SlotResolver.compile( this.getContextBlocks() );
	}

}
