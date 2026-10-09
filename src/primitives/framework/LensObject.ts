import { PathText } from '../../core/PathText';
import { KCDPrimitive, clampDepth, classifyRelPath } from './KCDPrimitive';
import { PendingRead } from './PendingRead';
import { VaultLayout } from '../../core/VaultLayout';
import { SlotResolver } from './SlotResolver';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens, SlotMode, TaggedBlock } from '../types';

const LENS_DEFAULT_DEPTH = 2;

/** Core never touches `fs`: main injects a disk reader at `load()`. Reaching this default is a bug. */
const DISK_IS_MAIN_ONLY: ReaderFn = ( absPath ) => {
	throw new Error( `LensObject.read: disk read is a main-process capability (path: ${ absPath })` );
};

export interface LensLoadOptions {
	/** Required — core can't infer it (inferProjectRoot is node-side). Main passes its root. */
	projectRoot: string;
	/** Vault folder name. Decides which dredged children classify as PLAN, keeping plan bodies out of compiled context. */
	docRoot?: string;
	depth?: number;
	/** Gates the WHOLE dredge: `false` skips every child. Anything that COMPILES must pass `true`, or the two faces
	 *  compile different objects from one lens. */
	eager?: boolean;
	/** For a lens that reads on access: read EVERY child, rather than stubbing the ones its compile does not
	 *  use. A surface that shows each child's own cost — a lens card — wants their bodies; an agent does not. */
	readAll?: boolean;
	/** The injected reader. Main supplies fsReader; the renderer supplies one that fetches through its cache. */
	read: ReaderFn;
}

/**
 * A lens: owns its projectRoot, reads through an injected `read` strategy, dredges its own children, and
 * assembles the loaded nodes into an AI context blob. Path utilities are static here: LensObject is their only consumer.
 */
export class LensObject extends KCDPrimitive {

	// ── Path resolution utilities ─────────────────────────────────────────────

	/** Re-exported from the taxonomy that owns it, so two copies of the default can't drift. */
	static readonly DEFAULT_DOC_ROOT = VaultLayout.DEFAULT_DOC_ROOT;

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
	/** Dropped onto the agent at session time, not dredged from the lens. Kept apart from `nodes` so a re-dredge
	 *  never clobbers them; they ride the wire but never reach disk. */
	protected injected: KCDPrimitive[] = [];
	/** Per-tool three-state inclusion from the Tools table (`group.tool` → mode). Not a dredged node, so it lives here, not in `nodes`. */
	protected toolModes: Record<string, SlotMode> = {};
	protected projectRoot?: string;
	/** This vault's folder name — see LensLoadOptions.docRoot. Undefined falls back to the default. */
	protected docRoot?: string;
	protected dredgeDepth = LENS_DEFAULT_DEPTH;
	/** When set, the dredge follows conditional (non-`always`) links too, marking them not-included. */
	protected eager = false;
	/** See LensLoadOptions.readAll. Meaningful only for a lens that reads on access. */
	protected readAll = false;
	/** Injected disk capability (Strategy). Default throws — main attaches a real reader at load(). */
	protected read: ReaderFn = DISK_IS_MAIN_ONLY;
	/** Set on a lens that reads on access (`LensObject.lazy`); `pending` names what the reader has not supplied yet. Null when loaded whole. */
	private onAccess: { loaded: boolean; dredged: boolean; pending: string[] } | null = null;
	/** The children a lens that reads on access has already read, by path — so a pass made while other reads
	 *  are still outstanding parses nothing twice. Cleared when it is told to read again. */
	private readNodes = new Map<string, KCDPrimitive>();

	protected constructor( filePath: string ) {
		super( filePath, 'lens' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static load( lensPath: string, opts: LensLoadOptions ): LensObject {
		// Relative lens paths resolve against the project root; core has no working directory.
		const abs = PathText.resolve( opts.projectRoot, lensPath );
		const raw = opts.read( abs );

		// Hydrates through the validate-first parser, which yields the LensObject prototype.
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

	/** Reads on access: nothing is read now. Documents and children are read through `opts.read` on first ask; `PendingRead`
	 *  means not yet. Once nothing is pending it compiles as a `load` lens does. */
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

	/** Rebuild a lens from wire JSON, recursing: each child goes through its own registered `fromSerialized`.
	 *  A shallow serialization has no `nodes`, so the graph comes back empty. */
	static fromSerialized( json: SerializedArtifact ): LensObject {
		if ( ( json as SerializedLens ).lazy ) return LensObject.fromRecord( json as SerializedLens );
		const obj = new LensObject( json.path );
		obj.hydrateFrom( json );
		// Policy is computed once by the parser and rides the wire; inner HTML has no table to re-derive it from.
		obj.policy     = json.policy ?? [];
		const children = ( json as SerializedLens ).nodes ?? [];
		obj.nodes      = children.map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		const injected = ( json as SerializedLens ).injected ?? [];
		obj.injected   = injected.map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		// Tool modes arrive from the parse and from the wire; a lens with no Tools table carries {}.
		obj.toolModes  = { ...( json as SerializedLens ).toolModes ?? {} };
		return obj;
	}

	/** Carries policy on the wire: the receiver prefers it to re-deriving, since inner HTML has no re-parseable table. */
	serialize(): SerializedArtifact {
		return { ...super.serialize(), policy: [ ...this.policy ] };
	}

	/** This lens with its dredged children and injected nodes, for the bridge. The lens isn't its own child;
	 *  the receiver rebuilds it via `fromSerialized`. */
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
			// Missing or malformed: settle empty rather than ask for it forever.
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

	/** The dredge for a read-on-access lens: `dredgeFrom`'s children at depth two, but read only where the compile uses
	 *  them (a `load` child, a habit, or one whose routing row takes its why from the child). The rest are stubs. */
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
				// Tool rows are not documents; the whole-lens dredge drops them, so they get no stub here either.
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
			// `off` drops the slot; `on` fetches for display but stays out of context; `load` rides full-body.
			if ( entry.mode === 'off' ) continue;
			// Non-eager stops here, whatever the mode.
			if ( !this.eager ) continue;

			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );

			// Plans stay link-only: volatile working docs, never dredged into `nodes`; their reference survives as a routing row.
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
	// The parser computes the dredge policy; it rides the wire and the lens just exposes it.

	getPolicy(): PolicyEntry[]  {
		this.ensureLoaded();
		return [ ...this.policy ];
	}

	/** The vault root this lens was loaded against — the base every loaded file's path is relativized to
	 *  for the compiled manifest. Undefined on a lens hydrated whole from the wire. */
	getProjectRoot(): string | undefined { return this.projectRoot; }

	/** Vault-relative, forward-slashed form of an absolute path: the file's ID in the compiled manifest. Passthrough without a projectRoot. */
	vaultRelative( abs: string ): string {
		return this.projectRoot ? PathText.relative( this.projectRoot, abs ).replace( /\\/g, '/' ) : abs;
	}

	/** Dredged children plus session-injected nodes: the single point every consumer reads through. */
	getNodes(): KCDPrimitive[]  {
		this.ensureDredged();
		return [ ...this.nodes, ...this.injected ];
	}

	/** The context contributors in order: the lens itself, then every node (dredged + injected). */
	getContributors(): KCDPrimitive[] { return [ this, ...this.getNodes() ]; }

	/** Inject a Know node at session time: always-loaded context, not dredged, not written to disk. Forces included on. */
	addInjected( node: KCDPrimitive ): void {
		node.setIncluded( true );
		this.injected.push( node );
	}

	/** The authored per-tool modes (`group.tool` → mode). Contributes nothing to an agent any more; read by the lens surfaces that draw it. */
	getToolModes(): Record<string, SlotMode> {
		this.ensureLoaded();
		return { ...this.toolModes };
	}

	getRole(): KCDRole { return 'lens'; }

	// ── Context assembly ──────────────────────────────────────────────────────

	/** Region blocks for the compiled context: own sections, dredged children, the routing stub, then injected blocks.
	 *  `dredgeFrom` is mid-rework and does not yet realize the intended mode model; do not treat its fetch/link split as canonical. */
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

	/** This lens's own sections in one region, without the stub or anything it dredged. */
	getOwnBlocks( region: 'care' | 'know' ): TaggedBlock[] {
		const own = this.getPath();
		return this.getContextBlocks().filter( b => b.path === own && b.region === region && !!b.section && b.section !== 'stub' );
	}

	/** The "Available on request" routing stub: one block naming every non-`off` internal link not already contributing full-body.
	 *  Dedupes on `.included`, not on fetched paths: a fetched-but-excluded habit still needs its row. */
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
		// Tagged `stub` so `Agent.compile()` can drop it: the manifest's References table already lists every reference slot.
		return { region: 'know', section: 'stub', mergeKey: null, text: `# Available on request\n\n${ rows }`, sourceLayer: 'lens', path: this.path, artifactType: 'lens', habitClass: null };
	}

	/** The row's reason: hand-written prose overrides; `habit` or an empty cell defers to the target's own `getWhy`.
	 *  Duck-typed, so no `HabitObject` import; any other type or an unfetched target falls back to the cell. */
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
