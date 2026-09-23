import { PathText } from '../../core/PathText';
import { KCDPrimitive, clampDepth, classifyRelPath } from './KCDPrimitive';
import { PendingRead } from './PendingRead';
import { VaultLayout } from '../../core/VaultLayout';
import { SlotResolver } from './SlotResolver';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens, SlotMode, TaggedBlock } from '../types';

const LENS_DEFAULT_DEPTH = 2;

/** The default disk reader — a stub that throws. Core never touches `fs`: main injects a disk reader at
 *  `load()`, and a receiver that reads on access hands its own reader to `lazy` or `setReader`. Reaching
 *  this one is a bug, and it says so. */
const DISK_IS_MAIN_ONLY: ReaderFn = ( absPath ) => {
	throw new Error( `LensObject.read: disk read is a main-process capability (path: ${ absPath })` );
};

export interface LensLoadOptions {
	/** Required — core can't infer it (inferProjectRoot is node-side). Main passes its root. */
	projectRoot: string;
	/**
	 * Which folder the vault is. Needed for one thing and it is not cosmetic: classifying a dredged
	 * child as a PLAN, which is what keeps plan bodies out of compiled context ( see the carve-out in
	 * `dredgeFrom` ). Without it the classifier falls back to `_Claude` and every child of a vault
	 * named anything else classifies as `unknown` — so the carve-out silently stops firing and full
	 * plan text rides into every compile. Optional because the default is right for most vaults and a
	 * required field here would break every caller for a value most of them already have correct.
	 */
	docRoot?: string;
	depth?: number;
	/**
	 * Dredge the children at all, or not. Named for a display axis, but wired as the gate on the WHOLE
	 * dredge: `false` skips every child, including the `load` ones whose bodies ride the compiled
	 * context. A non-eager lens is its own prose plus routing rows — no habit bodies, no habit-class
	 * contention to resolve, no child artifact types to read.
	 *
	 * Anything that COMPILES must pass `true`, or the two faces compile different objects from one lens.
	 * The false default is for callers wanting a lens's own prose without touching disk for its children.
	 */
	eager?: boolean;
	/** For a lens that reads on access: read EVERY child, rather than stubbing the ones its compile does not
	 *  use. A surface that shows each child's own cost — a lens card — wants their bodies; an agent does not. */
	readAll?: boolean;
	/** The injected reader. Main supplies fsReader; the renderer supplies one that fetches through its cache. */
	read: ReaderFn;
}

/**
 * A lens is the spine: it owns its projectRoot, reads files (via an injected `read`
 * strategy — main attaches fs, the renderer a reader over its cache), orchestrates its own dredge,
 * and assembles the loaded nodes into an AI context blob. Ask a lens — instantiate with
 * a path and it does the rest.
 *
 * Path resolution utilities live here as static methods because LensObject is the
 * only current consumer. If a second class needs them, move them then — not before.
 */
export class LensObject extends KCDPrimitive {

	// ── Path resolution utilities ─────────────────────────────────────────────

	/** Re-exported from the taxonomy that owns it — NOT a second literal. A default restated in two
	 *  places is two defaults that can disagree, which is how `DEFAULT_MODEL_KEY` drifted before. */
	static readonly DEFAULT_DOC_ROOT = VaultLayout.DEFAULT_DOC_ROOT;

	// inferProjectRoot moved node-side (it needs fs) → @kcd/node `inferProjectRoot`.

	static resolveHref( href: string, projectRoot: string ): string {
		return PathText.resolve( projectRoot, href );
	}

	/** Absolute path → ArtifactType. A thin wrapper: relativize, then the one shared taxonomy. */
	static classifyByPath( absPath: string, projectRoot: string, docRoot = LensObject.DEFAULT_DOC_ROOT ): ArtifactType {
		return classifyRelPath( PathText.relative( projectRoot, absPath ), docRoot );
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
	/** Per-tool three-state inclusion parsed from the lens's Tools table ( `group.tool` → mode ). Unlike
	 *  references/habits a tool is not a dredged node, so it lives here, not in `nodes`. Read through
	 *  `getToolModes` — see there for why nothing downstream composes it onto an agent any more. */
	protected toolModes: Record<string, SlotMode> = {};
	protected projectRoot?: string;
	/** This vault's folder name — see LensLoadOptions.docRoot. Undefined falls back to the default. */
	protected docRoot?: string;
	protected dredgeDepth = LENS_DEFAULT_DEPTH;
	/** When set, the dredge follows conditional (non-`always`) links too, marking
	 *  them not-included. See LensLoadOptions.eager — the display-vs-context axis. */
	protected eager = false;
	/** See LensLoadOptions.readAll. Meaningful only for a lens that reads on access. */
	protected readAll = false;
	/** Injected disk capability (Strategy). Default throws — main attaches a real reader at load(). */
	protected read: ReaderFn = DISK_IS_MAIN_ONLY;
	/** Set on a lens that reads on access ( `LensObject.lazy` ): its own document and its children are read
	 *  through `read` the first time something asks, and `pending` names what the reader could not supply yet.
	 *  Null on a lens loaded whole, which never reads again. */
	private onAccess: { loaded: boolean; dredged: boolean; pending: string[] } | null = null;
	/** The children a lens that reads on access has already read, by path — so a pass made while other reads
	 *  are still outstanding parses nothing twice. Cleared when it is told to read again. */
	private readNodes = new Map<string, KCDPrimitive>();

	protected constructor( filePath: string ) {
		super( filePath, 'lens' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static load( lensPath: string, opts: LensLoadOptions ): LensObject {
		// An absolute lensPath stands as given; a relative one resolves against the project root, since core
		// has no working directory to offer and a lens path was never relative to one.
		const abs = PathText.resolve( opts.projectRoot, lensPath );
		const raw = opts.read( abs );

		// HTML is the substrate: the lens hydrates through the validate-first parser ( a malformed
		// document throws here, all-or-nothing ). fromHtml yields the right prototype via the
		// hydrator table, so this is a LensObject with its policy already carried from the parse.
		const lens = KCDPrimitive.fromHtml( raw, abs, opts.docRoot ?? LensObject.DEFAULT_DOC_ROOT ) as LensObject;

		lens.projectRoot = opts.projectRoot;
		lens.docRoot     = opts.docRoot;
		lens.read        = opts.read;
		lens.eager       = opts.eager ?? false;

		const depth = clampDepth( opts.depth ?? lens.dredgeDepth );
		// dredgeFrom returns [ self, ...descendants ]; nodes holds the children only.
		lens.nodes  = lens.dredgeFrom( lens, depth, new Set( [abs] ) ).slice( 1 );
		return lens;
	}

	/**
	 * A lens that reads on access: nothing is read now. Its own document is read the first time anything asks for
	 * its content, and its children the first time anything asks for its nodes — each through `opts.read`, which
	 * may answer "not yet" by throwing `PendingRead`. Until every read has landed, `pending()` names what is
	 * outstanding and the lens answers with what it has; ask again and it reads again. Once nothing is pending it
	 * compiles exactly as a lens from `load` does.
	 */
	static lazy( lensPath: string, opts: LensLoadOptions ): LensObject {
		const lens = new LensObject( PathText.resolve( opts.projectRoot, lensPath ) );
		lens.projectRoot = opts.projectRoot;
		lens.docRoot     = opts.docRoot;
		lens.read        = opts.read;
		lens.eager       = opts.eager ?? false;
		lens.readAll     = opts.readAll ?? false;
		lens.onAccess    = { loaded: false, dredged: false, pending: [] };
		return lens;
	}

	/** The paths a lens that reads on access is still waiting on — empty once everything it needs has landed,
	 *  and always empty for a lens loaded whole. Asking reads: it is how a caller finds out. */
	pending(): string[] {
		this.ensureDredged();
		return this.onAccess ? [ ...this.onAccess.pending ] : [];
	}

	/** Read again on next access, because a document this lens depends on changed. A no-op for a lens loaded
	 *  whole, which re-loads rather than re-reads. */
	invalidate(): void {
		if ( !this.onAccess ) return;
		this.onAccess = { loaded: false, dredged: false, pending: [] };
		this.readNodes.clear();
	}

	/** Hand a lens that reads on access the reader to read through — the receiving side's own disk capability.
	 *  The same reader again is a no-op; a different one reads again from the start. */
	setReader( read: ReaderFn ): void {
		if ( !this.onAccess || this.read === read ) return;
		this.read = read;
		this.invalidate();
	}

	/** This lens as its RECORD: what a receiver needs to read it on access, and none of its content — no body, no
	 *  sections, no nodes. The wire form for a receiver that compiles for itself. */
	serializeRecord(): SerializedLens {
		return {
			path: this.path, type: 'lens', frontmatter: {}, sections: {}, body: '', links: [], included: this.isIncluded,
			nodes: [], lazy: true, projectRoot: this.projectRoot, docRoot: this.docRoot
		};
	}

	/** Until it is handed a reader, a lens rebuilt from its record answers "not yet" for everything — pending
	 *  rather than empty, which is the honest state of a lens nobody has read. */
	private static readonly NOT_YET: ReaderFn = ( abs: string ): string => {
		throw new PendingRead( abs );
	};

	private static fromRecord( json: SerializedLens ): LensObject {
		const lens = LensObject.lazy( json.path, { projectRoot: json.projectRoot ?? '', docRoot: json.docRoot, eager: true, read: LensObject.NOT_YET } );
		lens.isIncluded = json.included ?? true;
		for ( const n of json.injected ?? [] ) lens.injected.push( KCDPrimitive.fromSerialized( n ) );
		return lens;
	}

	/**
	 * Rebuild a lens from wire JSON — and recurse: each dredged child is hydrated through its
	 * OWN registered fromSerialized, so a habit comes back a HabitObject. `nodes` is absent on a
	 * shallow (non-dredged) serialization; an empty graph is the honest result there.
	 */
	static fromSerialized( json: SerializedArtifact ): LensObject {
		if ( ( json as SerializedLens ).lazy ) return LensObject.fromRecord( json as SerializedLens );
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
		this.ensureDredged();
		return {
			...this.serialize(),
			nodes:     this.nodes.map( ( n ) => n.serialize() ),
			injected:  this.injected.map( ( n ) => n.serialize() ),
			toolModes: { ...this.toolModes },
		};
	}

	// ── Reading on access ─────────────────────────────────────────────────────────

	protected ensureContent(): void {
		this.ensureLoaded();
	}

	/** Read this lens's own document, if it reads on access and has not yet. */
	private ensureLoaded(): void {
		const state = this.onAccess;
		if ( !state || state.loaded ) return;
		let parsed: LensObject;
		try {
			parsed = KCDPrimitive.fromHtml( this.read( this.path ), this.path, this.docRoot ?? LensObject.DEFAULT_DOC_ROOT ) as LensObject;
		} catch ( err ) {
			if ( err instanceof PendingRead ) {
				state.pending = [ this.path ];
				return;
			}
			// Missing or malformed: settle empty — the lens a failed `load` would have been skipped for — rather
			// than ask for it forever.
			state.loaded  = true;
			state.dredged = true;
			return;
		}
		state.loaded = true;
		this.hydrateFrom( parsed.serialize() );
		this.policy      = parsed.getPolicy();
		this.toolModes   = parsed.getToolModes();
		this.dredgeDepth = parsed.dredgeDepth;
	}

	/** Dredge this lens's children, if it reads on access and has not finished. */
	private ensureDredged(): void {
		const state = this.onAccess;
		if ( !state || state.dredged ) return;
		this.ensureLoaded();
		if ( !state.loaded ) return;
		state.pending = [];
		this.nodes    = this.dredgeOnAccess( state.pending );
		state.dredged = state.pending.length === 0;
	}

	/**
	 * The dredge for a lens that reads on access — the same children `dredgeFrom` collects at depth two, with
	 * one difference. A child whose content the compile uses is READ: one riding at `load`, a habit ( slot
	 * contention reads its class ), and one whose routing row takes its why from the child itself. Every other
	 * child is a STUB — path, type, not included — because its routing row is its whole contribution and that
	 * row comes from this lens's own table. Its content is read when somebody opens it.
	 */
	private dredgeOnAccess( pending: string[] ): KCDPrimitive[] {
		const out: KCDPrimitive[] = [];
		if ( !this.eager || clampDepth( this.dredgeDepth ) <= 1 ) return out;
		const visited = new Set( [ this.path ] );
		for ( const entry of this.policy ) {
			if ( entry.type !== 'internal' || entry.mode === 'off' ) continue;
			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );
			const type     = LensObject.classifyByPath( childAbs, this.projectRoot!, this.docRoot );
			if ( type === 'plan' || visited.has( childAbs ) ) continue;
			visited.add( childAbs );

			if ( !this.readAll && entry.mode !== 'load' && type !== 'habit' && !LensObject.whyFromChild( entry ) ) {
				// A stub stands in for a DOCUMENT. A row naming a tool rather than a file is one the whole-lens
				// dredge fails to read and drops, so it gets no stub here either.
				if ( !/\.html?$/i.test( childAbs ) ) continue;
				out.push( KCDPrimitive.fromSerialized( {
					path: childAbs, type, frontmatter: { name: entry.what }, sections: {}, body: '', links: [], included: false
				} ) );
				continue;
			}
			const held = this.readNodes.get( childAbs );
			if ( held ) {
				held.setIncluded( entry.mode === 'load' );
				out.push( held );
				continue;
			}
			try {
				const child = KCDPrimitive.fromHtml( this.read( childAbs ), childAbs, this.docRoot ?? LensObject.DEFAULT_DOC_ROOT );
				child.setIncluded( entry.mode === 'load' );
				this.readNodes.set( childAbs, child );
				out.push( child );
			} catch ( err ) {
				if ( err instanceof PendingRead ) pending.push( childAbs );
			}
		}
		return out;
	}

	/** Whether an entry's routing row takes its why from the child — the sentinel cells `resolveWhy` reads through. */
	private static whyFromChild( entry: PolicyEntry ): boolean {
		const cell = entry.why.trim().toLowerCase();
		return cell === '' || cell === 'habit';
	}

	// ── Dredge orchestration ──────────────────────────────────────────────────

	private dredgeFrom( node: KCDPrimitive, remaining: number, visited: Set<string> ): KCDPrimitive[] {
		const out: KCDPrimitive[] = [node];
		if ( remaining <= 1 ) return out;

		for ( const entry of node.getPolicy() ) {
			if ( entry.type !== 'internal' ) continue;
			// Dredge follows a slot's MODE ( Bryan, 2026-07-12, corrected 2026-07-12 — the first pass made
			// EVERY fetched child not-included, which silently stripped `load` of its whole meaning:
			// toggling a lens reference On↔Load changed the UI but never the compiled context ). `off`
			// drops the slot entirely; `on` still fetches ( eager display needs the object either way — the
			// Atlas graph, the reader drawer — but is marked not-included below, so it rides only as the
			// routing ROW `Agent.compile`'s manifest already carries ); `load` is marked INCLUDED, so its
			// full text joins `dredged` in `getContextBlocks()` below — the one case where a slot's body
			// actually rides the wire. Plans are the sole exception that outlives mode entirely ( see the
			// carve-out a few lines down ).
			if ( entry.mode === 'off' ) continue;
			// The whole-graph gate, not a refinement of the mode rule above: non-eager stops here, so none
			// of what that comment describes happens. See `eager` on the options type.
			if ( !this.eager ) continue;

			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );

			// Plans are LINK-ONLY in assembled context ( Bryan, 2026-07-12 ): a plan is an informational,
			// volatile working doc — not standing identity or reference prose — so its body must never ride
			// the wire automatically. No matter what mode a slot marks it ( short of `off`, already skipped
			// above ), a plan is NEVER dredged into `nodes`. Its
			// reference SURVIVES as a routing row instead: a plan slot on the lens itself renders through
			// `stubBlock`; a plan reached via some reference's own slot rides as a row inside that reference's
			// routing table. This is the one deliberate type carve-out that outlives the general slot-mode
			// ruling — it's the plan's volatility, not its role, that keeps its full text out of context.
			if ( LensObject.classifyByPath( childAbs, this.projectRoot!, this.docRoot ) === 'plan' ) continue;

			if ( visited.has( childAbs ) ) continue;
			visited.add( childAbs );

			let child: KCDPrimitive;
			try {
				const raw = this.read( childAbs );
				child = KCDPrimitive.fromHtml( raw, childAbs, this.docRoot ?? LensObject.DEFAULT_DOC_ROOT );
			} catch {
				continue;
			}

			// `load` rides full-body; `on` fetches for display ( the Atlas graph, the reader drawer )
			// but is excluded from `getContextBlocks()` — the routing row is its whole contribution.
			child.setIncluded( entry.mode === 'load' );

			out.push( ...this.dredgeFrom( child, remaining - 1, visited ) );
		}

		return out;
	}

	// ── Policy ────────────────────────────────────────────────────────────────
	// The dredge policy is computed by the parser ( know-region slots, the `always` gate ) and
	// rides the wire; the lens just exposes it. The markdown Know-table parse is gone.

	getPolicy(): PolicyEntry[]  {
		this.ensureLoaded();
		return [ ...this.policy ];
	}

	/** The vault root this lens was loaded against — the base every loaded file's path is relativized to
	 *  for the compiled manifest. Undefined on a lens hydrated whole from the wire. */
	getProjectRoot(): string | undefined { return this.projectRoot; }

	/** An absolute path in vault-relative, forward-slashed form — the file's ID in the compiled manifest
	 *  ( Bryan, 2026-07-12: vault-relative paths, no project-resolution magic yet ). Passthrough when no
	 *  projectRoot is known. */
	vaultRelative( abs: string ): string {
		return this.projectRoot ? PathText.relative( this.projectRoot, abs ).replace( /\\/g, '/' ) : abs;
	}

	/** The full Know graph: dredged children plus any session-injected nodes. The single
	 *  percolation point — the spiral, the count, Composition, and contribute() all read
	 *  through here, so injected context appears everywhere with no per-consumer wiring. */
	getNodes(): KCDPrimitive[]  {
		this.ensureDredged();
		return [ ...this.nodes, ...this.injected ];
	}

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

	/**
	 * The per-tool modes this lens's document TABLE holds ( `group.tool` → mode ) — the raw authored rows. A
	 * tool is not a node, so this is its own read, not `getNodes()`.
	 *
	 * IT CONTRIBUTES NOTHING TO AN AGENT ANY MORE ( Bryan, 2026-09-22 ). Tools belong to the agent ( task 58 )
	 * and a lens is documentation, so the two derivations that turned these rows into an agent's allowances
	 * and surfaces are gone. What is left is the authored table itself, still parsed and still editable, for
	 * the lens surfaces that draw it — and a table the compile no longer reads is a leftover of the document
	 * format, to be removed from the format on its own pass rather than half-removed here.
	 */
	getToolModes(): Record<string, SlotMode> {
		this.ensureLoaded();
		return { ...this.toolModes };
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
	 * A lens's region-block set for the compiled context. The MODEL ( ruling corrected, Bryan 2026-07-12,
	 * superseding the overzealous "links-only for `load`" framing ): a slot's mode is a
	 * suggestion surface, NOT a fetch policy — `off` excludes; `on` is the DECK POINTER ( a routing ROW
	 * only, ~90% of habits live here ); `load` is an IMPLICIT INJECTION — the target's body rides,
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
		this.ensureDredged();
		if ( !this.isIncluded ) return [];
		const own      = super.getContextBlocks();
		const dredged  = this.nodes.flatMap( n => n.getContextBlocks() );
		const injected = this.injected
			.flatMap( n => n.getContextBlocks() )
			.map( b => ( { ...b, sourceLayer: 'injected' as const } ) );
		const stub = this.stubBlock();
		return [ ...own, ...dredged, ...( stub ? [ stub ] : [] ), ...injected ];
	}

	/** This lens's OWN sections in one region — its Care, or its Know tables — without the region intro, the
	 *  stub, or anything it dredged. What a lens says about itself, read the same way by the agent compiler and
	 *  the lens editor. */
	getOwnBlocks( region: 'care' | 'know' ): TaggedBlock[] {
		const own = this.getPath();
		return this.getContextBlocks().filter( b => b.path === own && b.region === region && !!b.section && b.section !== 'stub' );
	}

	/** The "Available on request" stub — every `on`-mode internal link this lens's policy names (the
	 *  routing-row case, any artifact type), plus any `load` link the current dredge depth
	 *  didn't reach. One synthetic block, folded into `getContextBlocks()` so the unified assembler
	 *  sees it like any other contribution instead of `serializeForContext()` special-casing it.
	 *  `off`-mode links never appear here — the user excluded them entirely, not just deferred them.
	 *  Silently omitted (not thrown) with no projectRoot — a display nicety, not something that
	 *  should crash a context call from an unloaded lens.
	 *
	 *  Dedupe is against CONTRIBUTING paths ( `.included`, i.e. `load` content already rendered
	 *  full-body elsewhere ), not merely FETCHED paths — Bryan, 2026-07-13: an `on`-mode habit is
	 *  fetched too ( `dredgeFrom` needs its `habit-class` regardless of mode ) but contributes nothing
	 *  to `getContextBlocks()` while excluded; the old "already loaded ⇒ skip" filter caught that
	 *  fetch-for-metadata case and silently dropped the row it was the ONLY source for. */
	stubBlock(): TaggedBlock | null {
		this.ensureDredged();
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

	/** The reason text a routing/stub row shows. The Care-table Why cell is a two-state: real
	 *  hand-written prose is an override and rides as-is; `habit` and an empty cell are both "no
	 *  override" sentinels — Bryan, 2026-07-13 — that DEFER to the target's own declared `why`
	 *  ( `habit` is the authoring default, so most rows never restate a reason at all ). Duck-typed
	 *  ( `getWhy` ) rather than importing `HabitObject` here — only habits carry this field today, and
	 *  the check degrades safely for any other artifact type or an unfetched target. */
	private static resolveWhy( entry: PolicyEntry, node: KCDPrimitive | undefined ): string {
		const cell = entry.why.trim().toLowerCase();
		const isSentinel = cell === '' || cell === 'habit';
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
