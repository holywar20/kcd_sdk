import { KcdParse } from '../../core/html/KcdParse';
import { KcdEmit } from '../../core/html/KcdEmit';
import { KcdContext } from '../../core/html/KcdContext';
import { VaultLayout } from '../../core/VaultLayout';
import type { ArtifactType, KCDRole, LinkEntry, LinkType, PolicyEntry, SerializedArtifact, SlotMode, TaggedBlock, TypeCheckIssue, WriteMap } from '../types';

export const DREDGE_MAX = 4;

export type HydratorFn = ( json: SerializedArtifact ) => KCDPrimitive;

/** Hard-coded to 2. Depth 1 fetches nothing, and `habitClass` lives on the child, so every slot silently blanks.
 *  Restore `Math.max( 1, Math.min( DREDGE_MAX, Math.floor( depth ) ) )` to vary depth again. */
export function clampDepth( _depth: number ): number {
	return 2;
}

/**
 * Base artifact: the object model behind every KCD document. HTML is the sole substrate; conformance
 * is enforced once, at parse, by the shared KcdValidate. Subclasses override `getRole`, `getPolicy` and
 * `toContextBlock`; the hydrator registry and path utilities are static here.
 */
export class KCDPrimitive {

	// ── Hydrator registry ─────────────────────────────────────────────────────

	private static _hydrators = new Map<ArtifactType, HydratorFn>();

	/** Registered from the primitives barrel, the one place that already imports every subclass. */
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
	/** Runtime tuning, not document content: rides serialization so both process copies agree, but never reaches disk. */
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

	/** The HTML front end: validate-first, then hydrate. A malformed document throws in `KcdParse.parse`, all-or-nothing.
	 *  `docRoot` is required, no default: it is what lets the validator tell scratch space from a same-named folder. */
	static fromHtml( html: string, absPath: string, docRoot: string ): KCDPrimitive {
		return KCDPrimitive.fromSerialized( KcdParse.parse( html, absPath, docRoot ) );
	}

	/** Serializes state to a full HTML document. Regenerates frontmatter only, and does not validate: save callers must.
	 *  Omit `cssHref` only for a caller that never lands a file; a write path must pass `KcdEmit.cssHrefFor( vaultRelPath )`. */
	toHtml( cssHref?: string ): string {
		return KcdEmit.emit( this.serialize(), cssHref );
	}

	/** Dispatches by type to the registered hydrator, or a base primitive when none is registered.
	 *  Trusts the state as valid: this is the seam both the parser and the bridge cross. */
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
	/** Called before any content is read. A no-op for a primitive that holds its content; one whose content
	 *  arrives on access ( a lens reading through its reader ) fills it here. */
	protected ensureContent(): void {}

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

	/** Default `know`. Do-role subclasses override to `do`; `LensObject` overrides to `lens`. */
	getRole(): KCDRole { return 'know'; }

	/** Returns no issues: conformance is enforced at parse by the shared KcdValidate, so a hydrated object is valid by construction.
	 *  Kept as the seam callers use; the MCP health sweep treats a parse throw as the error. */
	typeCheck(): TypeCheckIssue[] {
		return [];
	}

	getPolicy(): PolicyEntry[] { return []; }

	// ── Serialization ────────────────────────────────────────────────────────

	serialize(): SerializedArtifact {
		this.ensureContent();
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

	/** This artifact's region blocks for `ContextAssembler`. An excluded artifact contributes none, mirroring `contribute()`.
	 *  Blocks default to `getRole()`; a lens's `data-kcd-region` wrappers override per section in `KcdContext.projectBlocks`. */
	getContextBlocks(): TaggedBlock[] {
		this.ensureContent();
		if ( !this.isIncluded ) return [];
		const region = this.getRole() === 'do' ? 'do' : 'know';
		const habitClass = ( this.frontmatter[ 'habit-class' ] as string | undefined ) ?? null;
		return KcdContext.projectBlocks( this.serialize(), region )
			.map( b => ( { ...b, sourceLayer: 'lens' as const, path: this.path, artifactType: this.type, habitClass } ) );
	}

	/** Token cost of this artifact's contribution: `getContextBlocks()` priced per block, so it inherits that recursion.
	 *  Loose by design (about ±5%); the exact count is the wire usage read back off a response. */
	estimateTokens(): number {
		return this.getContextBlocks().reduce( ( sum, b ) => sum + ( b.text ? KCDPrimitive._estimateTokens( b.text ) : 0 ), 0 );
	}

	/** The one token estimator: chars ÷ 4, floored at 1. Shared by every artifact and both process-side `Utils`; the real count is a connector concern. */
	static _estimateTokens( text: string ): number {
		return Math.max( 1, Math.round( text.length / 4 ) );
	}

	/** Full-body cost regardless of inclusion: what this artifact weighs at `load` mode. Unlike `estimateTokens()`, never 0. */
	bodyTokens(): number {
		return KCDPrimitive._estimateTokens( this.toContextBlock() );
	}

	/** Cost of the `on`-mode routing row `- {name} — {why} ({path})`, the line a demoted artifact reduces to. */
	stubTokens( why: string ): number {
		return KCDPrimitive._estimateTokens( `- ${ this.getName() } — ${ why } (${ this.getPath() })` );
	}

	/** Cost at a slot mode: `off` = 0, `on` = `stubTokens`, `load` = `bodyTokens`. The one home for that split. */
	modeTokens( mode: SlotMode, why = '' ): number {
		if ( mode === 'off' ) return 0;
		return mode === 'load' ? this.bodyTokens() : this.stubTokens( why );
	}

	get included(): boolean { return this.isIncluded; }

	setIncluded( on: boolean ): void { this.isIncluded = on; }

	// ── Getters ──────────────────────────────────────────────────────────────

	getName(): string {
		this.ensureContent();
		const fmName = this.frontmatter['name'];
		if ( typeof fmName === 'string' && fmName ) return fmName;
		const stem = this.path.split( /[\\/]/ ).pop() ?? 'artifact';
		return stem.replace( /\.html?$/i, '' );
	}

	/** Internal links as typed references — this artifact's outbound edges, classified
	 *  by the same path taxonomy the dredge uses (hrefs are vault-root-relative). */
	getBacklinks(): { name: string; type: ArtifactType }[] {
		this.ensureContent();
		const out: { name: string; type: ArtifactType }[] = [];
		for ( const link of this.links ) {
			if ( link.type !== 'internal' ) continue;
			out.push( { name: link.text || link.href, type: classifyRelPath( link.href ) } );
		}
		return out;
	}

	getPath(): string                          { return this.path; }
	getType(): ArtifactType                    { return this.type; }
	getFrontmatter(): Record<string, unknown>  { this.ensureContent(); return { ...this.frontmatter }; }
	getSections(): Record<string, string>      { this.ensureContent(); return { ...this.sections }; }
	getLinks(): LinkEntry[]                    { this.ensureContent(); return [ ...this.links ]; }
	get dirty(): boolean                       { return this.isDirty; }
}

export function classifyHref( href: string ): LinkType {
	if ( href.startsWith( '#' ) )                                         return 'anchor';
	if ( href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) return 'external';
	return 'internal';
}

/**
 * Vault-root-relative path to its `ArtifactType`. The taxonomy lives in `VaultLayout`: one table that
 * classification, the library index and the deploy scaffold all read, so they cannot drift apart.
 */
export function classifyRelPath( rel: string, docRoot = '_Claude' ): ArtifactType {
	return VaultLayout.classify( rel, docRoot );
}
