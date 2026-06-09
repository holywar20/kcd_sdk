import * as path from 'path';
import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive, clampDepth, classifyHref } from './KCDPrimitive';
import type { ArtifactType, KCDRole, PolicyEntry, ReaderFn, SerializedArtifact, SerializedLens } from '../types';

const LENS_DEFAULT_DEPTH = 2;
const ROW_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/;

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

	static classifyByPath( absPath: string, projectRoot: string, docRoot = LensObject.DEFAULT_DOC_ROOT ): ArtifactType {
		const rel = path.relative( projectRoot, absPath ).replace( /\\/g, '/' );

		if ( !rel.startsWith( docRoot + '/' ) ) return 'unknown';

		// Index files are organisational metadata, not typed primitives — skip classification.
		if ( path.basename( absPath ) === 'index.md' ) return 'unknown';

		const sub = rel.slice( docRoot.length + 1 );

		if ( sub.startsWith( 'lenses/' ) ) {
			// Only the lens file itself and direct per-lens dirs are type lens.
			// Anything nested deeper (context/, support docs) is reference material.
			const parts = sub.split( '/' );
			if ( parts.length <= 3 ) return 'lens';
			return 'reference';
		}
		if ( sub.startsWith( 'plans_complete/' ) ) return 'plan';
		if ( sub.startsWith( 'plans/' ) )          return 'plan';
		if ( sub.startsWith( 'references/' ) )     return 'reference';
		if ( sub.startsWith( 'generators/' ) )     return 'generator';
		if ( sub.startsWith( 'analyzers/' ) )      return 'analyzer';
		if ( sub.startsWith( 'pipelines/' ) )      return 'pipeline';
		if ( sub.startsWith( 'utilities/' ) )      return 'utility';
		if ( sub.startsWith( 'habits/' ) )         return 'habit';
		if ( sub.startsWith( 'contracts/' ) )      return 'contract';
		if ( sub.startsWith( 'kcd/templates/' ) )  return 'template';
		if ( sub.startsWith( 'kcd/' ) )            return 'framework';

		return 'unknown';
	}

	// ── Spine state ───────────────────────────────────────────────────────────

	protected policy: PolicyEntry[] = [];
	protected nodes: KCDPrimitive[] = [];
	protected projectRoot?: string;
	protected dredgeDepth = LENS_DEFAULT_DEPTH;
	/** Injected disk capability (Strategy). Default throws — main attaches a real reader at load(). */
	protected read: ReaderFn = DISK_IS_MAIN_ONLY;

	protected constructor( filePath: string ) {
		super( filePath, 'lens' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static load( lensPath: string, opts: LensLoadOptions ): LensObject {
		const abs  = path.resolve( lensPath );
		const lens = new LensObject( abs );
		lens.projectRoot = opts.projectRoot;
		lens.read        = opts.read;
		lens.runInit( lens.read( abs ) );

		const depth = clampDepth( opts.depth ?? lens.dredgeDepth );
		// dredgeFrom returns [ self, ...descendants ]; nodes holds the children only.
		lens.nodes  = lens.dredgeFrom( lens, depth, new Set( [abs] ) ).slice( 1 );
		return lens;
	}

	static parse( markdown: string, filePath: string ): LensObject {
		const obj = new LensObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): LensObject {
		const obj = new LensObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	/**
	 * Rebuild a lens from wire JSON — and recurse: each dredged child is hydrated through its
	 * OWN registered fromSerialized, so a habit comes back a HabitObject. `nodes` is absent on a
	 * shallow (non-dredged) serialization; an empty graph is the honest result there.
	 */
	static fromSerialized( json: SerializedArtifact ): LensObject {
		const obj = new LensObject( json.path );
		obj.frontmatter = { ...json.frontmatter };
		obj.sections    = { ...json.sections };
		obj.body        = json.body;
		obj.links       = [ ...json.links ];
		obj.policy      = obj.parseKnowPolicy();
		const children  = ( json as SerializedLens ).nodes ?? [];
		obj.nodes       = children.map( ( n ) => KCDPrimitive.fromSerialized( n ) );
		return obj;
	}

	/** The wire form for crossing the bridge: this lens plus its dredged children (each serialized,
	 *  children only — the lens isn't its own child). The receiver rebuilds via fromSerialized. */
	serializeForWire(): SerializedLens {
		return { ...this.serialize(), nodes: this.nodes.map( ( n ) => n.serialize() ) };
	}

	// ── Dredge orchestration ──────────────────────────────────────────────────

	private dredgeFrom( node: KCDPrimitive, remaining: number, visited: Set<string> ): KCDPrimitive[] {
		const out: KCDPrimitive[] = [node];
		if ( remaining <= 1 ) return out;

		for ( const entry of node.getPolicy() ) {
			if ( !entry.always || entry.type !== 'internal' ) continue;

			const childAbs = LensObject.resolveHref( entry.href, this.projectRoot! );
			if ( visited.has( childAbs ) ) continue;
			visited.add( childAbs );

			let child: KCDPrimitive;
			try {
				const markdown = this.read( childAbs );
				child = KCDPrimitive.create( LensObject.classifyByPath( childAbs, this.projectRoot! ), markdown, childAbs );
			} catch {
				continue;
			}

			out.push( ...this.dredgeFrom( child, remaining - 1, visited ) );
		}

		return out;
	}

	// ── Parsing ───────────────────────────────────────────────────────────────

	protected parseBody( body: string ): void {
		super.parseBody( body );
		this.policy = this.parseKnowPolicy();
	}

	private parseKnowPolicy(): PolicyEntry[] {
		const know = this.sections['Know'];
		if ( !know ) return [];

		const entries: PolicyEntry[] = [];
		for ( const line of know.split( '\n' ) ) {
			const trimmed = line.trim();
			if ( !trimmed.startsWith( '|' ) ) continue;

			const cells = trimmed.split( '|' ).slice( 1, -1 ).map( c => c.trim() );
			if ( cells.length < 3 ) continue;

			const [what, where, why] = cells;
			const link = where.match( ROW_LINK_RE );
			if ( !link ) continue;

			const href = link[2];
			entries.push( {
				what, href, why,
				always:  /^always\b/i.test( why ),
				type:    classifyHref( href ),
				section: 'Know',
			} );
		}
		return entries;
	}

	getPolicy(): PolicyEntry[]  { return [ ...this.policy ]; }
	getNodes(): KCDPrimitive[]  { return [ ...this.nodes ];  }

	getRole(): KCDRole { return 'lens'; }

	// ── Context assembly ──────────────────────────────────────────────────────

	serializeForContext(): string {
		if ( !this.projectRoot ) throw new Error( 'serializeForContext requires a loaded lens (no projectRoot)' );

		// nodes is children-only now, so the lens itself leads the context list explicitly.
		const list        = [ this as KCDPrimitive, ...this.nodes ];
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

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'lens' ) {
			throw new KCDValidationError(
				`LensObject: frontmatter.type must be "lens"`,
				this.path, '"lens"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}

		if ( !this.frontmatter['command'] ) {
			throw new KCDValidationError(
				`LensObject: frontmatter.command is required`,
				this.path, 'command field present', null,
				{ field: 'command' }
			);
		}
	}

	protected validateStructure(): void {
		for ( const section of ['Know', 'Care', 'Do'] ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`LensObject: required section "${section}" is missing`,
					this.path, `## ${section} section`, null,
					{ section }
				);
			}
		}
	}
}

KCDPrimitive.register( 'lens', ( markdown, absPath ) => LensObject.parse( markdown, absPath ) );
