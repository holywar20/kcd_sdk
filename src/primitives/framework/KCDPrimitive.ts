import { KcdParse } from '../../core/html/KcdParse';
import { KcdEmit } from '../../core/html/KcdEmit';
import type { ArtifactType, KCDRole, LinkEntry, LinkType, PolicyEntry, SerializedArtifact, TypeCheckIssue, WriteMap } from '../types';

export const DREDGE_MAX = 4;

export type HydratorFn = ( json: SerializedArtifact ) => KCDPrimitive;

/** Clamp a requested dredge depth into the legal [1, DREDGE_MAX] range. */
export function clampDepth( depth: number ): number {
	return Math.max( 1, Math.min( DREDGE_MAX, Math.floor( depth ) ) );
}

/**
 * Base artifact: the object model behind every KCD document. HTML is the sole substrate —
 * a document enters through `fromHtml` ( validate-first via KcdParse ) or `fromSerialized`
 * ( the wire ). There is no markdown parse path; conformance is enforced once, at parse, by
 * the shared KcdValidate. Subclasses override `getRole`, `getPolicy`, and `toContextBlock`
 * to add type-specific behavior; structure/frontmatter rules are no longer per-subclass code.
 *
 * The hydrator registry and path utilities live here as static methods so subclasses never
 * need to import a separate utility module.
 */
export class KCDPrimitive {

	// ── Hydrator registry ─────────────────────────────────────────────────────

	private static _hydrators = new Map<ArtifactType, HydratorFn>();

	/**
	 * Register a type's wire-hydrator so `fromSerialized` rebuilds the right subclass
	 * (real prototype → real getRole/toContextBlock). Registered centrally from the
	 * primitives barrel, the one place that already pulls in every subclass.
	 */
	static registerHydrator( type: ArtifactType, fn: HydratorFn ): void {
		KCDPrimitive._hydrators.set( type, fn );
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
	 *  copies agree, but never reaches disk. */
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

	/**
	 * The HTML front end ( parser-family row 1 ): validate-first, then hydrate the right subclass.
	 * The parser produces a `ParsedArtifact` ( a SerializedArtifact superset ), so the existing
	 * `fromSerialized` dispatch builds the correct prototype with no md parse pipeline. A malformed
	 * document never reaches here — `KcdParse.parse` throws, all-or-nothing.
	 */
	static fromHtml( html: string, absPath: string ): KCDPrimitive {
		return KCDPrimitive.fromSerialized( KcdParse.parse( html, absPath ) );
	}

	/**
	 * The HTML back end ( parser-family row 5, the inverse of `fromHtml` ): this instance's current
	 * state → a full HTML document string. Regenerates frontmatter only — sections/regions/slots ride
	 * through from `body` untouched ( see KcdEmit's doc comment ). Callers ( `KcdService.save` ) are
	 * expected to validate the result before writing; this method does not.
	 */
	toHtml(): string {
		return KcdEmit.emit( this.serialize() );
	}

	/**
	 * Hydrate from wire JSON — dispatched by type to the registered subclass hydrator so a
	 * serialized habit comes back a HabitObject, a lens a LensObject (with its nodes). Falls
	 * back to a base primitive for types with no hydrator. Trusts the state as already valid;
	 * this is the seam both the parser ( via fromHtml ) and the bridge cross.
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

	// ── KCD role & structural validation ─────────────────────────────────────

	/**
	 * This artifact's KCD role — determines which context dock it belongs to.
	 * Default is 'know'. Do-role artifacts (Habit, Contract, Generator, Analyzer,
	 * Pipeline) override to return 'do'. LensObject overrides to return 'lens'.
	 */
	getRole(): KCDRole { return 'know'; }

	/**
	 * Non-throwing structural validation. Conformance is enforced at parse time by the shared
	 * KcdValidate ( a malformed document never becomes an object — `fromHtml` throws ), so a
	 * hydrated object is valid by construction and has no per-subclass checks left to re-run.
	 * Kept as the stable seam for callers ( e.g. the MCP health sweep, which already treats a
	 * parse throw as the error ); returns no issues for a well-formed object.
	 */
	typeCheck(): TypeCheckIssue[] {
		return [];
	}

	getPolicy(): PolicyEntry[] { return []; }

	// ── Serialization ────────────────────────────────────────────────────────

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

	/** frontmatter.name if present, otherwise the filename stem ( extension stripped ). */
	getName(): string {
		const fmName = this.frontmatter['name'];
		if ( typeof fmName === 'string' && fmName ) return fmName;
		const stem = this.path.split( /[\\/]/ ).pop() ?? 'artifact';
		return stem.replace( /\.html?$/i, '' );
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
 * by project convention). HTML is the substrate, so the file form is `.html`.
 */
export function classifyRelPath( rel: string, docRoot = '_Claude' ): ArtifactType {
	const norm = rel.replace( /\\/g, '/' );

	if ( !norm.startsWith( docRoot + '/' ) ) return 'unknown';

	// Nav-index files are first-class navigational primitives, regardless of which folder they sit in.
	if ( norm.endsWith( '/nav-index.html' ) ) return 'nav-index';

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
