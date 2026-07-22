import * as fs from 'fs';
import * as path from 'path';
import { LensObject, Glob, KcdExcise, VaultLayout } from '../core';
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
/** Navigation stubs, not artifacts — excluded from `countArtifacts`, same as the library chart. */
const NAV_INDEX_FILE = 'nav-index.html';

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
		return path.isAbsolute( vaultRelative )
			? path.normalize( vaultRelative )
			: path.resolve( this.root, vaultRelative );
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
				if ( !name.endsWith( '.html' ) || name === NAV_INDEX_FILE ) continue;
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

	/** Artifacts that reference `targetAbs` by IDENTITY — a `base` or `lens` frontmatter slug naming it.
	 *  These block a delete ( unlike href links, which heal ). Returns their vault-relative paths. */
	identityDependents( targetAbs: string ): string[] {
		const files  = this.scan();
		const target = files.find( f => f.path === targetAbs );
		const name   = target && typeof target.frontmatter[ 'name' ] === 'string' ? target.frontmatter[ 'name' ] as string : '';
		if ( !name ) return [];

		const out: string[] = [];
		for ( const f of files ) {
			if ( f.path === targetAbs ) continue;
			if ( f.frontmatter[ 'base' ] === name || f.frontmatter[ 'lens' ] === name ) out.push( f.relativePath );
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
