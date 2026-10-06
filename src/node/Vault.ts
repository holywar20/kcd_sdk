import * as fs from 'fs';
import * as path from 'path';
import { LensObject, Glob, KcdExcise, VaultLayout, Agent, KcdEmit, KcdValidate } from '../core';
import type { ArtifactRef, ArtifactType } from '../core';
import { scan, scanReport } from '../scanner';
import type { ScannedFile, ScanReport } from '../scanner';
import { inferProjectRoot, loadLensFromDisk } from './io';

/**
 * One inbound reference a heal found. `file` is the referrer ( vault-relative, or `../CLAUDE.md` for a
 * host entry file at the project root ); `oldHref` is the EXACT authored href as written in that file
 * ( so the on-disk swap is precise ); `newHref` is its replacement on a move, or undefined on a delete
 * strip. `untouched` is set only on a reference the heal deliberately LEFT ALONE, and names why.
 *
 * ONE EDIT IS ONE ( referrer, authored href ) SWAP, not one occurrence. `rewriteHref` replaces every
 * occurrence of that string in that file, so a document naming the target six times is one edit — and
 * a heal plan's length is therefore a count of REFERRERS, which is the number a reader can act on.
 */
export interface HealEdit {
	file:       string;
	oldHref:    string;
	newHref?:   string;
	untouched?: 'quoted' | 'not-excisable';
}

/**
 * Every reference to one target a heal can see, in three buckets — the raw finding, before a caller
 * decides what to do with each. `move` and `delete` compose these differently, which is exactly why
 * they arrive separated rather than pre-merged.
 */
export interface HealFindings {
	/** From the GRAPH pass: a link read out of a PARSED artifact, matched on resolved identity. The
	 *  only bucket a delete can EXCISE, because excision is parse-and-splice. */
	graph:  HealEdit[];
	/** From the TEXT pass: a reference position in raw bytes ( `href=`, `data-kcd-address=`, markdown
	 *  `](…)` ). Rewritable by literal swap in any text file. Disjoint from `graph`. */
	text:   HealEdit[];
	/** From the TEXT pass: a QUOTED-SPEECH position — `<code>` / `<pre>` element content, a markdown
	 *  fence or inline span. Reported, never rewritten: the corpus teaches agents what to SAY, and a
	 *  blind sweep would edit the lesson. */
	quoted: HealEdit[];
}

/**
 * The full effect of a move/delete BEFORE it touches disk — the rename ( or removal ), every referrer
 * edit that keeps the graph viable, AND every reference deliberately left alone. Vault.move/delete
 * compute this first ( the preview ) and then apply it; that split is the seam a human-approval gate
 * slots into. Returned from the applied call too, so the caller sees exactly what changed.
 *
 * `edits` and `reported` are separate because collapsing them would rebuild the defect this plan
 * exists to fix: an `edits: []` that reads identically as *nothing pointed at this* and *I could not
 * see what pointed at this*. Every reference found lands in one array or the other, and a reference
 * in `reported` carries `untouched` saying why.
 */
export interface HealPlan {
	op:       'move' | 'delete';
	from:     string;
	to?:      string;
	edits:    HealEdit[];
	reported: HealEdit[];
}

/**
 * One reference-integrity finding — a link or identity ref that does not resolve. Advisory ( `warn` ):
 * distinct from the structural typeCheck errors that block. `path` is the referrer ( vault-relative );
 * `ref` is the offending href or slug. This is what keeps the "internal state always viable" invariant
 * observable between heals.
 */
export interface RefIssue {
	path:     string;
	/** `warn` for an ordinary dangling link — advisory, and often just a target not written yet.
	 *  `error` is reserved for a WRONG-VAULT reference, which is a different kind of fact: the
	 *  document is not pointing at something missing, it is pointing into a different vault. */
	severity: 'warn' | 'error';
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

	/**
	 * Frontmatter fields that name ANOTHER artifact by slug — derived from the schema's own
	 * slug-typed fields ( `KcdValidate.FRONTMATTER` ), not hand-listed. Two of that schema's slug
	 * fields are excluded by what they actually ARE rather than by convenience: `name` is a document's
	 * OWN identity, never a reference to another one, and `habit-class` names a shared mutual-
	 * exclusion GROUP rather than a specific document. `scope` ( contracts ) embeds a lens name inside
	 * a compound enum value ( `universal | lens:{name}` ) rather than carrying it as a bare slug or a
	 * slug-typed list, so a substring rewrite inside an enum pattern is a different repair shape than
	 * the ones below — named here as a known gap rather than silently matched.
	 *
	 * That leaves `base`, `lens` and `origin`: the two `identityDependents` / `referenceIssues` already
	 * treat as live cross-document references, plus `origin`'s crystallization-lineage slug, which
	 * neither of those two checks for dangling-ness today but which names a foreign document by the
	 * same convention. `renameIdentity`'s reach is therefore slightly WIDER than the two existing
	 * reads — a deliberate widening stated here rather than left for a reader to notice as a
	 * discrepancy between three places that all claim to enumerate "the identity fields".
	 */
	static readonly IDENTITY_FIELDS: readonly string[] = Object.entries( KcdValidate.FRONTMATTER )
		.filter( ( [ key, spec ] ) => key !== 'name' && key !== 'habit-class'
			&& ( spec.type === 'slug' || ( spec.type === 'list' && spec.itemType === 'slug' ) ) )
		.map( ( [ key ] ) => key );

	/**
	 * WHICH FOLDER THIS VAULT IS, readable. `_Claude` is a DEFAULT — the value when nobody declared
	 * one — never a fact about the system, and a consumer that needs to write a vault-rooted href
	 * ( `${ docRoot }/lenses/x.html` ) has to ask rather than assume. It was private, so three call
	 * sites in `VaultUtilities` kept a `DOC_ROOT_PREFIX = '_Claude'` of their own and emitted
	 * `_Claude/…` into every vault regardless of its real name.
	 */
	constructor( readonly projectRoot: string, readonly docRoot: string = LensObject.DEFAULT_DOC_ROOT ) {
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

	/**
	 * Absolute ( or vault-relative ) path → vault-relative path, for return payloads.
	 *
	 * Forward slashes on EVERY platform. A vault-relative path is a wire format — it travels in return
	 * payloads, crosses the bridge, reaches agents and lands in stored rows — so it gets one spelling.
	 * `path.relative` answers native separators, which gave the same document two spellings on Windows.
	 */
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
	 * Is this vault-relative path GRADED — held to the CURRENT document standard on a whole-vault sweep?
	 *
	 * Two exclusions, and they are not the same thing:
	 *
	 *   • EPHEMERAL ( `indexed: false` — work, logs, reports, audits, scratch, dev-utilities ). Not
	 *     installed into a user's vault at all, so it is neither graded nor legal to link into ( §1.1 ).
	 *     `scan()` walks the whole root, so before this gate existed backups, work notes and `.js` dev
	 *     utilities were all graded as KCD documents — roughly half of every issue this vault has ever
	 *     reported. Reported drift in a frozen backup is not drift; it is a category error.
	 *
	 *     UNINDEXED IS NOT THE SAME CLAIM AS DISPOSABLE, and this list reads as though it were
	 *     ( TASK-732, 2026-10-05 ). `ephemeralDirs()` derives ephemeral from `indexed`, so the two
	 *     travel together here — but *nothing validates links into here* and *this may be deleted at
	 *     will* are independent facts, and `audits/ledgers` wants the first and emphatically not the
	 *     second. Durability is now its own `durable` flag on the layout row, read through
	 *     `VaultLayout.isDurablePath`. So every directory named above is unindexed, and all of them
	 *     EXCEPT `audits/ledgers` are also disposable. Nothing on this grading axis changed.
	 *   • ARCHIVAL ( `archival: true` — `plans/plans_complete` ). The opposite on the shipping axis: it
	 *     DOES install, and live artifacts link to it for provenance, so it cannot be ephemeral without
	 *     making those links illegal. It stops being graded because the standard moved on after the
	 *     document was retired. Same category error, arrived at from the other direction.
	 *
	 * Naming a file explicitly still grades it — the caller asked for that file. This gate binds only
	 * the unscoped sweep, which is where a category error turns into noise nobody can act on.
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

	/**
	 * The same scan, carrying the paths it could not parse.
	 *
	 * For a reader that has to tell "no such document" from "a document that is there and unreadable".
	 * `scan()` cannot: the drop leaves no trace in its result, so every caller of it reports absence for
	 * both. Where `documentPaths()` gives a whole-vault sweep something to grade, this gives an ordinary
	 * READ the same honesty at no extra walk.
	 */
	scanReport(): ScanReport {
		return scanReport( this.root, this.docRoot );
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

	/**
	 * Every `.html` file under the indexed directories, as vault-relative paths — a RAW WALK that
	 * opens nothing.
	 *
	 * THE DIFFERENCE FROM `scan()` IS THE WHOLE POINT. `scan()` parses each file, so a document that
	 * fails to parse is DROPPED from its result — which is fine for a consumer that wants artifacts
	 * and wrong by construction for one that wants to REPORT ON or REPAIR them, because failing to be
	 * an artifact IS the defect. A health sweep built on `scan()` cannot see the file it most needs
	 * to: the malformed one is absent from the list, so the sweep returns clean and is not lying, it
	 * simply never looked. Verified live 2026-08-17 — an unparseable document did not appear in a
	 * whole-vault report at all, only in a per-path check.
	 *
	 * Unlike `countArtifacts`, `nav-index.html` is INCLUDED: a navigation stub is scaffolding rather
	 * than an artifact for counting purposes, but it is a real document that can be malformed, and a
	 * checker that skips it grades less than it claims to.
	 *
	 * THE VAULT ROOT IS WALKED TOO, and it was not until 2026-09-10. The walk covered the indexed
	 * DIRECTORIES only, and the root is not one of them — so every document sitting directly at the
	 * vault root was invisible to every whole-vault sweep ever run. That is not a marginal set: it is
	 * `root.html`, `root-context.html`, `kcd_framework.html` and the vault's own `nav-index.html` —
	 * the entry document an agent loads first, the seed source every host entry file is generated
	 * from, and the map a human opens first. The most-read documents in the vault were the only ones
	 * held to no standard, and the sweep reported clean over them. Measured: a root `nav-index.html`
	 * carrying six errors never appeared in a sweep of its own vault, and validated only when named.
	 *
	 * Root files ONLY — the root's subdirectories are not re-walked here. The indexed ones are
	 * covered by the loop below, and the rest are ephemeral space, which is deliberately not graded
	 * ( see `isLibraryPath` ). Walking the root recursively would grade `work/` and `logs/`, undoing
	 * that gate from the other side.
	 *
	 * Total, like the counter: an unreadable directory costs that directory's files, not the walk.
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

	/** Write content to a vault path ( creating parent dirs ); returns the vault-relative path written.
	 *  `exclusive` makes it a CREATE, refused by the open itself when the path exists ( throws `EEXIST` ) —
	 *  atomic, so two writers racing for one name cannot both land, which a prior existence check could not
	 *  promise. */
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
	 * `Agent.create`, which takes it from the primary lens.
	 *
	 * This lives on `Vault` and not on `Agent` because an agent cannot construct itself: `Agent` is
	 * deliberately Node-free ( the renderer imports it ), while resolving a lens NAME to a dredged
	 * `LensObject` needs disk, path math, and the ( projectRoot, docRoot ) pair this facade already owns.
	 *
	 * Starmind does NOT route through here. Its agents come from database rows carrying identity and
	 * per-artifact override maps that a list of lens names cannot express; the two faces share the engine,
	 * not the constructor. Nothing is stacked under the named lenses: there is no base lens.
	 *
	 * Throws on an empty list or a name that resolves to nothing — an unresolvable lens is a caller error,
	 * not a degraded compile.
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

		return Agent.create( { id: Agent.VAULT_AGENT_ID, model: null, lenses } );
	}

	// ── Authoring / heal ──────────────────────────────────────────────────────

	/**
	 * Move ( or rename ) an artifact AND heal every inbound link so the graph never rots.
	 *
	 * Every referrer authors the target as a project-root-relative href ( `_Claude/...` ), so healing
	 * is a targeted swap of that one authored string in each referrer, which preserves the
	 * hand-authored formatting a full HtmlTree round-trip would normalize away. Referrers come from
	 * BOTH passes ( `healOccurrences` ) — the parse graph and the raw byte sweep — because neither
	 * alone sees the whole corpus. The HealPlan is computed first, then applied unless `dryRun` ( the
	 * approval seam ). On apply it rewrites each referrer, renames the file, and asserts the
	 * post-condition: no rewritable reference may still resolve to the old path ( a residual throws —
	 * fail loud ). Quoted-speech occurrences are exempt from that post-condition by construction: they
	 * were never going to change, so they can never be a residual.
	 */
	move( from: string, to: string, opts?: { dryRun?: boolean } ): HealPlan {
		const fromAbs = this.toAbs( from );
		const destAbs = this.toAbs( to );

		// Both refusals name the NEXT MOVE, not just the fault. These strings surface verbatim as a tool's
		// error text, so whatever they omit is a round trip the caller pays to recover.
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

		// IDENTITY, captured before anything on disk changes. `toName` is the slug the one-per-type
		// anatomy implies for the destination ( `lenses/{name}/{name}.html` and its siblings ) — when it
		// differs from the moved document's CURRENT `name`, this move IS a rename of identity and not
		// merely of location, by the same convention every typed artifact in this corpus already follows.
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
	 * Re-point a moved document's OWN stylesheet link at its new depth.
	 *
	 * A move heals every link POINTING AT the document and, until this existed, nothing at all pointing
	 * OUT of it. The stylesheet href is depth-relative by protocol §8.1, so any move that changes
	 * directory depth left the moved file reaching past the vault for a file that is not there.
	 *
	 * IT FAILED SILENTLY, which is why it survived. The document still parses, `health` still returns
	 * zero issues, and the page still renders — on the Tier 1 inline baseline, so it looks merely plain
	 * rather than broken, and the one reader who would notice is a human opening it in a browser. Two
	 * instances were found the same day by doing exactly that, one of them a day old.
	 *
	 * The target is read back off the document rather than resolved from configuration. `Vault` has no
	 * `cssVaultRel` and should not grow one for this: the file already says what it points at, and a
	 * legacy vault keeping `kcd.css` under `kcd/` stays correct for free. Depth math stays in the one
	 * place that owns it — `cssHrefFor` and its inverse, both on `KcdEmit`.
	 *
	 * Best-effort by construction. A document with no link, an unparseable href, or an unwritable file
	 * leaves the move untouched: healing the graph is this operation's contract and a cosmetic link is
	 * not worth failing it over.
	 *
	 * THERE IS NO LONGER A CORPUS-SWEEP BACKSTOP BEHIND IT, and that is worth knowing before relying on
	 * this. `VaultUtilities.fixStylesheetLinks` swept the whole vault for the same repair and was deleted
	 * on 2026-10-05 ( TASK-730 ) as callerless — it had no call site and no test. So whatever this
	 * passes over stays unrepaired until something writes the document again; a document written through
	 * `save_doc` is born with both stylesheet tiers, which is what makes that acceptable.
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
			// Deliberately swallowed — see the best-effort note above. Nothing here can fail in a way that
			// should cost the caller a completed move: the file is already renamed and the graph is already
			// healed by the time this runs.
		}
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

	// ── Heal by canonical path ( the TEXT pass ) ──────────────────────────────

	/**
	 * Host entry files at the PROJECT root that a heal reaches — outside the vault, and named one by
	 * one rather than discovered by walking the project.
	 *
	 * `CLAUDE.md` is the first document every agent reads, it is markdown so the artifact scan never
	 * sees it, and its prose sits BELOW the `kcd:end` marker so the seeder cannot reach it either. It
	 * carried a dead architecture claim and three broken links for weeks while `validate_docs` reported
	 * 0 issues across 0 files and was correct, because it never looked.
	 *
	 * An explicit list, never a project walk: a heal that can rewrite arbitrary files outside the vault
	 * is a blast radius nobody asked for, and this is a move tool, not a refactorer.
	 */
	static readonly HOST_ENTRY_FILES: readonly string[] = [ 'CLAUDE.md' ];

	/**
	 * Ephemeral log space the text sweep is RULED into ( Bryan, 2026-08-17 ): `logs/{lens}/todo/` are
	 * live routing surfaces and the actual source of the pain — a todo pointing at a retired plan
	 * three days after a triage declared the repair held.
	 *
	 * Everything else under `logs/` is deliberately OUT. Those are historical records, and rewriting a
	 * path inside a dated entry makes the corpus more consistent and the entry less true. A WHITELIST, never a blacklist: a new log sub-folder is out of scope until somebody
	 * rules it in, which is the safe direction for a verb that writes.
	 */
	static readonly LOGS_DIR           = 'logs';
	static readonly HEALED_LOG_SUBDIR  = 'todo';

	/** Reference POSITIONS the text pass recognizes — an attribute href, an address, or a markdown
	 *  link target. Deliberately not "any occurrence of the path": a bare path in prose is a mention,
	 *  and rewriting a mention is editing somebody's sentence. Source string, not a literal, because a
	 *  `/g` regex carries `lastIndex` and a shared one would skip matches. */
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

	/**
	 * Every file the TEXT sweep opens — wider than the artifact graph on purpose, and narrower than
	 * "everything" on purpose.
	 *
	 * WIDER: the indexed library in raw form ( so a document that fails to PARSE is still repaired —
	 * the file most in need of it ), plus `.md` and `.js`, plus ruled-in todo space, plus the host
	 * entry files. NARROWER: it stops there. Ephemeral space other than todos, archival records, and
	 * the project tree at large are not swept, because each was ruled out by name rather than missed.
	 *
	 * Total, like every other walk here: an unreadable directory costs that directory's files, not
	 * the sweep.
	 */
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

	/**
	 * Is the occurrence at `at` QUOTED SPEECH rather than a live reference?
	 *
	 * 225 of this corpus's 1,555 `_Claude/` occurrences sit inside `<code>`, where the protocol
	 * deliberately puts quoted speech and flag templates — so a blind sweep would edit a habit that
	 * teaches an agent what to SAY. The discriminator is the protocol's own `<a>`-versus-`<code>` rule,
	 * applied to bytes rather than to a parse tree.
	 */
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

	/**
	 * Is `at` inside a `<tag>` element's TEXT CONTENT — as opposed to inside its opening tag?
	 *
	 * THE DISTINCTION IS THE WHOLE POINT and it is not pedantry. `data-kcd-address` is BY PROTOCOL an
	 * attribute of `<code>`, so a naive "the match sits within a code element" would classify every
	 * address in the corpus as quoted speech and heal none of them. What disqualifies a match is
	 * sitting PAST the opening tag's `>` — that is exactly where quoted speech begins.
	 */
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
	 * Every reference to `targetAbs` a heal can see, in three buckets — the GRAPH pass over parsed
	 * artifacts, and the TEXT pass over raw bytes.
	 *
	 * BOTH EXIST BECAUSE NEITHER IS A SUPERSET. The graph pass reads links out of a parsed artifact,
	 * so it reaches an href authored in any form — and reaches NOTHING in a file that fails to parse,
	 * is not an artifact at all ( markdown, `.js` ), or lives outside the indexed library. The text
	 * pass reaches exactly those, and only in the canonical vault-root-relative form the base lens
	 * mandates. Running one and calling it the answer is what produced `edits: []` on 2026-08-17 while
	 * two documents referenced the target — the Phase 2 defect appearing inside the repair tool.
	 *
	 * No annotation is added at ingest to make references findable, because THE PATH ALREADY IS THE
	 * MARKER: the base lens mandates exactly one form, so an occurrence is self-identifying. A
	 * `data-kcd-ref` attribute would rebuild the very defect it fixes — an unannotated hand-written
	 * link becomes invisible again, and *unmarked* would mean both *not a reference* and *nobody
	 * marked it*.
	 *
	 * The three buckets are DISJOINT, and the graph wins any overlap: a real `<a href>` that happens
	 * to sit inside a `<pre>` sample is still a link that renders and navigates.
	 */
	healOccurrences( targetAbs: string, newHref?: string ): HealFindings {
		// De-duplicated by ( referrer, authored href ), because that pair IS one swap — `rewriteHref`
		// replaces every occurrence of the string in the file. `inboundEdits` reports one entry per LINK,
		// so a document linking the target twice yielded two identical edits, the second a guaranteed
		// no-op inflating the count. The text pass never had them, and a plan whose two halves count
		// differently is a plan nobody can read.
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
	 * Apply one move edit to disk — swap the authored old href for the new one in the referrer, across
	 * every REFERENCE POSITION the text pass recognizes: an HTML `href` ( either quote ), a
	 * `data-kcd-address`, and a markdown / `.js`-comment `[text](…)`. Literal replace of every
	 * occurrence ( split/join, never a regex — a path with metacharacters is safe ). A no-op ( nothing
	 * matched ) is left for `assertNoResidual` to catch rather than silently swallowed.
	 *
	 * An ADDRESS is rewritten alongside a link even though the two are not the same claim — an address
	 * asserts a LOCATION and is never validated for occupancy ( protocol §1.1 ). Repointing it keeps
	 * the location it names true, which is the only thing it was ever asserting; leaving it stale keeps
	 * a claim that is now simply false. Whether the moved target should still be addressed rather than
	 * linked is a doctrine question this verb deliberately does not answer.
	 *
	 * KNOWN LIMIT, stated rather than discovered: the swap is WHOLE-FILE, so a referrer that carries
	 * BOTH a live reference and a quoted sample of the same href has the sample rewritten too. The
	 * quoted-speech rule is honoured per FILE, not per occurrence. Making it per-occurrence means
	 * rewriting by index instead of by string, which trades the formatting-preserving literal swap for
	 * positional surgery — a real change to the write path, not a tweak, and not worth it for a case
	 * that needs one document to both link a target and quote a link to it. Covered by a test so the
	 * next reader inherits the fact instead of the surprise.
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
	 * Post-condition guard: after an apply, NO reference the heal claimed to cover may still resolve to
	 * the old path. A residual means a reference form the healer did not cover ( e.g. an href authored
	 * in a shape the swap did not match ) — throw rather than leave the graph rotted.
	 *
	 * The residual set is passed IN rather than recomputed here, because the two callers do not cover
	 * the same ground and the guard must not assert more than the verb promised. A move rewrites both
	 * passes, so it re-checks both. A delete EXCISES, which is parse-and-splice and therefore reaches
	 * only the graph pass — so it re-checks the graph, and what the text pass found rides its plan's
	 * `reported` array as `not-excisable` instead of being failed here. Quoted-speech occurrences are
	 * in neither: they were never going to change, so they can never be a residual.
	 */
	assertNoResidual( targetAbs: string, op: string, residual: HealEdit[] ): void {
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
		if ( !fs.existsSync( targetAbs ) )
			throw new Error( `Cannot delete: "${ target }" does not exist — paths are vault-relative to "${ this.root }"; find the real one with a query before deleting it` );

		const dependents = this.identityDependents( targetAbs );
		if ( dependents.length > 0 )
			throw new Error(
				`Cannot delete "${ target }": ${ dependents.length } artifact(s) reference it by identity ( ${ dependents.join( ', ' ) } ) — repoint or rename those first`
			);

		// EXCISION is parse-and-splice, so it reaches only what the GRAPH pass found — a parsed HTML or
		// `.js` referrer. What the TEXT pass adds ( a markdown todo, an unparseable file, an address, a
		// host entry file ) is REPORTED and left alone: there is no span-precise removal of a reference
		// from a sentence, and quietly rewriting somebody's prose is not a delete's job. Those
		// references will dangle — and the plan says so, rather than the caller finding out later.
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

	/** This document's current `name`, read off a fresh scan — or `''` if it does not parse or carries
	 *  none. A fresh scan rather than a cached one: this is read at the START of `move`, before the
	 *  rename touches anything, and has to see the file exactly as it stands on disk right now. */
	private _frontmatterNameAt( abs: string ): string {
		const f = this.scan().find( s => s.path === abs );
		return f && typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '';
	}

	/**
	 * A move whose destination implies a different slug IS a rename of identity — repair the moved
	 * document's own `name` to match, then rewrite every OTHER document's identity-reference field
	 * ( `Vault.IDENTITY_FIELDS` ) naming the OLD slug to the NEW one. Scalar and list shapes alike,
	 * EXACT-VALUE match only — `_rewriteIdentityField` matches a whole field value or a whole chip,
	 * never a substring, so a slug that merely RESEMBLES the old one ( `render-old` beside `render` )
	 * is left untouched by construction.
	 *
	 * Best-effort per field, the same posture `restampStylesheet` takes for the same reason: identity
	 * repair is this operation's ADDED value, layered onto a move whose href heal already carries its
	 * own residual guard. A field this cannot locate in one odd hand-authored file is skipped rather
	 * than failing the whole move.
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
	 * Rewrite ONE frontmatter field's value from `oldName` to `newName` inside raw HTML — or `null`
	 * when that field is absent, or present but not naming `oldName`. Handles both serialized shapes:
	 * a scalar ( `<dd data-kcd-field="base" data-kcd-type="slug">oldName</dd>` ) and a chip inside a
	 * list ( `<li data-kcd-tag>oldName</li>` within the matching `<dd>` ). EXACT match only in both
	 * shapes — a scalar must equal `oldName` whole, and a chip match is bounded by `>…<` on both
	 * sides — so a slug that merely resembles `oldName` is never touched.
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
	 * Reference-integrity findings across the vault ( or one file, when `onlyFile` is given ) — the
	 * hygiene half of health, complementing the per-file structural typeCheck:
	 *
	 *   • Dangling links — an internal link href whose target does not exist on disk. Code-file links
	 *     count ( a lens Know table legitimately points at `.ts` ); external URLs, `#anchors`, and
	 *     `{placeholder}` template hrefs are skipped.
	 *   • Broken identity refs — a `base` / `lens` slug that names no artifact in the vault. READ IN BOTH
	 *     SHAPES: these fields are a list on most document types and a bare string on a few, and until
	 *     2026-09-26 only the string was read, so the check silently graded almost nothing ( the loop
	 *     below carries the whole account ). The `cross` sentinel ( a multi-lens plan's `lens` ) is not a
	 *     reference and is skipped, per member rather than per field.
	 *
	 * Identity findings are `warn`: advisory, never a parse-blocking error, because the document still
	 * parses and the runtime degrades on purpose ( `BrokenLens` ). `error` is reserved for the two facts
	 * that are not "something is missing" — a wrong-vault link and a duplicated id. `names` is built from
	 * the whole scan even when scoped to one file, so a scoped identity ref still resolves against the
	 * full vault.
	 *
	 * ONE KNOWN HOLE, stated rather than fixed: `names` is built from the whole scan, INCLUDING scratch
	 * space, so a copy of a retired lens under `work/` makes a dead reference look alive. `_idsOf` takes
	 * the opposite view for ids — "a scratch copy of a lens under `work/` is not a second identity" — and
	 * the same reasoning arguably applies here. Left alone because narrowing it is a behaviour change
	 * that could surface a lot at once, and it wants to land on its own.
	 */
	referenceIssues( onlyFile?: string ): RefIssue[] {
		const files   = this.scan();
		const names   = new Set( files.map( f => typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '' ) );
		const ids     = this._idsOf( files );
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
				if ( fs.existsSync( this.resolveHref( href ) ) ) continue;

				// A WRONG-VAULT REFERENCE IS AN ERROR, not a dangling link, and the two are worth
				// separating because they call for opposite responses: a dangling link usually means the
				// target has not been written yet ( wait, or write it ), while this means the document
				// believes it lives in a vault it does not live in ( repair it, now, before anything
				// follows the link ).
				//
				// PROVEN, NOT GUESSED. Swap the href's leading segment for THIS vault's name: if the
				// target then exists, the reference was right about everything except which vault it is
				// in, and that is evidence rather than a heuristic. A link to project code
				// ( `starmind/src/…` ) fails that test and stays an ordinary warning, which is what keeps
				// this from flagging every href that happens to start with a directory name.
				const elsewhere = this._wrongVaultTarget( href );
				if ( elsewhere )
					issues.push( {
						path: f.relativePath, severity: 'error', ref: href,
						message: `wrong vault: "${ href }" names "${ href.split( '/' )[ 0 ] }", but this vault is "${ this.docRoot }" — the target exists at "${ elsewhere }"`
					} );
				else
					issues.push( { path: f.relativePath, severity: 'warn', message: `link target missing on disk: "${ href }"`, ref: href } );
			}

			// NOTE: addresses are deliberately absent from this loop. An address carries no `href`, so it
			// never enters `rawLinks` and is never probed — protocol §1.1. Vacancy is a legal state; see
			// `vacantAddresses` for the on-request report.

			// A `lens` FIELD IS A LIST ON MOST TYPES AND A BARE STRING ON A FEW, and this loop only ever
			// read the string. `typeof v !== 'string'` sent every array-valued lens field straight to
			// `continue`, which is every analyzer and every reference naming more than one lens — so the
			// check existed, looked right, and graded almost none of its subjects.
			//
			// FOUND 2026-09-26, and the way it was found is the argument for the repair. A lens retirement
			// deleted ten lenses; seven of the eight audit analyzers were left declaring a lens that no
			// longer existed, `audit-rollup` among them; and a whole-vault sweep reported ZERO ISSUES the
			// whole time. Nothing was wrong with the rule. It was reading one shape of a two-shape field,
			// and the shape it could not read is the common one.
			//
			// This is the project's dominant failure class again — a check that returns the right answer
			// for an input it never received. `health`'s own docblock says it about a denominator; this is
			// the same sentence about a type.
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

					// WARN, NOT ERROR, and deliberately. Nothing breaks: the document parses, and the
					// runtime already degrades on purpose — `BrokenLens` keeps a lens an agent's record
					// names but cannot load, carrying its id, name, stack position and reason, so a record
					// write puts the id back where it was rather than dropping it. Failing the parse here
					// would take away the one thing a repair needs, which is a readable document to repair.
					// The message carries the repair, because a warning nobody can act on is noise.
					issues.push( {
						path: f.relativePath, severity: 'warn', ref: v,
						message: `${ key } "${ v }" names no artifact in the vault — a renamed or retired `
						       + `${ key } leaves this reference behind, and nothing else reports it`
					} );
				}
			}

			// A DUPLICATED ID IS AN ERROR. The id is the document's identity — an agent names a lens by it — so
			// two documents carrying one means a record could resolve to either. It is almost always a file
			// copied in Explorer, which copies the frontmatter with it.
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

	/**
	 * An href that would resolve if its leading segment named THIS vault — the proof behind the
	 * wrong-vault error above. Returns the corrected href, or null when swapping the segment changes
	 * nothing or still resolves to nothing.
	 *
	 * Deliberately narrow. It answers one question with disk evidence rather than inferring intent
	 * from the shape of a name, so a project path, an asset, and a genuinely unwritten target all fall
	 * through to the ordinary warning.
	 */
	private _wrongVaultTarget( href: string ): string | null {
		const parts = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' );
		if ( parts.length < 2 || parts[ 0 ] === '' || parts[ 0 ] === this.docRoot ) return null;

		const corrected = [ this.docRoot, ...parts.slice( 1 ) ].join( '/' );
		return fs.existsSync( this.resolveHref( corrected ) ) ? corrected : null;
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
