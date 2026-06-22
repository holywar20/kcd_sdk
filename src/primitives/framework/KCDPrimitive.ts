import * as yaml from 'js-yaml';
import type { ScannedFile } from '../../scanner';
import { KCDParseError, KCDValidationError } from '../errors';
import type { ArtifactType, KCDRole, LinkEntry, LinkType, PolicyEntry, SerializedArtifact, TypeCheckIssue, WriteMap } from '../types';

export const DREDGE_MAX = 4;

export type FactoryFn = ( markdown: string, absPath: string, type: ArtifactType ) => KCDPrimitive;
export type HydratorFn = ( json: SerializedArtifact ) => KCDPrimitive;

/** Clamp a requested dredge depth into the legal [1, DREDGE_MAX] range. */
export function clampDepth( depth: number ): number {
	return Math.max( 1, Math.min( DREDGE_MAX, Math.floor( depth ) ) );
}

const H2_RE = /^## (.+)$/gm;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Base artifact: data + the parse chain + working stubs.
 *
 * Subclasses override `validateFrontmatter`, `validateStructure`, `parseBody`,
 * `getPolicy`, `getRole`, and `toContextBlock` to add type-specific behavior.
 * Spine concerns (node list, reader, dredge budget) live on LensObject, not here.
 *
 * The factory registry and path utilities live here as static methods so
 * subclasses never need to import a separate utility module.
 */
export class KCDPrimitive {

	// ── Factory registry ─────────────────────────────────────────────────────

	private static _factories = new Map<ArtifactType, FactoryFn>();
	private static _fallback: FactoryFn | null = null;
	private static _hydrators = new Map<ArtifactType, HydratorFn>();

	static register( type: ArtifactType, fn: FactoryFn ): void {
		KCDPrimitive._factories.set( type, fn );
	}

	static setFallback( fn: FactoryFn ): void {
		KCDPrimitive._fallback = fn;
	}

	/**
	 * Register a type's wire-hydrator so `fromSerialized` rebuilds the right subclass
	 * (real prototype → real getRole/toContextBlock). Registered centrally from the
	 * primitives barrel, the one place that already pulls in every subclass.
	 */
	static registerHydrator( type: ArtifactType, fn: HydratorFn ): void {
		KCDPrimitive._hydrators.set( type, fn );
	}

	static create( type: ArtifactType, markdown: string, absPath: string ): KCDPrimitive {
		const fn = KCDPrimitive._factories.get( type ) ?? KCDPrimitive._fallback;
		if ( !fn ) throw new Error( `No factory registered for type "${type}" and no fallback set` );
		return fn( markdown, absPath, type );
	}

	// ── Instance state ────────────────────────────────────────────────────────

	protected path: string;
	protected type: ArtifactType;
	protected body: string;
	protected links: LinkEntry[];
	protected sections: Record<string, string>;
	protected frontmatter: Record<string, unknown>;
	protected isDirty: boolean;
	/** Tuned state: whether this artifact contributes to the next outbound request.
	 *  Runtime tuning, not document content — rides serialization so both process
	 *  copies agree, but never reaches the markdown on disk. */
	protected isIncluded = true;

	protected constructor( path: string, type: ArtifactType ) {
		this.path        = path;
		this.type        = type;
		this.body        = '';
		this.links       = [];
		this.sections    = {};
		this.frontmatter = {};
		this.isDirty     = false;
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): KCDPrimitive {
		const obj = new KCDPrimitive( filePath, 'unknown' );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): KCDPrimitive {
		const obj = new KCDPrimitive( scanned.path, 'unknown' );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	/** Build a base primitive of a given type. Used as the fallback for unregistered types. */
	static createBase( markdown: string, absPath: string, type: ArtifactType ): KCDPrimitive {
		const obj = new KCDPrimitive( absPath, type );
		obj.runInit( markdown );
		return obj;
	}

	/**
	 * Hydrate from wire JSON — dispatched by type to the registered subclass hydrator so a
	 * serialized habit comes back a HabitObject, a lens a LensObject (with its nodes). Falls
	 * back to a base primitive for types with no hydrator. Trusts the state as already valid;
	 * bypasses the parse pipeline.
	 */
	static fromSerialized( json: SerializedArtifact ): KCDPrimitive {
		const fn = KCDPrimitive._hydrators.get( json.type );
		if ( fn ) return fn( json );
		return KCDPrimitive.hydrateBase( json );
	}

	/** The typeless hydration body — the fallback for types with no registered hydrator. */
	static hydrateBase( json: SerializedArtifact ): KCDPrimitive {
		const obj = new KCDPrimitive( json.path, json.type );
		obj.hydrateFrom( json );
		return obj;
	}

	/** Copy the common wire fields onto a freshly-constructed instance. Every subclass
	 *  hydrator runs through here — a new serialized field lands once, not ten times. */
	protected hydrateFrom( json: SerializedArtifact ): void {
		this.frontmatter = { ...json.frontmatter };
		this.sections    = { ...json.sections };
		this.body        = json.body;
		this.links       = [ ...json.links ];
		this.isIncluded  = json.included ?? true;
	}

	static collectWrites( objects: KCDPrimitive[] ): WriteMap {
		const writes: WriteMap = {};
		for ( const obj of objects ) {
			if ( obj.isDirty ) writes[obj.path] = obj.serialize();
		}
		return writes;
	}

	// ── Pipeline runners ─────────────────────────────────────────────────────

	protected runInit( markdown: string ): void {
		const { frontmatter, body } = this.splitFrontmatter( markdown );
		this.frontmatter = frontmatter;
		this.validateFrontmatter();
		this.parseBody( body );
		this.validateStructure();
		this.extractLinks();
	}

	protected runInitFromScanned( scanned: ScannedFile ): void {
		this.frontmatter = { ...scanned.frontmatter };
		this.validateFrontmatter();
		this.parseBody( scanned.body );
		this.validateStructure();
		this.extractLinks();
	}

	private splitFrontmatter( markdown: string ): { frontmatter: Record<string, unknown>; body: string } {
		const match = markdown.match( FRONTMATTER_RE );
		if ( !match ) return { frontmatter: {}, body: markdown };

		let frontmatter: Record<string, unknown> = {};
		try {
			const parsed = yaml.load( match[1] );
			if ( parsed && typeof parsed === 'object' && !Array.isArray( parsed ) ) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch ( e ) {
			throw new KCDParseError(
				`Frontmatter YAML parse failed: ${e instanceof Error ? e.message : String( e )}`,
				this.path, match[1]
			);
		}

		return { frontmatter, body: match[2] ?? '' };
	}

	// ── Overridable hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {}

	protected parseBody( body: string ): void {
		this.body     = body;
		this.sections = {};

		const parts = body.split( /^## /m );
		for ( let i = 1; i < parts.length; i++ ) {
			const nl = parts[i].indexOf( '\n' );
			if ( nl === -1 ) {
				this.sections[parts[i].trim()] = '';
			} else {
				const name    = parts[i].slice( 0, nl ).trim();
				const content = parts[i].slice( nl + 1 ).trim();
				this.sections[name] = content;
			}
		}
	}

	/**
	 * The H2 sections this artifact must declare. Subclasses override to demand structure;
	 * the base requires none. `validateStructure` runs the same missing-section check for
	 * every type from this one list — a type just names its sections, it never rewrites the loop.
	 */
	protected requiredSections(): string[] { return []; }

	protected validateStructure(): void {
		for ( const section of this.requiredSections() ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`${this.type}: required section "${section}" is missing`,
					this.path, `## ${section} section`, null,
					{ section }
				);
			}
		}
	}

	protected extractLinks(): void {
		this.links = [];

		const boundaries: Array<{ name: string; start: number }> = [];
		H2_RE.lastIndex = 0;
		let h2: RegExpExecArray | null;
		while ( ( h2 = H2_RE.exec( this.body ) ) !== null ) {
			boundaries.push( { name: h2[1].trim(), start: h2.index } );
		}

		const sectionAt = ( pos: number ): string | undefined => {
			let current: string | undefined;
			for ( const b of boundaries ) {
				if ( b.start <= pos ) current = b.name;
				else break;
			}
			return current;
		};

		LINK_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ( ( m = LINK_RE.exec( this.body ) ) !== null ) {
			this.links.push( {
				text: m[1], href: m[2],
				type: classifyHref( m[2] ),
				section: sectionAt( m.index ),
			} );
		}
	}

	// ── KCD role & structural validation ─────────────────────────────────────

	/**
	 * This artifact's KCD role — determines which context dock it belongs to.
	 * Default is 'know'. Do-role artifacts (Habit, Contract, Generator, Analyzer,
	 * Pipeline) override to return 'do'. LensObject overrides to return 'lens'.
	 */
	getRole(): KCDRole { return 'know'; }

	/**
	 * Non-throwing structural validation. Re-runs the same checks as the constructor
	 * but returns issues instead of throwing. Use on fromSerialized objects or after
	 * mutation before save.
	 */
	typeCheck(): TypeCheckIssue[] {
		const issues: TypeCheckIssue[] = [];

		const capture = ( e: unknown ) => {
			if ( e instanceof KCDValidationError ) {
				issues.push( { severity: 'error', message: e.message, field: e.field, section: e.section } );
			} else if ( e instanceof KCDParseError ) {
				issues.push( { severity: 'error', message: e.message } );
			}
		};

		try { this.validateFrontmatter(); } catch ( e ) { capture( e ); }
		try { this.validateStructure();   } catch ( e ) { capture( e ); }

		return issues;
	}

	getPolicy(): PolicyEntry[] { return []; }

	// ── Serialization ────────────────────────────────────────────────────────

	toMarkdown(): string {
		const fm = yaml.dump( this.frontmatter, { lineWidth: -1 } ).trimEnd();
		return `---\n${fm}\n---\n\n${this.body}`;
	}

	serialize(): SerializedArtifact {
		return {
			path:        this.path,
			type:        this.type,
			frontmatter: { ...this.frontmatter },
			sections:    { ...this.sections },
			body:        this.body,
			links:       [ ...this.links ],
			included:    this.isIncluded,
		};
	}

	toContextBlock(): string {
		return `# [${this.type}] ${this.path}\n\n${this.body.trim()}`;
	}

	// ── Contribution (tuned state) ───────────────────────────────────────────

	/** This artifact's contribution to the outbound request, per its tuned state.
	 *  The atom of the recursive context query — an excluded artifact contributes
	 *  nothing; everything else renders its context block. */
	contribute(): string {
		return this.isIncluded ? this.toContextBlock() : '';
	}

	get included(): boolean { return this.isIncluded; }

	setIncluded( on: boolean ): void { this.isIncluded = on; }

	// ── Getters ──────────────────────────────────────────────────────────────

	/** frontmatter.name if present, otherwise the filename stem. */
	getName(): string {
		const fmName = this.frontmatter['name'];
		if ( typeof fmName === 'string' && fmName ) return fmName;
		const stem = this.path.split( /[\\/]/ ).pop() ?? 'artifact';
		return stem.replace( /\.md$/, '' );
	}

	/** Internal links as typed references — this artifact's outbound edges, classified
	 *  by the same path taxonomy the dredge uses (hrefs are vault-root-relative). */
	getBacklinks(): { name: string; type: ArtifactType }[] {
		const out: { name: string; type: ArtifactType }[] = [];
		for ( const link of this.links ) {
			if ( link.type !== 'internal' ) continue;
			out.push( { name: link.text || link.href, type: classifyRelPath( link.href ) } );
		}
		return out;
	}

	getPath(): string                          { return this.path; }
	getType(): ArtifactType                    { return this.type; }
	getFrontmatter(): Record<string, unknown>  { return { ...this.frontmatter }; }
	getSections(): Record<string, string>      { return { ...this.sections }; }
	getLinks(): LinkEntry[]                    { return [ ...this.links ]; }
	get dirty(): boolean                       { return this.isDirty; }
}

export function classifyHref( href: string ): LinkType {
	if ( href.startsWith( '#' ) )                                         return 'anchor';
	if ( href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) return 'external';
	return 'internal';
}

/**
 * The path taxonomy: a vault-root-relative path (`_Claude/...`) to its ArtifactType.
 * One switch for every classifier — LensObject.classifyByPath wraps this for absolute
 * paths; getBacklinks feeds it hrefs directly (link hrefs are vault-root-relative
 * by project convention).
 */
export function classifyRelPath( rel: string, docRoot = '_Claude' ): ArtifactType {
	const norm = rel.replace( /\\/g, '/' );

	if ( !norm.startsWith( docRoot + '/' ) ) return 'unknown';

	// Index files are first-class navigational primitives, regardless of which folder they sit in.
	if ( norm.endsWith( '/index.md' ) ) return 'index';

	const sub = norm.slice( docRoot.length + 1 );

	// context/ holds support material for any parent (lens, analyzer, generator) — always reference.
	if ( sub.includes( '/context/' ) ) return 'reference';

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

KCDPrimitive.setFallback( ( markdown, absPath, type ) => KCDPrimitive.createBase( markdown, absPath, type ) );
