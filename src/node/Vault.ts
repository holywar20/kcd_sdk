import * as fs from 'fs';
import * as path from 'path';
import { LensObject, Glob, KcdExcise, VaultLayout, Agent, KcdEmit, KcdValidate } from '../core';
import type { ArtifactRef, ArtifactType } from '../core';
import { scan, scanReport } from '../scanner';
import type { ScannedFile, ScanReport } from '../scanner';
import { inferProjectRoot, loadLensFromDisk } from './io';

/** One (referrer, authored href) swap, not one occurrence: `rewriteHref` replaces every occurrence in that file.
 *  `untouched` marks a reference the heal deliberately left alone, and why. */
export interface HealEdit {
	file:       string;
	oldHref:    string;
	newHref?:   string;
	untouched?: 'quoted' | 'not-excisable';
}

/** The three buckets of a heal's raw findings; `move` and `delete` compose them differently, so they stay apart. */
export interface HealFindings {
	/** Graph pass: a link read from a parsed artifact, matched on resolved identity. The only bucket a delete can excise. */
	graph:  HealEdit[];
	/** Text pass: a reference position in raw bytes, rewritable by literal swap. Disjoint from `graph`. */
	text:   HealEdit[];
	/** Text pass: quoted speech, such as code or fence content. Reported, never rewritten: a blind sweep would edit the lesson. */
	quoted: HealEdit[];
}

/** A move or delete's full effect, computed before disk is touched. `edits` and `reported` stay separate, so an
 *  empty `edits` never reads as "I could not see what points here". */
export interface HealPlan {
	op:       'move' | 'delete';
	from:     string;
	to?:      string;
	edits:    HealEdit[];
	reported: HealEdit[];
}

/** A dangling link or identity ref. Advisory (`warn`), unlike the structural errors that block. */
export interface RefIssue {
	path:     string;
	/** `warn` is an ordinary dangling link. `error` is a WRONG-VAULT reference, pointing into a different vault
	 *  rather than at something missing. */
	severity: 'warn' | 'error';
	message:  string;
	ref:      string;
}

/**
 * A KCD document store bound to one (projectRoot, docRoot) pair: the single facade for path math, classification,
 * scanning, glob and disk I/O. Node-side only; the renderer receives serialized artifacts and never needs one.
 */
export class Vault {

	/** Absolute vault root — projectRoot/docRoot, resolved once. */
	readonly root: string;

	/**
	 * Slug-typed frontmatter fields naming another artifact. `name` is a document's own identity and `habit-class` a group,
	 * so both are out; `scope` embeds a lens in a compound enum, a known gap. `renameIdentity` reaches `origin` on purpose.
	 */
	static readonly IDENTITY_FIELDS: readonly string[] = Object.entries( KcdValidate.FRONTMATTER )
		.filter( ( [ key, spec ] ) => key !== 'name' && key !== 'habit-class'
			&& ( spec.type === 'slug' || ( spec.type === 'list' && spec.itemType === 'slug' ) ) )
		.map( ( [ key ] ) => key );

	/** `_Claude` is only a default. A consumer writing a vault-rooted href reads `docRoot`, never assumes it. */
	constructor( readonly projectRoot: string, readonly docRoot: string = LensObject.DEFAULT_DOC_ROOT ) {
		this.root = path.resolve( path.join( projectRoot, docRoot ) );
	}

	/** Build a Vault by walking up from a start path until an ancestor holds the doc root. */
	static infer( startPath: string, docRoot: string = LensObject.DEFAULT_DOC_ROOT ): Vault {
		return new Vault( inferProjectRoot( startPath, docRoot ), docRoot );
	}

	// ── Path math ───────────────────────────────────────────────────────────

	/** Vault-relative to absolute under the vault root. Absolute inputs pass through, and `isInside` still rejects strays. */
	toAbs( vaultRelative: string ): string {
		if ( path.isAbsolute( vaultRelative ) ) return path.normalize( vaultRelative );
		return path.resolve( this.root, this._stripDocRoot( vaultRelative ) );
	}

	/** Accepts the doc-root segment where a vault-relative path is expected: an href is root-relative, a tool argument is
	 *  vault-relative. Trades away a genuine `_Claude/_Claude/…`, a nested doc root that should not exist. */
	private _stripDocRoot( rel: string ): string {
		const fwd  = rel.replace( /\\/g, '/' ).replace( /^\.?\//, '' );
		const lead = this.docRoot.replace( /\\/g, '/' ).replace( /\/+$/, '' ) + '/';
		return fwd.startsWith( lead ) ? fwd.slice( lead.length ) : fwd;
	}

	/** Vault-relative path with forward slashes on every platform: it is a wire format, and `path.relative` gave one document two spellings on Windows. */
	toVaultRel( anyPath: string ): string {
		return path.relative( this.root, this.toAbs( anyPath ) ).replace( /\\/g, '/' );
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
	 * Is this path GRADED by an unscoped sweep? Ephemeral space (`indexed: false`) is neither graded nor legal to link into (§1.1).
	 * Archival space is not graded either: its standard moved on after it retired. Unindexed does not mean disposable.
	 */
	isLibraryPath( relPath: string ): boolean {
		return !VaultLayout.isEphemeralHref( relPath ) && !VaultLayout.isArchivalPath( relPath );
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
		return scan( this.root, this.docRoot );
	}

	/** The same scan, also carrying the paths it could not parse, so a reader can tell "no such document" from "unreadable". */
	scanReport(): ScanReport {
		return scanReport( this.root, this.docRoot );
	}

	/**
	 * Counts artifacts in the indexed directories without parsing any of them. `nav-index.html` is scaffolding, not an artifact, and is excluded.
	 * Total: an unreadable directory costs its own files, not the count.
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

	/**
	 * Every `.html` artifact path, vault-relative, read without opening any file. Unlike `scan()` it keeps the unparseable ones,
	 * since failing to parse is the defect. Walks the vault root's own files and the indexed directories, never the ephemeral ones.
	 */
	documentPaths(): string[] {
		const out: string[] = [];
		const walk = ( dir: string, recurse: boolean ): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync( dir, { withFileTypes: true } );
			} catch {
				return;
			}
			for ( const entry of entries ) {
				const full = path.join( dir, entry.name );
				if ( entry.isDirectory() ) { if ( recurse ) walk( full, true ); continue; }
				if ( !/\.html?$/i.test( entry.name ) ) continue;
				out.push( this.toVaultRel( full ) );
			}
		};
		walk( this.root, false );
		for ( const dir of VaultLayout.indexedDirs() ) walk( path.join( this.root, dir ), true );
		return out;
	}

	/** Scanned files whose vault-relative path matches a glob ( * within a segment, ** across ). */
	glob( pattern: string ): ScannedFile[] {
		return this.scan().filter( f => Glob.matches( f.relativePath, pattern ) );
	}

	/** Raw file content at a vault path ( HTML for artifacts ). */
	read( vaultRelative: string ): string {
		return fs.readFileSync( this.toAbs( vaultRelative ), 'utf-8' );
	}

	/** Write content, creating parent dirs; returns the vault-relative path. `exclusive` is an atomic create that throws `EEXIST`,
	 *  so two writers racing for one name cannot both land. */
	write( vaultRelative: string, content: string, opts: { exclusive?: boolean } = {} ): string {
		const abs = this.toAbs( vaultRelative );
		fs.mkdirSync( path.dirname( abs ), { recursive: true } );
		fs.writeFileSync( abs, content, { encoding: 'utf-8', flag: opts.exclusive ? 'wx' : 'w' } );
		return this.toVaultRel( abs );
	}

	/** Dredge a lens from a vault path, with the real fs reader injected. */
	loadLens( vaultRelative: string, opts?: { depth?: number; eager?: boolean } ): LensObject {
		return loadLensFromDisk( this.toAbs( vaultRelative ), {
			projectRoot: this.projectRoot,
			docRoot:     this.docRoot,
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
	 * A dumb agent over the named lenses: no persisted identity, model or environment, so `toolDefs` and `memory` stay unset.
	 * It lives on `Vault`, not `Agent`, which the renderer imports and so stays Node-free. Starmind does not route through here.
	 * Throws on an empty list or an unresolvable name: that is a caller error, not a degraded compile.
	 */
	buildAgent( lensNames: string[] ): Agent {
		if ( !lensNames.length ) throw new Error( 'buildAgent requires at least one lens' );

		const lenses = lensNames.map( name => {
			const rel = this.lensPath( name );
			// Checked in the vault-root space `loadLens` uses, not `exists`, which resolves against the project root.
			if ( !fs.existsSync( this.toAbs( rel ) ) )
				throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );
			// Eager, like every Starmind load path: the two faces must share the loader, or they compile different objects from one lens.
			return this.loadLens( rel, { eager: true } );
		} );

		return Agent.create( { id: Agent.VAULT_AGENT_ID, model: null, lenses } );
	}

	// ── Authoring / heal ──────────────────────────────────────────────────────

	/**
	 * Move or rename an artifact and heal every inbound link. Referrers come from both passes; a dry run returns the plan unapplied.
	 * Quoted speech is never rewritten, so it can never be a residual; a residual rewritable reference throws.
	 */
	move( from: string, to: string, opts?: { dryRun?: boolean } ): HealPlan {
		const fromAbs = this.toAbs( from );
		const destAbs = this.toAbs( to );

		// These strings surface verbatim as tool errors, so each names the next step, not just the fault.
		if ( !fs.existsSync( fromAbs ) )
			throw new Error( `Cannot move: source "${ from }" does not exist — paths are vault-relative to "${ this.root }"; find the real one with a query before moving it` );
		if ( fs.existsSync( destAbs ) )
			throw new Error( `Cannot move: destination "${ to }" already exists — this never overwrites; pick a free path, or delete the occupant first` );

		const newHref = `${ this.docRoot }/${ to }`.replace( /\\/g, '/' );
		const found   = this.healOccurrences( fromAbs, newHref );
		const plan: HealPlan = {
			op: 'move', from, to,
			edits:    [ ...found.graph, ...found.text ],
			reported: found.quoted,
		};

		if ( opts?.dryRun ) return plan;

		// Captured before disk changes. A destination slug that differs from the current `name` is a rename of identity.
		const fromName = this._frontmatterNameAt( fromAbs );
		const toName    = path.basename( to ).replace( /\.html?$/i, '' );

		for ( const edit of plan.edits ) this.rewriteHref( edit );
		fs.mkdirSync( path.dirname( destAbs ), { recursive: true } );
		fs.renameSync( fromAbs, destAbs );
		this.restampStylesheet( to );

		if ( fromName && fromName !== toName ) this._renameIdentity( fromName, toName, destAbs );

		const after = this.healOccurrences( fromAbs );
		this.assertNoResidual( fromAbs, 'move', [ ...after.graph, ...after.text ] );
		return plan;
	}

	/**
	 * Re-points a moved document's own stylesheet link at its new depth: a §8.1 link is depth-relative, and a move changes depth.
	 * Best-effort, since a cosmetic link never fails the move. Depth is computed in exactly one place, `KcdEmit`; do not add a second.
	 */
	private restampStylesheet( toRel: string ): void {
		// ONE MATCHER — see `KcdEmit.stylesheetLink`, which owns the form and is shared with the emitter.
		try {
			const destAbs = this.toAbs( toRel );
			const raw     = fs.readFileSync( destAbs, 'utf8' );
			const link    = KcdEmit.stylesheetLink( raw );
			if ( !link || link.href === null ) return;

			const target = KcdEmit.cssTargetFrom( link.href );
			if ( target === null ) return;

			const newHref = KcdEmit.cssHrefFor( toRel, target );
			if ( newHref === link.href ) return;

			const rebuilt = link.tag.replace( link.href, newHref );
			fs.writeFileSync(
				destAbs,
				raw.slice( 0, link.index ) + rebuilt + raw.slice( link.index + link.tag.length ),
				'utf8'
			);
		} catch {
			// Swallowed on purpose: the move has already happened and the graph is healed by the time this runs.
		}
	}

	/** Every inbound link to `targetAbs` as heal edits, matched on resolved identity so any relative authoring still counts. */
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

	// ── Heal by canonical path ( the TEXT pass ) ──────────────────────────────

	/**
	 * Project-root files a heal reaches outside the vault, named one by one: the artifact scan never sees markdown.
	 * Never a project walk, since a heal that rewrites arbitrary files is a blast radius nobody asked for.
	 */
	static readonly HOST_ENTRY_FILES: readonly string[] = [ 'CLAUDE.md' ];

	/**
	 * Only `logs/{lens}/todo/` is swept, since a live todo routes work. Other logs are dated history, and rewriting a path
	 * inside one makes the entry less true. A whitelist: a new log folder stays out until somebody rules it in.
	 */
	static readonly LOGS_DIR           = 'logs';
	static readonly HEALED_LOG_SUBDIR  = 'todo';

	/** The reference positions the text pass recognizes: an attribute href, an address, or a markdown link target. A bare path
	 *  in prose is a mention, not a reference. A source string, since a shared `/g` regex keeps `lastIndex`. */
	private static readonly REFERENCE_POSITION =
		'(?:href|data-kcd-address)\\s*=\\s*"([^"]*)"' +
		'|(?:href|data-kcd-address)\\s*=\\s*\'([^\']*)\'' +
		'|\\]\\(([^)\\s]+)\\)';

	/** `logs/{lens}/todo` directories that exist on disk — see `HEALED_LOG_SUBDIR` for the ruling. */
	private healedLogDirs(): string[] {
		const base = path.join( this.root, Vault.LOGS_DIR );
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync( base, { withFileTypes: true } );
		} catch {
			return [];
		}
		return entries
			.filter( e => e.isDirectory() )
			.map( e => path.join( base, e.name, Vault.HEALED_LOG_SUBDIR ) )
			.filter( d => fs.existsSync( d ) );
	}

	/** Every file the text sweep opens: the indexed library in raw form, `.md`, `.js`, ruled-in todos and the host entry files.
	 *  Ephemeral space and archival records are not swept, each ruled out by name. */
	healSweepFiles(): string[] {
		const out: string[] = [];
		const walk = ( dir: string ): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync( dir, { withFileTypes: true } );
			} catch {
				return;
			}
			for ( const entry of entries ) {
				const full = path.join( dir, entry.name );
				if ( entry.isDirectory() ) { walk( full ); continue; }
				if ( !/\.(html?|md|js)$/i.test( entry.name ) ) continue;
				out.push( this.toVaultRel( full ) );
			}
		};

		for ( const dir of VaultLayout.indexedDirs() ) walk( path.join( this.root, dir ) );
		for ( const dir of this.healedLogDirs() ) walk( dir );

		for ( const name of Vault.HOST_ENTRY_FILES ) {
			const abs = path.join( this.projectRoot, name );
			if ( fs.existsSync( abs ) ) out.push( this.toVaultRel( abs ) );
		}
		return out;
	}

	/** Is the occurrence at `at` quoted speech (inside `<code>`, `<pre>`, a fence or a backtick span) rather than a live reference?
	 *  A blind sweep would edit the lesson the corpus teaches agents, so quoted speech is never rewritten. */
	private static isQuoted( text: string, at: number, markdown: boolean ): boolean {
		if ( markdown ) {
			const fences = text.slice( 0, at ).match( /```/g );
			if ( fences && fences.length % 2 === 1 ) return true;
			const lineStart = text.lastIndexOf( '\n', at ) + 1;
			const ticks     = text.slice( lineStart, at ).match( /`/g );
			return !!ticks && ticks.length % 2 === 1;
		}
		return Vault.insideElementText( text, at, 'code' ) || Vault.insideElementText( text, at, 'pre' );
	}

	/** Is `at` inside a `<tag>`'s text content, past its opening `>`? Not merely within the element: `data-kcd-address`
	 *  is an attribute of `<code>`, and a whole-element test would heal none of the addresses. */
	private static insideElementText( text: string, at: number, tag: string ): boolean {
		const open  = text.lastIndexOf( `<${ tag }`,  at );
		const close = text.lastIndexOf( `</${ tag }`, at );
		if ( open < 0 || close > open ) return false;
		const gt = text.indexOf( '>', open );
		return gt >= 0 && gt < at;
	}

	/** Stable identity for one reference — referrer plus the exact authored string, which is what a
	 *  rewrite keys off. Used to keep the graph and text passes disjoint. */
	private static editKey( e: HealEdit ): string {
		return `${ e.file }\u0000${ e.oldHref }`;
	}

	/**
	 * Every reference to `targetAbs` in three disjoint buckets. The graph and text passes both run, since neither is a superset;
	 * the graph wins an overlap. No annotation marks a reference: the canonical path is the marker.
	 */
	healOccurrences( targetAbs: string, newHref?: string ): HealFindings {
		// De-duplicated by (referrer, authored href): that pair is one swap, since `rewriteHref` replaces every occurrence.
		const seen  = new Set<string>();
		const graph = this.inboundEdits( targetAbs, newHref ).filter( e => {
			const key = Vault.editKey( e );
			if ( seen.has( key ) ) return false;
			seen.add( key );
			return true;
		} );

		const text: HealEdit[]   = [];
		const quoted: HealEdit[] = [];

		for ( const file of this.healSweepFiles() ) {
			const abs = this.toAbs( file );
			if ( abs === targetAbs ) continue;

			let body: string;
			try {
				body = fs.readFileSync( abs, 'utf-8' );
			} catch {
				continue;
			}
			if ( !body.includes( this.docRoot ) ) continue;   // no vault reference of any kind in this file

			const markdown = /\.md$/i.test( abs );
			const re       = new RegExp( Vault.REFERENCE_POSITION, 'g' );

			for ( let m = re.exec( body ); m; m = re.exec( body ) ) {
				const href = m[ 1 ] ?? m[ 2 ] ?? m[ 3 ] ?? '';
				if ( !href || href.startsWith( '#' ) || href.startsWith( 'http' ) ) continue;
				if ( this.resolveHref( href ) !== targetAbs ) continue;

				const edit: HealEdit = { file, oldHref: href, newHref };
				if ( Vault.isQuoted( body, m.index, markdown ) ) { quoted.push( { ...edit, untouched: 'quoted' } ); continue; }
				if ( seen.has( Vault.editKey( edit ) ) ) continue;
				seen.add( Vault.editKey( edit ) );
				text.push( edit );
			}
		}

		return { graph, text, quoted: quoted.filter( q => !seen.has( Vault.editKey( q ) ) ) };
	}

	/**
	 * Swap the old authored href for the new one at every reference position in the referrer, by literal replace.
	 * A link asserts occupancy; an address asserts only a location, never validated (protocol §1.1), so it is repointed with its link.
	 * Known limit: the swap is whole-file, so a quoted sample of the same href in one referrer is rewritten too.
	 */
	rewriteHref( edit: HealEdit ): void {
		if ( edit.newHref === undefined ) return;
		const abs    = this.toAbs( edit.file );
		const before = fs.readFileSync( abs, 'utf-8' );
		const after  = before
			.split( `href="${ edit.oldHref }"` ).join( `href="${ edit.newHref }"` )
			.split( `href='${ edit.oldHref }'` ).join( `href='${ edit.newHref }'` )
			.split( `data-kcd-address="${ edit.oldHref }"` ).join( `data-kcd-address="${ edit.newHref }"` )
			.split( `data-kcd-address='${ edit.oldHref }'` ).join( `data-kcd-address='${ edit.newHref }'` )
			.split( `](${ edit.oldHref })` ).join( `](${ edit.newHref })` );
		if ( after !== before ) fs.writeFileSync( abs, after, 'utf-8' );
	}

	/**
	 * Post-condition: after an apply, no reference the heal claimed may still resolve to the old path; a residual throws.
	 * The caller passes the residual set: a move re-checks both passes, a delete (which excises only the graph) re-checks that alone.
	 */
	assertNoResidual( targetAbs: string, op: string, residual: HealEdit[] ): void {
		if ( residual.length === 0 ) return;
		const where = residual.map( e => e.file ).join( ', ' );
		throw new Error(
			`${ op } heal incomplete: ${ residual.length } link(s) still resolve to "${ this.toVaultRel( targetAbs ) }" ( in ${ where } )`
		);
	}

	/**
	 * Delete an artifact and excise its referrers from the graph. Blocks, deleting nothing, while any artifact names it by identity:
	 * an identity ref survives a move, so dependents are repointed first, never silently unparented.
	 */
	delete( target: string, opts?: { dryRun?: boolean } ): HealPlan {
		const targetAbs = this.toAbs( target );
		if ( !fs.existsSync( targetAbs ) )
			throw new Error( `Cannot delete: "${ target }" does not exist — paths are vault-relative to "${ this.root }"; find the real one with a query before deleting it` );

		const dependents = this.identityDependents( targetAbs );
		if ( dependents.length > 0 )
			throw new Error(
				`Cannot delete "${ target }": ${ dependents.length } artifact(s) reference it by identity ( ${ dependents.join( ', ' ) } ) — repoint or rename those first`
			);

		// Text-pass references are reported, not excised: there is no span-precise removal from a sentence, so they will dangle.
		const found = this.healOccurrences( targetAbs );
		const plan: HealPlan = {
			op: 'delete', from: target,
			edits:    found.graph,
			reported: [ ...found.quoted, ...found.text.map( e => ( { ...e, untouched: 'not-excisable' as const } ) ) ],
		};
		if ( opts?.dryRun ) return plan;

		this.exciseReferrers( plan.edits, targetAbs );
		fs.rmSync( targetAbs );

		this.assertNoResidual( targetAbs, 'delete', this.healOccurrences( targetAbs ).graph );
		return plan;
	}

	/** Artifacts naming `targetAbs` by identity in `base` or `lens`, which block a delete. `lens` is a list, so any position counts.
	 *  Both shapes are read, so a hand-edited scalar `lens` is matched rather than skipped. */
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

	/** The document's current `name`, from a fresh scan and never cached: read before `move` renames anything, so it sees disk as it stands. */
	private _frontmatterNameAt( abs: string ): string {
		const f = this.scan().find( s => s.path === abs );
		return f && typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '';
	}

	/**
	 * A move that changes the slug renames identity: the moved document's `name`, and every other document's identity field naming
	 * the old slug. Exact-value match only, so `render-old` beside `render` is untouched. Best-effort per field, like `restampStylesheet`.
	 */
	private _renameIdentity( oldName: string, newName: string, movedAbs: string ): void {
		try {
			const self = fs.readFileSync( movedAbs, 'utf-8' );
			const next = this._rewriteIdentityField( self, 'name', oldName, newName );
			if ( next !== null ) fs.writeFileSync( movedAbs, next, 'utf-8' );
		} catch {
			// best-effort — see docblock
		}

		for ( const f of this.scan() ) {
			if ( f.path === movedAbs ) continue;
			let body: string;
			try {
				body = fs.readFileSync( f.path, 'utf-8' );
			} catch {
				continue;
			}
			let touched = false;
			for ( const field of Vault.IDENTITY_FIELDS ) {
				const next = this._rewriteIdentityField( body, field, oldName, newName );
				if ( next !== null ) { body = next; touched = true; }
			}
			if ( touched ) fs.writeFileSync( f.path, body, 'utf-8' );
		}
	}

	/**
	 * Rewrite one frontmatter field from `oldName` to `newName` in raw HTML, as a scalar `<dd>` or a `<li data-kcd-tag>` chip.
	 * Returns null when the field is absent or does not name `oldName`. Exact match in both shapes.
	 */
	private _rewriteIdentityField( html: string, field: string, oldName: string, newName: string ): string | null {
		const re = new RegExp( `(<dd[^>]*data-kcd-field="${ field }"[^>]*>)([\\s\\S]*?)(</dd>)` );
		const m  = re.exec( html );
		if ( !m ) return null;
		const [ whole, open, inner, close ] = m;

		let nextInner: string;
		if ( inner === oldName ) {
			nextInner = newName;
		} else {
			const chip = `>${ oldName }<`;
			if ( !inner.includes( chip ) ) return null;
			nextInner = inner.split( chip ).join( `>${ newName }<` );
		}
		if ( nextInner === inner ) return null;
		return html.split( whole ).join( open + nextInner + close );
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
	 * Dangling links and identity refs (`base`/`lens`) naming no artifact, both `warn`; `error` is a wrong-vault link or a duplicated id.
	 * Identity refs are read in both the string and list shapes. Known hole, left unfixed: `names` includes scratch `work/`, so a dead ref there looks alive.
	 */
	referenceIssues( onlyFile?: string ): RefIssue[] {
		const files   = this.scan();
		const names   = new Set( files.map( f => typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '' ) );
		const ids     = this._idsOf( files );
		// Only the library is graded in a whole-vault sweep; a named file is always checked.
		const targets = onlyFile
			? files.filter( f => f.path === this.toAbs( onlyFile ) )
			: files.filter( f => this.isLibraryPath( f.relativePath ) );
		const issues: RefIssue[] = [];

		for ( const f of targets ) {
			for ( const link of f.rawLinks ) {
				const href = link.href;
				if ( href.startsWith( '#' ) || href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) continue;
				if ( href.includes( '{' ) ) continue;
				if ( fs.existsSync( this.resolveHref( href ) ) ) continue;

				// A wrong-vault href is an error, not a dangling link. It is proven on disk: swapping the leading segment must resolve.
				const elsewhere = this._wrongVaultTarget( href );
				if ( elsewhere )
					issues.push( {
						path: f.relativePath, severity: 'error', ref: href,
						message: `wrong vault: "${ href }" names "${ href.split( '/' )[ 0 ] }", but this vault is "${ this.docRoot }" — the target exists at "${ elsewhere }"`
					} );
				else
					issues.push( { path: f.relativePath, severity: 'warn', message: `link target missing on disk: "${ href }"`, ref: href } );
			}

			// Addresses are absent by design: they never enter `rawLinks` and are never probed (§1.1), since vacancy is a legal state.
			// It is never reported as an issue; `vacantAddresses` is the on-request inventory.

			// `lens` is a list on most types and a bare string on a few. Both shapes are read: reading one graded almost nothing.
			for ( const key of [ 'base', 'lens' ] ) {
				const raw  = f.frontmatter[ key ];
				const refs = typeof raw === 'string' ? [ raw ]
				           : Array.isArray( raw )    ? raw.filter( ( r ): r is string => typeof r === 'string' )
				           : [];

				for ( const v of refs ) {
					// `cross` is a multi-lens plan's sentinel, not a reference. Skipped per member rather
					// than per field, so it is still skipped when it arrives inside a list.
					if ( v === '' || v === 'cross' ) continue;
					if ( names.has( v ) ) continue;

					// Warn, not error: the document still parses and `BrokenLens` degrades on purpose. The message carries the repair.
					issues.push( {
						path: f.relativePath, severity: 'warn', ref: v,
						message: `${ key } "${ v }" names no artifact in the vault — a renamed or retired `
						       + `${ key } leaves this reference behind, and nothing else reports it`
					} );
				}
			}

			// A duplicated id is an error: an agent names a lens by it, so two documents carrying one let a record resolve to either.
			const id = f.frontmatter[ 'id' ];
			if ( typeof id === 'string' && id !== '' ) {
				const others = ( ids.get( id ) ?? [] ).filter( p => p !== f.relativePath );
				if ( others.length )
					issues.push( { path: f.relativePath, severity: 'error', ref: id, message: `id "${ id }" is also carried by ${ others.map( p => `"${ p }"` ).join( ', ' ) } — every document's id must be its own` } );
			}
		}
		return issues;
	}

	/** Every library document's frontmatter id → the paths carrying it. LIBRARY ONLY: a scratch copy of a lens
	 *  under `work/` is not a second identity, it is a backup nobody resolves. */
	private _idsOf( files: ScannedFile[] ): Map<string, string[]> {
		const ids = new Map<string, string[]>();
		for ( const f of files ) {
			const id = f.frontmatter[ 'id' ];
			if ( typeof id !== 'string' || id === '' || !this.isLibraryPath( f.relativePath ) ) continue;
			ids.set( id, [ ...( ids.get( id ) ?? [] ), f.relativePath ] );
		}
		return ids;
	}

	/** The href with its leading segment swapped for this vault's name, if that resolves on disk; null otherwise. Narrow by design:
	 *  a project path, an asset or an unwritten target falls through to the ordinary warning. */
	private _wrongVaultTarget( href: string ): string | null {
		const parts = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' );
		if ( parts.length < 2 || parts[ 0 ] === '' || parts[ 0 ] === this.docRoot ) return null;

		const corrected = [ this.docRoot, ...parts.slice( 1 ) ].join( '/' );
		return fs.existsSync( this.resolveHref( corrected ) ) ? corrected : null;
	}

	/**
	 * Addresses promised but not yet written. Never part of `referenceIssues` and never an issue of any severity (protocol §1.1, rule 3):
	 * vacancy is a legal state, so this is an on-request to-do list. An address resolves by artifact name, or by project-relative path.
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
