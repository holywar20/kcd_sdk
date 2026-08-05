import * as fs from 'fs';
import * as path from 'path';
import { LensObject, Glob, KcdExcise, VaultLayout, Agent, InstallManifest } from '../core';
import type { ArtifactRef, ArtifactType } from '../core';
import { scan } from '../scanner';
import type { ScannedFile } from '../scanner';
import { inferProjectRoot, loadLensFromDisk } from './io';

/**
 * One inbound link that a heal touches. `file` is the referrer ( vault-relative ); `oldHref` is the
 * EXACT authored href as written in that file ( so the on-disk swap is precise ); `newHref` is its
 * replacement on a move, or undefined on a delete strip.
 */
export interface HealEdit {
	file:     string;
	oldHref:  string;
	newHref?: string;
}

/**
 * The full effect of a move/delete BEFORE it touches disk — the rename ( or removal ) plus every
 * referrer edit that keeps the graph viable. Vault.move/delete compute this first ( the preview ) and
 * then apply it; that split is the seam a human-approval gate slots into. Returned from the applied
 * call too, so the caller sees exactly what changed.
 */
export interface HealPlan {
	op:    'move' | 'delete';
	from:  string;
	to?:   string;
	edits: HealEdit[];
}

/**
 * One reference-integrity finding — a link or identity ref that does not resolve. Advisory ( `warn` ):
 * distinct from the structural typeCheck errors that block. `path` is the referrer ( vault-relative );
 * `ref` is the offending href or slug. This is what keeps the "internal state always viable" invariant
 * observable between heals.
 */
export interface RefIssue {
	path:     string;
	severity: 'warn';
	message:  string;
	ref:      string;
}

/**
 * Vault — a KCD document store bound to one ( projectRoot, docRoot ) pair.
 *
 * The single facade for everything done against a vault: path math,
 * classification, scanning, glob, and disk read/write. Consumers hold ONE
 * bound object instead of threading roots through a scatter of free functions
 * ( scan, classifyByPath, resolveHref, loadLensFromDisk, … ) — the import
 * surface stays a named object, not a bag of methods.
 *
 * Node-side by design: it touches disk. The renderer receives serialized
 * artifacts over the bridge and never needs a Vault.
 */
export class Vault {

	/** Absolute vault root — projectRoot/docRoot, resolved once. */
	readonly root: string;

	constructor( private projectRoot: string, private docRoot: string = LensObject.DEFAULT_DOC_ROOT ) {
		this.root = path.resolve( path.join( projectRoot, docRoot ) );
	}

	/** Build a Vault by walking up from a start path until an ancestor holds the doc root. */
	static infer( startPath: string, docRoot: string = LensObject.DEFAULT_DOC_ROOT ): Vault {
		return new Vault( inferProjectRoot( startPath, docRoot ), docRoot );
	}

	// ── Path math ───────────────────────────────────────────────────────────

	/**
	 * Vault-relative path → absolute path anchored at the vault root.
	 * Absolute inputs are normalized as-is ( isInside still rejects out-of-vault ones ),
	 * so callers passing absolute paths keep working regardless of process cwd.
	 */
	toAbs( vaultRelative: string ): string {
		if ( path.isAbsolute( vaultRelative ) ) return path.normalize( vaultRelative );
		return path.resolve( this.root, this._stripDocRoot( vaultRelative ) );
	}

	/**
	 * Tolerate a path that already carries the doc-root segment where a vault-relative one is expected —
	 * `_Claude/plans/x.html` and `plans/x.html` name the same artifact.
	 *
	 * Not leniency for its own sake. The vault speaks TWO path currencies by design: an href inside a
	 * document is vault-ROOT-relative, because a browser opening that file from the project root has to be
	 * able to follow it, while a tool parameter is vault-relative, because it resolves against the root
	 * itself. An agent that copies a link out of a document into a tool call is doing the obvious thing.
	 *
	 * Before this it got a DOUBLED path ( `…/_Claude/_Claude/lenses/…` ) and a raw ENOENT — and the path
	 * jail waved it through on the way, because a doubled path is still inside the vault. The one guard
	 * positioned to catch it could not see it.
	 *
	 * Normalizing HERE fixes every tool at once: get, save, move, delete, links and health all reach disk
	 * through this method. The alternative was the same strip repeated at six call sites, or teaching every
	 * agent a distinction the system can simply stop making.
	 *
	 * What this gives up: a genuine `_Claude/_Claude/…` becomes unreachable. That directory does not exist
	 * and should not — a doc root nested inside itself is a mistake, not a layout — so the trade is a real
	 * ambiguity resolved in favour of the case that actually happens.
	 */
	private _stripDocRoot( rel: string ): string {
		const fwd  = rel.replace( /\\/g, '/' ).replace( /^\.?\//, '' );
		const lead = this.docRoot.replace( /\\/g, '/' ).replace( /\/+$/, '' ) + '/';
		return fwd.startsWith( lead ) ? fwd.slice( lead.length ) : fwd;
	}

	/** Absolute ( or vault-relative ) path → vault-relative path, for return payloads. */
	toVaultRel( anyPath: string ): string {
		return path.relative( this.root, this.toAbs( anyPath ) );
	}

	/** True when the path resolves inside the vault root — the path-jail predicate. */
	isInside( anyPath: string ): boolean {
		const rel = path.relative( this.root, this.toAbs( anyPath ) );
		return !rel.startsWith( '..' ) && !path.isAbsolute( rel );
	}

	// ── KCD semantics ─────────────────────────────────────────────────────────

	/** Classify a path ( vault-relative or absolute ) into its ArtifactType. */
	classify( anyPath: string ): ArtifactType {
		return LensObject.classifyByPath( this.toAbs( anyPath ), this.projectRoot, this.docRoot );
	}

	/** Every document type that may legally be written at this path — `classify`'s write-time
	 *  counterpart. Empty = untyped space, anything goes. */
	acceptedTypes( anyPath: string ): readonly ArtifactType[] {
		return VaultLayout.acceptedTypes( this.relToProject( anyPath ), this.docRoot );
	}

	/** May a document declaring `declared` be written at this path? The write guard's one question. */
	accepts( anyPath: string, declared: ArtifactType ): boolean {
		return VaultLayout.accepts( this.relToProject( anyPath ), declared, this.docRoot );
	}

	/** Project-root-relative, forward-slashed — the currency both VaultLayout entry points take. */
	private relToProject( anyPath: string ): string {
		return path.relative( this.projectRoot, this.toAbs( anyPath ) ).replace( /\\/g, '/' );
	}

	/** Resolve a raw link href to an absolute path, against this vault's project root. */
	resolveHref( href: string ): string {
		return LensObject.resolveHref( href, this.projectRoot );
	}

	/**
	 * Is this vault-relative path part of the LIBRARY — i.e. a governed artifact rather than scratch?
	 *
	 * `VaultLayout` already marks six directories `indexed: false` and calls them, in its own words,
	 * "scratch and output space, not a gap". Validation has never honoured that: `scan()` walks the
	 * whole root, so backups, work notes, and `.js` dev utilities were all graded as KCD documents.
	 * That accounted for roughly half of every issue this vault has ever reported. Reported drift in
	 * a frozen backup is not drift; it is a category error.
	 */
	isLibraryPath( relPath: string ): boolean {
		return !VaultLayout.isEphemeralHref( relPath );
	}

	/** Is anything on disk at this href/address? A plain fact — never a verdict ( protocol §1.1 ). */
	exists( href: string ): boolean {
		return fs.existsSync( this.resolveHref( href ) );
	}

	/** A scanned file → its ArtifactRef ( vault-relative path + type + display name ). */
	toRef( file: ScannedFile ): ArtifactRef {
		return {
			path: file.relativePath,
			type: this.classify( file.path ),
			name: typeof file.frontmatter[ 'name' ] === 'string'
				? file.frontmatter[ 'name' ] as string
				: path.basename( file.relativePath, '.html' ),
		};
	}

	// ── Disk ────────────────────────────────────────────────────────────────

	/** Scan the whole vault, returning every artifact file with parsed frontmatter and links. */
	scan(): ScannedFile[] {
		return scan( this.root );
	}

	/**
	 * How many artifacts this vault holds — a COUNT, not a scan.
	 *
	 * Walks the same `VaultLayout` indexed directories the real index walks and counts `.html` files
	 * without opening any of them. `scan()` parses frontmatter and links on every file, which is the
	 * right cost when you need the artifacts and far too much when you only need the number: this
	 * answers a landing card for EVERY registered project, including the ones that are not open and
	 * therefore have no in-memory index to ask.
	 *
	 * `nav-index.html` is excluded, matching the library chart — a navigation stub is scaffolding for
	 * the artifacts, not one of them, and counting it would inflate a fresh vault to look non-empty.
	 *
	 * Total: an unreadable directory is skipped, not thrown. A count is orientation, and a permission
	 * error on one folder should cost that folder's files, not the whole number.
	 */
	countArtifacts(): number {
		let total = 0;
		const walk = ( dir: string ): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync( dir, { withFileTypes: true } );
			} catch {
				return;
			}
			for ( const entry of entries ) {
				if ( entry.isDirectory() ) { walk( path.join( dir, entry.name ) ); continue; }
				const name = entry.name.toLowerCase();
				if ( !name.endsWith( '.html' ) || name === VaultLayout.NAV_INDEX_FILE ) continue;
				total += 1;
			}
		};
		for ( const dir of VaultLayout.indexedDirs() ) walk( path.join( this.root, dir ) );
		return total;
	}

	/** Scanned files whose vault-relative path matches a glob ( * within a segment, ** across ). */
	glob( pattern: string ): ScannedFile[] {
		return this.scan().filter( f => Glob.matches( f.relativePath, pattern ) );
	}

	/** Raw file content at a vault path ( HTML for artifacts ). */
	read( vaultRelative: string ): string {
		return fs.readFileSync( this.toAbs( vaultRelative ), 'utf-8' );
	}

	/** Write content to a vault path ( creating parent dirs ); returns the vault-relative path written. */
	write( vaultRelative: string, content: string ): string {
		const abs = this.toAbs( vaultRelative );
		fs.mkdirSync( path.dirname( abs ), { recursive: true } );
		fs.writeFileSync( abs, content, 'utf-8' );
		return this.toVaultRel( abs );
	}

	/** Dredge a lens from a vault path, with the real fs reader injected. */
	loadLens( vaultRelative: string, opts?: { depth?: number; eager?: boolean } ): LensObject {
		return loadLensFromDisk( this.toAbs( vaultRelative ), {
			projectRoot: this.projectRoot,
			depth:       opts?.depth,
			eager:       opts?.eager,
		} );
	}

	/** A lens NAME to its vault-relative path, via the `lenses/{name}/{name}.html` anatomy. A value that
	 *  already looks like a path ( carries a separator or an `.htm(l)` suffix ) is passed through as-is, so
	 *  callers can name a lens either way — including the flat, non-directory lenses like the base floor. */
	lensPath( nameOrPath: string ): string {
		if ( nameOrPath.includes( '/' ) || /\.html?$/i.test( nameOrPath ) ) return nameOrPath;
		return `lenses/${ nameOrPath }/${ nameOrPath }.html`;
	}

	// ── Agent construction ────────────────────────────────────────────────────

	/**
	 * Build a DUMB agent over the named lenses — the vault face's compile-ready container, and the reason
	 * a vault can compile context at all without Starmind's database behind it.
	 *
	 * It is dumb in the precise sense: a substrate for lenses and a bucket of behavior, with no persisted
	 * identity, no model, and no bound environment. From that point on it is an ordinary `Agent` and the
	 * whole assembly engine — slot resolution, care bands, band headings, the manifest — applies to it
	 * exactly as it does to an authored one. That is the point: one compiler, and the only difference
	 * between the two faces is what each can source.
	 *
	 * Deliberately NOT given: `toolDefs` and `memory`. A vault cannot know a host's live tool schemas or
	 * reach a memory store, and inventing either would be the dishonest-field problem in a new place. A
	 * lens's authored tool MODES still ride, because those are identity and travel with the lens.
	 *
	 * `model` is null on purpose ( see `Agent.model` ): this agent compiles context for delivery as CLI
	 * text or a tool result and never dispatches, so there is no model to name. The name is left to
	 * `Agent.create`, which takes it from the first AUTHORED lens — never the floor.
	 *
	 * This lives on `Vault` and not on `Agent` because an agent cannot construct itself: `Agent` is
	 * deliberately Node-free ( the renderer imports it ), while resolving a lens NAME to a dredged
	 * `LensObject` needs disk, path math, and the ( projectRoot, docRoot ) pair this facade already owns.
	 *
	 * Starmind does NOT route through here. Its agents come from database rows carrying identity and
	 * per-artifact override maps that a list of lens names cannot express; the two faces share the engine
	 * and the floor policy, not the constructor.
	 *
	 * Throws on an empty list or a name that resolves to nothing — an unresolvable lens is a caller error,
	 * not a degraded compile. A MISSING BASE LENS is different and is tolerated: a half-installed or
	 * hand-built vault still compiles, just without a floor.
	 */
	buildAgent( lensNames: string[] ): Agent {
		if ( !lensNames.length ) throw new Error( 'buildAgent requires at least one lens' );

		const lenses = lensNames.map( name => {
			const rel = this.lensPath( name );
			// Existence checked in the VAULT-ROOT path space `loadLens` uses ( via `toAbs` ) — NOT `exists`,
			// which resolves hrefs against the project root ( the `_Claude/`-prefixed link space ) and would
			// miss a lens sitting at its own vault-relative path.
			if ( !fs.existsSync( this.toAbs( rel ) ) )
				throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );
			// EAGER, matching every Starmind load path: sharing the engine is not enough, the faces have to
			// share the LOADER or they compile different objects from one lens ( see `eager` ).
			return this.loadLens( rel, { eager: true } );
		} );

		// The inheritance floor — ordering, idempotence, and missing-file tolerance all live in
		// `Agent.withFloor`, the ONE place either face spells the rule ( see it for why ).
		return Agent.create( {
			id:     Agent.VAULT_AGENT_ID,
			model:  null,
			lenses: Agent.withFloor( lenses, this.loadBaseLens() ),
		} );
	}

	/** The base lens, freshly dredged, or null when this vault has none ( half-installed / hand-built —
	 *  tolerated, not fatal ). FRESH every call, never cached: a `LensObject` carries mutable dredge state,
	 *  so a shared floor would leak one agent's toggles into every other agent wearing it. */
	loadBaseLens(): LensObject | null {
		if ( !fs.existsSync( this.toAbs( InstallManifest.BASE_LENS ) ) ) return null;
		return this.loadLens( InstallManifest.BASE_LENS, { eager: true } );
	}

	// ── Authoring / heal ──────────────────────────────────────────────────────

	/**
	 * Move ( or rename ) an artifact AND heal every inbound link so the graph never rots.
	 *
	 * Every referrer authors the target as a project-root-relative href ( `_Claude/...` ), so healing
	 * is a targeted swap of that one authored string in each referrer — keyed off the link's RESOLVED
	 * identity, not a text grep — which preserves the hand-authored formatting a full HtmlTree
	 * round-trip would normalize away. The HealPlan is computed first, then applied unless `dryRun`
	 * ( the approval seam ). On apply it rewrites each referrer, renames the file, and asserts the
	 * post-condition: no link may still resolve to the old path ( a residual throws — fail loud ).
	 */
	move( from: string, to: string, opts?: { dryRun?: boolean } ): HealPlan {
		const fromAbs = this.toAbs( from );
		const destAbs = this.toAbs( to );

		if ( !fs.existsSync( fromAbs ) ) throw new Error( `Cannot move: source "${ from }" does not exist` );
		if ( fs.existsSync( destAbs ) )  throw new Error( `Cannot move: destination "${ to }" already exists` );

		const newHref = `${ this.docRoot }/${ to }`.replace( /\\/g, '/' );
		const plan: HealPlan = { op: 'move', from, to, edits: this.inboundEdits( fromAbs, newHref ) };

		if ( opts?.dryRun ) return plan;

		for ( const edit of plan.edits ) this.rewriteHref( edit );
		fs.mkdirSync( path.dirname( destAbs ), { recursive: true } );
		fs.renameSync( fromAbs, destAbs );

		this.assertNoResidual( fromAbs, 'move' );
		return plan;
	}

	/**
	 * Every inbound link to `targetAbs`, as heal edits — the referrer, its exact authored href, and
	 * ( on a move ) the replacement. Matches on RESOLVED identity, so an href authored in any relative
	 * form still counts; skips the target's own file.
	 */
	inboundEdits( targetAbs: string, newHref?: string ): HealEdit[] {
		const edits: HealEdit[] = [];
		for ( const f of this.scan() ) {
			if ( f.path === targetAbs ) continue;
			for ( const link of f.rawLinks ) {
				if ( this.resolveHref( link.href ) !== targetAbs ) continue;
				edits.push( { file: f.relativePath, oldHref: link.href, newHref } );
			}
		}
		return edits;
	}

	/**
	 * Apply one move edit to disk — swap the authored old href for the new one in the referrer, in
	 * both HTML ( `href="…"` / `href='…'` ) and `.js` comment ( `[text](…)` ) forms. Literal replace of
	 * every occurrence ( split/join, never a regex — a path with metacharacters is safe ). A no-op
	 * ( nothing matched ) is left for assertNoResidual to catch rather than silently swallowed.
	 */
	rewriteHref( edit: HealEdit ): void {
		if ( edit.newHref === undefined ) return;
		const abs    = this.toAbs( edit.file );
		const before = fs.readFileSync( abs, 'utf-8' );
		const after  = before
			.split( `href="${ edit.oldHref }"` ).join( `href="${ edit.newHref }"` )
			.split( `href='${ edit.oldHref }'` ).join( `href='${ edit.newHref }'` )
			.split( `](${ edit.oldHref })` ).join( `](${ edit.newHref })` );
		if ( after !== before ) fs.writeFileSync( abs, after, 'utf-8' );
	}

	/**
	 * Post-condition guard: after an apply, NO link in the vault may still resolve to the old path.
	 * A residual means a reference form the healer did not cover ( e.g. an href authored in a shape the
	 * swap did not match ) — throw rather than leave the graph rotted.
	 */
	assertNoResidual( targetAbs: string, op: string ): void {
		const residual = this.inboundEdits( targetAbs );
		if ( residual.length === 0 ) return;
		const where = residual.map( e => e.file ).join( ', ' );
		throw new Error(
			`${ op } heal incomplete: ${ residual.length } link(s) still resolve to "${ this.toVaultRel( targetAbs ) }" ( in ${ where } )`
		);
	}

	/**
	 * Delete an artifact AND cascade the removal through every referrer, so the graph stays viable.
	 *
	 * BLOCKS ( nothing deleted ) if anything references the target by IDENTITY — a `base`/`lens` slug
	 * naming it. An identity ref survives a move and is not a movable link; silently unparenting the
	 * dependents would be wrong, so the caller repoints or renames them first. Otherwise every inbound
	 * href reference is EXCISED from its referrer: a slot-field link takes its whole data-kcd-slot record,
	 * a bare prose `<a>` unwraps to its text — span-precise ( KcdExcise ), so formatting elsewhere is
	 * untouched. Computes the HealPlan first ( `dryRun` = preview ), then applies, removes the file, and
	 * asserts no link still resolves to it ( a residual throws — fail loud ).
	 */
	delete( target: string, opts?: { dryRun?: boolean } ): HealPlan {
		const targetAbs = this.toAbs( target );
		if ( !fs.existsSync( targetAbs ) ) throw new Error( `Cannot delete: "${ target }" does not exist` );

		const dependents = this.identityDependents( targetAbs );
		if ( dependents.length > 0 )
			throw new Error(
				`Cannot delete "${ target }": ${ dependents.length } artifact(s) reference it by identity ( ${ dependents.join( ', ' ) } ) — repoint or rename those first`
			);

		const plan: HealPlan = { op: 'delete', from: target, edits: this.inboundEdits( targetAbs ) };
		if ( opts?.dryRun ) return plan;

		this.exciseReferrers( plan.edits, targetAbs );
		fs.rmSync( targetAbs );

		this.assertNoResidual( targetAbs, 'delete' );
		return plan;
	}

	/** Artifacts that reference `targetAbs` by IDENTITY — a `base` or `lens` frontmatter field naming it.
	 *  These block a delete ( unlike href links, which heal ). Returns their vault-relative paths.
	 *
	 *  `lens` is a LIST ( the lenses a session wore, in invocation order ), so naming the target ANYWHERE
	 *  in that list counts — a plan authored under three lenses depends on all three. `base` stays a
	 *  scalar slug. Both shapes are read through `names()` so a hand-edited document that still carries
	 *  the retired scalar form is matched rather than silently skipped. */
	identityDependents( targetAbs: string ): string[] {
		const files  = this.scan();
		const target = files.find( f => f.path === targetAbs );
		const name   = target && typeof target.frontmatter[ 'name' ] === 'string' ? target.frontmatter[ 'name' ] as string : '';
		if ( !name ) return [];

		/** A frontmatter field's values as a flat list, whether it holds a scalar or a list. */
		const names = ( value: unknown ): string[] =>
			Array.isArray( value ) ? value.map( String ) : typeof value === 'string' ? [ value ] : [];

		const out: string[] = [];
		for ( const f of files ) {
			if ( f.path === targetAbs ) continue;
			const identities = [ ...names( f.frontmatter[ 'base' ] ), ...names( f.frontmatter[ 'lens' ] ) ];
			if ( identities.includes( name ) ) out.push( f.relativePath );
		}
		return out;
	}

	/** Excise every deleted-target reference from its referrers — one parse+splice per file ( a file may
	 *  hold several ), routed to the HTML or `.js` surgeon by extension, matched on resolved identity. */
	exciseReferrers( edits: HealEdit[], targetAbs: string ): void {
		const matches = ( href: string ): boolean => this.resolveHref( href ) === targetAbs;
		for ( const file of new Set( edits.map( e => e.file ) ) ) {
			const abs    = this.toAbs( file );
			const before = fs.readFileSync( abs, 'utf-8' );
			const after  = abs.endsWith( '.js' ) ? KcdExcise.js( before, matches ) : KcdExcise.html( before, matches );
			if ( after !== before ) fs.writeFileSync( abs, after, 'utf-8' );
		}
	}

	// ── Reference integrity ────────────────────────────────────────────────────

	/**
	 * Reference-integrity findings across the vault ( or one file, when `onlyFile` is given ) — the
	 * hygiene half of health, complementing the per-file structural typeCheck:
	 *
	 *   • Dangling links — an internal link href whose target does not exist on disk. Code-file links
	 *     count ( a lens Know table legitimately points at `.ts` ); external URLs, `#anchors`, and
	 *     `{placeholder}` template hrefs are skipped.
	 *   • Broken identity refs — a `base` / `lens` slug that names no artifact in the vault. The `cross`
	 *     sentinel ( a multi-lens plan's `lens` ) is not a reference and is skipped.
	 *
	 * All findings are `warn`: advisory, never a parse-blocking error. `names` is built from the whole
	 * scan even when scoped to one file, so a scoped identity ref still resolves against the full vault.
	 */
	referenceIssues( onlyFile?: string ): RefIssue[] {
		const files   = this.scan();
		const names   = new Set( files.map( f => typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '' ) );
		// Only the LIBRARY is graded. A named file is always checked ( the caller asked for it ); a
		// whole-vault sweep skips scratch space per the registry.
		const targets = onlyFile
			? files.filter( f => f.path === this.toAbs( onlyFile ) )
			: files.filter( f => this.isLibraryPath( f.relativePath ) );
		const issues: RefIssue[] = [];

		for ( const f of targets ) {
			for ( const link of f.rawLinks ) {
				const href = link.href;
				if ( href.startsWith( '#' ) || href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) continue;
				if ( href.includes( '{' ) ) continue;
				if ( !fs.existsSync( this.resolveHref( href ) ) )
					issues.push( { path: f.relativePath, severity: 'warn', message: `link target missing on disk: "${ href }"`, ref: href } );
			}

			// NOTE: addresses are deliberately absent from this loop. An address carries no `href`, so it
			// never enters `rawLinks` and is never probed — protocol §1.1. Vacancy is a legal state; see
			// `vacantAddresses` for the on-request report.

			for ( const key of [ 'base', 'lens' ] ) {
				const v = f.frontmatter[ key ];
				if ( typeof v !== 'string' || v === '' || v === 'cross' ) continue;
				if ( !names.has( v ) )
					issues.push( { path: f.relativePath, severity: 'warn', message: `${ key } "${ v }" names no artifact in the vault`, ref: v } );
			}
		}
		return issues;
	}

	/**
	 * Which addresses in the vault are currently VACANT — nothing occupies them yet.
	 *
	 * Deliberately NOT part of `referenceIssues`, and deliberately not an issue of any severity
	 * ( protocol §1.1, rule 3 ). A vacant address is a legal state; surfacing it in the health stream
	 * would recreate exactly the noise the address primitive was introduced to remove. This is an
	 * on-request inventory for someone who wants to know what has been promised and not yet written —
	 * a to-do list, not a defect list.
	 *
	 * An address resolves either as an artifact NAME ( through the same name index `base`/`lens` use,
	 * so it survives a move ) or as a project-root-relative PATH.
	 */
	vacantAddresses( onlyFile?: string ): { path: string; address: string; text: string }[] {
		const files = this.scan();
		const names = new Set( files
			.map( f => typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '' )
			.filter( n => n !== '' ) );

		const targets = onlyFile ? files.filter( f => f.path === this.toAbs( onlyFile ) ) : files;
		const out: { path: string; address: string; text: string }[] = [];

		for ( const f of targets ) {
			for ( const a of f.rawAddresses ?? [] ) {
				if ( names.has( a.value ) ) continue;                       // occupied — an artifact answers to it
				if ( fs.existsSync( this.resolveHref( a.value ) ) ) continue; // occupied — a file sits there
				out.push( { path: f.relativePath, address: a.value, text: a.text } );
			}
		}
		return out;
	}

}
