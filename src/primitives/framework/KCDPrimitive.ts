import { KcdParse } from '../../core/html/KcdParse';
import { KcdEmit } from '../../core/html/KcdEmit';
import { KcdContext } from '../../core/html/KcdContext';
import type { ArtifactType, KCDRole, LinkEntry, LinkType, PolicyEntry, SerializedArtifact, SlotMode, TaggedBlock, TypeCheckIssue, WriteMap } from '../types';

export const DREDGE_MAX = 4;

export type HydratorFn = ( json: SerializedArtifact ) => KCDPrimitive;

/** Clamp a requested dredge depth into the legal [1, DREDGE_MAX] range.
 *  HARD-CODED to 2 ( = direct children only, no grandchildren ) — Bryan, 2026-07-13: dredge is
 *  real but was generating noise while the current focus is inheritance/override visualization.
 *  2 is the floor, not 1: `habitClass` ( what SlotResolver groups slots by ) lives on the CHILD
 *  artifact's own frontmatter, never in the lens's own policy table — depth 1 fetches nothing and
 *  silently blanks every slot, which looks like a parse bug but isn't one. Depth 2 is also the
 *  pre-existing system default ( LENS_DEFAULT_DEPTH below ), so this rejects anything DEEPER than
 *  before, it doesn't reopen anything wider. Restore
 *  `Math.max( 1, Math.min( DREDGE_MAX, Math.floor( depth ) ) )` to bring variable depth back. */
export function clampDepth( _depth: number ): number {
	return 2;
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
	 * Utility) override to return 'do'. LensObject overrides to return 'lens'.
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
		return KcdContext.project( this.serialize() );
	}

	// ── Contribution (tuned state) ───────────────────────────────────────────

	/** This artifact's contribution to the outbound request, per its tuned state.
	 *  The atom of the recursive context query — an excluded artifact contributes
	 *  nothing; everything else renders its context block. */
	contribute(): string {
		return this.isIncluded ? this.toContextBlock() : '';
	}

	/**
	 * This artifact's region-block decomposition ( context-optimization plan, Phase 2 ) — the unit
	 * `ContextAssembler` merges and sorts across a whole loaded set. An excluded artifact contributes
	 * no blocks, mirroring `contribute()`. Every block here defaults to this artifact's OWN
	 * `getRole()` ( `do` for habit/contract/generator/analyzer/utility, `know` for everything else ) —
	 * a lens's `data-kcd-region` wrappers override that per-section inside `KcdContext.projectBlocks`.
	 * `sourceLayer` defaults `'lens'` ( "part of the normal dredge graph" ); `LensObject` overrides to
	 * tag its `injected` children `'injected'` instead. `habitClass` comes straight from this
	 * artifact's own `habit-class` frontmatter field ( protocol §6 ) — every block a classed habit
	 * contributes carries the SAME class, since the mutual-exclusion cascade resolves at the whole-
	 * artifact level, not per section.
	 */
	getContextBlocks(): TaggedBlock[] {
		if ( !this.isIncluded ) return [];
		const region = this.getRole() === 'do' ? 'do' : 'know';
		const habitClass = ( this.frontmatter[ 'habit-class' ] as string | undefined ) ?? null;
		return KcdContext.projectBlocks( this.serialize(), region )
			.map( b => ( { ...b, sourceLayer: 'lens' as const, path: this.path, artifactType: this.type, habitClass } ) );
	}

	/**
	 * The token COST of this artifact's contribution — literally `getContextBlocks()` priced per block, so
	 * it INHERITS that method's recursion instead of re-implementing it: a leaf sums its own region blocks,
	 * a `LensObject` sums its dredged + injected children's ( `getContextBlocks()` already folds them in ),
	 * and no per-type override is needed for either. An excluded artifact contributes no blocks, so it costs
	 * 0 by construction. Deliberately loose — a ±5% variance is expected and fine ( per-block sums run a hair
	 * above a single-pile estimate ); the only EXACT count is the real wire usage the agent reads back off a
	 * response. ( `Agent` is not a `KCDPrimitive` and its context carries bound env beyond
	 * `getContextBlocks()`, so it defines its OWN `estimateTokens()` over its compiled blocks — the same
	 * price-the-blocks shape, one level up. )
	 */
	estimateTokens(): number {
		return this.getContextBlocks().reduce( ( sum, b ) => sum + ( b.text ? KCDPrimitive._estimateTokens( b.text ) : 0 ), 0 );
	}

	/**
	 * The one token estimator — chars ÷ 4, floored at 1 for a present-but-tiny block. Lives here beside the
	 * hydrator registry + path utilities, so every artifact and both process-side `Utils` baskets share ONE
	 * formula with no separate import ( the `_` marks it the shared primitive `estimateTokens()` piles text
	 * into, not a public surface ). The real per-token count is a connector concern; this is the cheap,
	 * always-available estimate the whole budget UI runs on. Identical to the renderer's old
	 * `Utils.estimateTokens`, which now delegates here.
	 */
	static _estimateTokens( text: string ): number {
		return Math.max( 1, Math.round( text.length / 4 ) );
	}

	/**
	 * This artifact's FULL-body context cost — its whole projected block priced regardless of tuned state,
	 * i.e. what it weighs at `suggested` mode. Distinct from `estimateTokens()`, which respects inclusion and
	 * returns 0 when excluded: a composition card asks "what would this cost if it rode full-body", which is
	 * this. ( The home for `Composition.contextTokens( primitive )`. )
	 */
	bodyTokens(): number {
		return KCDPrimitive._estimateTokens( this.toContextBlock() );
	}

	/**
	 * This artifact's `on`-mode ROUTING-ROW cost — the single manifest line `- {name} — {why} ({path})` it
	 * reduces to when demoted from full body to a pointer. `why` is composition copy ( the lens slot's
	 * description ), passed in because it lives on the lens→artifact relationship, not on the artifact
	 * itself; name + path are the artifact's own. ( The home for `Composition.stubTokens( name, why, href )`. )
	 */
	stubTokens( why: string ): number {
		return KCDPrimitive._estimateTokens( `- ${ this.getName() } — ${ why } (${ this.getPath() })` );
	}

	/**
	 * This artifact's cost at a given slot mode — the ONE home for the off/on/suggested split, so every
	 * composition row reads the same number the compile actually pays: `off` = 0, `on` = the routing row
	 * ( `stubTokens` ), `suggested` = the full body ( `bodyTokens` ). The artifact-axis mirror of the tool
	 * axis' baked per-mode counts. ( The home for `Composition.habitModeTokens( node, mode, name, why )`. )
	 */
	modeTokens( mode: SlotMode, why = '' ): number {
		if ( mode === 'off' ) return 0;
		return mode === 'suggested' ? this.bodyTokens() : this.stubTokens( why );
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
	if ( sub.startsWith( 'utilities/' ) )      return 'utility';
	if ( sub.startsWith( 'habits/' ) )         return 'habit';
	if ( sub.startsWith( 'contracts/' ) )      return 'contract';
	if ( sub.startsWith( 'kcd/templates/' ) )  return 'template';
	if ( sub.startsWith( 'kcd/' ) )            return 'framework';

	return 'unknown';
}
