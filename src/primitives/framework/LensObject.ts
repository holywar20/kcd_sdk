import * as path from 'path';
import { KCDPrimitive, clampDepth, classifyRelPath } from './KCDPrimitive';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens } from '../types';

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
			// `always` gates context auto-loading. Eager mode also follows the
			// conditional links — for display — but marks them not-included below,
			// so the assembled context never widens past the `always` set.
			if ( !entry.always && !this.eager ) continue;

			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );
			if ( visited.has( childAbs ) ) continue;
			visited.add( childAbs );

			let child: KCDPrimitive;
			try {
				const raw = this.read( childAbs );
				child = KCDPrimitive.fromHtml( raw, childAbs );
			} catch {
				continue;
			}

			// Conditional (non-`always`) nodes are available-on-request: present in
			// the graph for inspection, but excluded from the outbound context.
			if ( !entry.always ) child.setIncluded( false );

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

	serializeForContext(): string {
		if ( !this.projectRoot ) throw new Error( 'serializeForContext requires a loaded lens (no projectRoot)' );

		const list        = this.getContributors();
		const loadedPaths = new Set( list.map( n => n.getPath() ) );
		const out         = list.map( n => n.toContextBlock() );

		const stubs = this.policy.filter(
			e => e.type === 'internal' && !loadedPaths.has( LensObject.resolveHref( e.href, this.projectRoot! ) )
		);
		if ( stubs.length ) {
			const rows = stubs.map( e => `| ${e.what} | ${e.href} | ${e.why} |` ).join( '\n' );
			out.push( `# Available on request\n\n| What | Where | Why |\n|---|---|---|\n${rows}` );
		}

		return out.join( '\n\n---\n\n' );
	}

}
