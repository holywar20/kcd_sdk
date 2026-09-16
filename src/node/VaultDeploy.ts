import * as fs from 'fs'
import * as path from 'path'
import { LensObject, VaultLayout, InstallManifest } from '../core'

/**
 * VaultDeploy — install a KCD vault into a directory, and report on one that already exists.
 *
 * Driven by two tables: `VaultLayout` for the empty structure ( the same rows the classifier and the
 * index whitelist read, so a deployment cannot drift from them ), and `InstallManifest` for what
 * fills it — the framework content copied in from the bundle's `substrateSource`.
 *
 * TWO OPERATIONS, ONE ANSWER. `inspect()` reports what is missing and changes nothing; `apply()`
 * does the same walk and fills the gaps. They share their reasoning, so the report is never a
 * separate implementation that could disagree with what the fill actually does — the preview IS the
 * plan. This is what makes the same code serve both "create a new project" and "repair an existing
 * one": a deploy is idempotent by construction, because every step asks "is this already here?"
 * before it acts.
 *
 * Safe over existing code. A project may wrap a repository that predates KCD entirely — nothing
 * outside the doc root is touched, and nothing already present is overwritten.
 */

/** What a single deploy step is responsible for. `dir` is an empty directory from the layout table;
 *  `substrate` is one `InstallManifest` row, filled from the bundle; `file` is a seeded document. */
export type DeployItemKind = 'dir' | 'substrate' | 'file'

/**
 * Where a deploy reads from and writes to, and how hard it writes.
 *
 * `force` is the whole difference between REPAIR and RESET. Without it a deploy fills gaps and leaves
 * every existing file exactly as it is; with it, a framework file whose content has drifted from what
 * the bundle ships is written back to canonical. Nothing else changes — `force` reaches only files the
 * `InstallManifest` claims, so a document the project wrote itself is untouchable either way. That
 * boundary is the reason a reset is offerable at all: it cannot reach a person's own work.
 */
export interface DeployOptions {
	docRoot?:         string
	substrateSource?: string
	force?:           boolean
}

/** One step of a deployment — what it is, where it goes ( vault-relative ), and whether it was
 *  already there. `present: true` in an apply() report means "left alone", never "overwritten". */
export interface DeployItem {
	kind:    DeployItemKind
	path:    string
	present: boolean
	note?:   string
	/** How many files under this step are ABSENT — the repair measurement. `present` says whether the step
	 *  is satisfied; this says how big the gap is, as a NUMBER rather than a phrase buried in `note`. It is
	 *  there so a reader of this report never has to parse prose to draw a count. */
	missingFiles: number
	/** How many files under this step differ from what the bundle ships — the RESET measurement, beside
	 *  the fill measurement above. A present row with `changed: 0` is byte-identical to canonical; a
	 *  present row with `changed: 12` is a row somebody has edited. Always 0 for a step with no canonical
	 *  counterpart ( a layout directory, a seeded file ), which have nothing to drift from. */
	changed: number
}

/**
 * The full effect of a deploy — every step, whether it ran, and how much was missing. Returned by both
 * `inspect()` ( nothing happened ) and `apply()` ( it did ), distinguished by `applied`.
 *
 * EVERY COUNT HERE DESCRIBES WHAT THE WALK FOUND, not the state it left. From an inspect those are the
 * same thing. From an apply they are not: `missing: 35` on an applied report means "thirty-five steps
 * were absent and have now been filled", and a fresh `inspect()` immediately afterwards would answer 0.
 * Read an applied report as a record of work done, never as a health check — that is what `inspect` is
 * for, and asking the wrong one is how a repair comes to report itself as a failure.
 */
export interface DeployReport {
	root:    string
	docRoot: string
	items:   DeployItem[]
	/** How many steps were NOT already satisfied. 0 from inspect() = a complete, healthy vault. */
	missing: number
	/** How many FILES ( not steps ) differ from canonical across every substrate row. This is what a reset
	 *  would overwrite, and the number the confirm has to say out loud: a vault can be complete — nothing
	 *  missing, nothing to repair — and still carry fifty edited framework documents. */
	changed: number
	applied: boolean
}

/** Never copied out of the bundle. Defensive — the bundle itself should never carry a `.git`, but a
 *  `substrateSource` pointed at a live checkout ( dev, self-hosting ) might. */
const COPY_EXCLUDE = [ '.git' ]

/** File kinds whose CONTENT names the vault, and so must be retargeted rather than byte-copied.
 *  Everything else is copied verbatim — see `_fillFile` on why this is an allowlist. */
const TEXT_SUFFIXES = [ '.html', '.htm', '.md', '.css', '.js', '.json' ]

export class VaultDeploy {

	/** What this vault is missing, changing nothing. The 4.e maintenance read: point it at any
	 *  project and it answers "is this vault whole?" without touching disk. */
	static inspect( projectRoot: string, opts?: DeployOptions ): DeployReport {
		return VaultDeploy._run( projectRoot, opts, false )
	}

	/** Fill every gap `inspect()` would report. Idempotent: anything already present is left exactly
	 *  as it is, so running this against a healthy vault is a no-op that still returns a full report. */
	static apply( projectRoot: string, opts?: DeployOptions ): DeployReport {
		return VaultDeploy._run( projectRoot, opts, true )
	}

	/**
	 * The one walk both operations share. `write` is the only difference between a preview and a
	 * deployment — every decision about WHAT should exist is made identically either way.
	 */
	private static _run( projectRoot: string, opts: DeployOptions | undefined, write: boolean ): DeployReport {
		const docRoot = opts?.docRoot ?? LensObject.DEFAULT_DOC_ROOT
		const vault   = path.resolve( projectRoot, docRoot )
		const items: DeployItem[] = []

		if( write ) fs.mkdirSync( vault, { recursive: true } )

		// Every directory the layout declares. `scaffold: 'copy'` rows are directories too — their
		// CONTENTS come from the substrate step below, but the folder itself belongs here so an
		// inspect of a vault with no substrate still names it.
		for( const entry of VaultLayout.all() ) {
			const abs     = path.join( vault, entry.dir )
			const present = fs.existsSync( abs )
			items.push( { kind: 'dir', path: entry.dir, present, missingFiles: 0, changed: 0, note: entry.purpose } )
			if( !present && write ) fs.mkdirSync( abs, { recursive: true } )
		}

		items.push( ...VaultDeploy._manifest( vault, docRoot, opts?.substrateSource, write, opts?.force === true ) )
		items.push( VaultDeploy._navIndex( vault, docRoot, write ) )
		items.push( VaultDeploy._commandDeck( vault, write ) )

		const missing = items.filter( ( i ) => !i.present ).length
		const changed = items.reduce( ( sum, i ) => sum + i.changed, 0 )
		return { root: projectRoot, docRoot, items, missing, changed, applied: write }
	}

	/**
	 * Every `InstallManifest` row, filled from the bundle. `force: false` is what makes this a FILL
	 * rather than a reset — an existing file is never overwritten, so a project that has been running
	 * for months keeps whatever it has and only gains what it lacks.
	 *
	 * A missing bundle, or a row absent from it, is reported per-row rather than thrown: a deploy that
	 * cannot find part of its source should say so plainly and keep filling everything else, because
	 * one missing optional row is not a reason to leave the rest of the vault half-built.
	 */
	private static _manifest( vault: string, docRoot: string, source: string | undefined, write: boolean, force: boolean ): DeployItem[] {
		const items: DeployItem[] = []

		for( const entry of InstallManifest.all() ) {
			const dest = path.join( vault, entry.vaultHome )
			const src  = source ? path.join( source, entry.bundleSource ) : undefined

			if( !src || !fs.existsSync( src ) ) {
				items.push( {
					kind:    'substrate',
					path:    entry.vaultHome,
					present:      fs.existsSync( dest ),
					missingFiles: 0,
					changed:      0,
					note:    !source
						? 'no substrate source given'
						: `${ entry.required ? 'required' : 'optional' } — not found in bundle at "${ entry.bundleSource }"`
				} )
				continue
			}

			// "Present" means COMPLETE, not merely existing — a row missing files ( the real drift
			// case ) must report as incomplete or the maintenance read would call a partial vault healthy.
			const isDir = fs.statSync( src ).isDirectory()
			const gaps  = isDir ? VaultDeploy._missingUnder( src, dest ) : ( fs.existsSync( dest ) ? [] : [ entry.bundleSource ] )
			// The drift measurement, taken WHETHER OR NOT this run intends to act on it: the repair preview
			// has to be able to say "complete, and fifty of these are edited" without being a reset itself.
			const drift = isDir
				? VaultDeploy._differingUnder( src, dest, docRoot )
				: ( fs.existsSync( dest ) && !VaultDeploy._matches( src, dest, docRoot ) ? [ entry.bundleSource ] : [] )

			const item: DeployItem = {
				kind:         'substrate',
				path:         entry.vaultHome,
				present:      gaps.length === 0,
				missingFiles: gaps.length,
				changed:      drift.length,
				note:         gaps.length > 0
					? `${ gaps.length } file(s) missing: ${ gaps.slice( 0, 5 ).join( ', ' ) }${ gaps.length > 5 ? '…' : '' }`
					: drift.length > 0
						? `complete — ${ drift.length } file(s) edited: ${ drift.slice( 0, 5 ).join( ', ' ) }${ drift.length > 5 ? '…' : '' }`
						: 'complete'
			}

			if( write && ( gaps.length > 0 || ( force && drift.length > 0 ) ) ) {
				if( isDir ) {
					fs.mkdirSync( dest, { recursive: true } )
					VaultDeploy.fill( src, dest, docRoot, force )
				} else {
					fs.mkdirSync( path.dirname( dest ), { recursive: true } )
					VaultDeploy._fillFile( src, dest, docRoot, force )
				}
			}
			items.push( item )
		}
		return items
	}

	/**
	 * Fill `dest` from `source`, retargeting bundled text at the vault it is actually landing in.
 *
 * PUBLIC because the vault is not the only thing an install copies out of the bundle. The bundled
 * SKILLS land in `.claude/skills/` and hardcode `_Claude/…` the same way — and those are
 * instructions an agent READS AND ACTS ON ( "read `_Claude/audits/survey/index.json`" ), so a stale
 * path there sends an agent hunting a folder that does not exist. One door for "copy a bundled tree
 * into this project, retargeted", rather than a second copy loop that would drift from this one.
	 *
	 * THIS REPLACED `fs.cpSync( recursive )`, and the reason is the whole point: cpSync copies BYTES,
	 * and the bundled corpus is not byte-portable. Its 56 documents hardcode `_Claude/…` in every
	 * internal link — 281 occurrences — so a verbatim copy into a vault named anything else installs a
	 * library whose every link points at a folder that does not exist. Measured on a fresh
	 * `--doc-root _kcd` install: 111 dangling-link warnings, all of them this, on day one.
	 *
	 * Semantics are cpSync's, preserved deliberately: never overwrite ( this FILLS, it does not reset ),
	 * skip the excluded names, create directories as needed. The only change is that a text file is
	 * read, retargeted and written rather than copied.
	 */
	static fill( source: string, dest: string, docRoot: string, force = false ): void {
		// CREATE THE DESTINATION, because `cpSync( recursive )` did and this replaced it. Dropping that
		// broke the skills install ( ENOENT on the first file ) while the vault install kept working —
		// the vault caller happened to mkdir the destination itself, so only one of the two callers
		// showed it. A replacement inherits every guarantee of what it replaced, including the quiet ones.
		fs.mkdirSync( dest, { recursive: true } )

		for( const entry of fs.readdirSync( source, { withFileTypes: true } ) ) {
			if( COPY_EXCLUDE.includes( entry.name ) ) continue
			const from = path.join( source, entry.name )
			const to   = path.join( dest, entry.name )

			if( entry.isDirectory() ) {
				fs.mkdirSync( to, { recursive: true } )
				VaultDeploy.fill( from, to, docRoot, force )
				continue
			}
			VaultDeploy._fillFile( from, to, docRoot, force )
		}
	}

	/**
	 * One file, filled. A KCD-text file is retargeted; anything else is copied byte-for-byte.
	 *
	 * THE ALLOWLIST IS DELIBERATE, and it is an allowlist rather than a blocklist because the failure
	 * modes are not symmetrical: missing a text type costs some stale links a person can see and fix,
	 * while rewriting a binary by decoding it as UTF-8 corrupts a file silently. The bundle is all
	 * text today; the day it carries a font or an image, this stays correct without being revisited.
	 */
	private static _fillFile( source: string, dest: string, docRoot: string, force = false ): void {
		// Never overwrite — this FILLS. `force` is the one caller that means otherwise, and even it stops
		// short of touching a file that already matches: rewriting identical bytes would move the mtime of
		// every framework document in the vault, which is a lie told to anything watching the tree.
		if( fs.existsSync( dest ) && ( !force || VaultDeploy._matches( source, dest, docRoot ) ) ) return

		if( !TEXT_SUFFIXES.some( ( s ) => source.toLowerCase().endsWith( s ) ) ) {
			fs.copyFileSync( source, dest )
			return
		}
		fs.writeFileSync( dest, VaultLayout.retargetDocRoot( fs.readFileSync( source, 'utf-8' ), docRoot ), 'utf-8' )
	}

	/**
	 * Is `dest` exactly what a fill would have written from `source`?
	 *
	 * Compared against the RETARGETED text rather than the bundle's own bytes, because that is what the
	 * file was installed as — a vault at `_kcd` holds `_kcd/…` links, and calling those fifty documents
	 * "edited" would make every non-default install report itself as wholly drifted on day one.
	 */
	private static _matches( source: string, dest: string, docRoot: string ): boolean {
		try {
			if( !TEXT_SUFFIXES.some( ( s ) => source.toLowerCase().endsWith( s ) ) ) {
				return fs.readFileSync( source ).equals( fs.readFileSync( dest ) )
			}
			const want = VaultLayout.retargetDocRoot( fs.readFileSync( source, 'utf-8' ), docRoot )
			return fs.readFileSync( dest, 'utf-8' ) === want
		} catch {
			// Unreadable counts as different: a file we cannot compare is one we cannot call clean.
			return false
		}
	}

	/** Every file under `source` that EXISTS under `dest` with different content, as source-relative paths.
	 *  The measurement behind "what would a reset overwrite?" — the mirror of `_missingUnder`, and
	 *  deliberately disjoint from it: a missing file is not a changed one. */
	private static _differingUnder( source: string, dest: string, docRoot: string ): string[] {
		const out: string[] = []
		const walk = ( rel: string ): void => {
			for( const entry of fs.readdirSync( path.join( source, rel ), { withFileTypes: true } ) ) {
				if( COPY_EXCLUDE.includes( entry.name ) ) continue
				const childRel = rel ? path.join( rel, entry.name ) : entry.name
				if( entry.isDirectory() ) { walk( childRel ); continue }
				const to = path.join( dest, childRel )
				if( !fs.existsSync( to ) ) continue
				if( !VaultDeploy._matches( path.join( source, childRel ), to, docRoot ) ) out.push( childRel.replace( /\\/g, '/' ) )
			}
		}
		if( !fs.existsSync( source ) || !fs.existsSync( dest ) ) return out
		walk( '' )
		return out
	}

	/** Every file under `source` ( excluding the copy-excluded names ) with no counterpart under
	 *  `dest`, as source-relative paths. The measurement behind "is the substrate complete?". */
	private static _missingUnder( source: string, dest: string ): string[] {
		const out: string[] = []
		const walk = ( rel: string ): void => {
			const here = path.join( source, rel )
			for( const entry of fs.readdirSync( here, { withFileTypes: true } ) ) {
				if( COPY_EXCLUDE.includes( entry.name ) ) continue
				const childRel = rel ? path.join( rel, entry.name ) : entry.name
				if( entry.isDirectory() ) { walk( childRel ); continue }
				if( !fs.existsSync( path.join( dest, childRel ) ) ) out.push( childRel.replace( /\\/g, '/' ) )
			}
		}
		if( !fs.existsSync( source ) ) return out
		walk( '' )
		return out
	}

	/** The vault's root nav-index — the entry map a reader ( human or agent ) lands on. Written only
	 *  when absent, and deliberately minimal: it is a starting point the project grows, not a
	 *  generated artifact that would fight being edited. */
	private static _navIndex( vault: string, docRoot: string, write: boolean ): DeployItem {
		const rel     = VaultLayout.NAV_INDEX_FILE
		const dest    = path.join( vault, rel )
		const present = fs.existsSync( dest )
		const item: DeployItem = { kind: 'file', path: rel, present, missingFiles: present ? 0 : 1, changed: 0, note: 'the vault entry map' }
		if( present || !write ) return item
		fs.writeFileSync( dest, VaultDeploy._navIndexHtml( docRoot ), 'utf-8' )
		return item
	}

	/**
	 * The command deck's one file. The deck's location is CONVENTION, not configuration — it is always
	 * `<docRoot>/dev-utilities/commands.json` — so the deck panel computes that path rather than asking
	 * the user for it. That only holds if the file reliably exists, which is this step's whole job: every
	 * deployed project gets one, and a repair on an older project fills it in.
	 *
	 * Seeded EMPTY. JSON carries no comments, so there is nowhere to explain the schema in the file, and a
	 * placeholder entry would render as a launcher button that does nothing — worse than an empty deck,
	 * which states the path it read and invites the first real command. The directory itself comes from
	 * the layout table like every other folder.
	 */
	private static _commandDeck( vault: string, write: boolean ): DeployItem {
		const rel     = 'dev-utilities/commands.json'
		const dest    = path.join( vault, rel )
		const present = fs.existsSync( dest )
		const item: DeployItem = { kind: 'file', path: rel, present, missingFiles: present ? 0 : 1, changed: 0, note: 'the command deck\'s launchers' }
		if( present || !write ) return item
		fs.mkdirSync( path.dirname( dest ), { recursive: true } )
		fs.writeFileSync( dest, '[]\n', 'utf-8' )
		return item
	}

	/**
	 * The entry map's HTML. Two things here are easy to get wrong and were both wrong:
	 *
	 * THE DOC ROOT IS A PARAMETER. It was the literal `_Claude`, so an install anywhere else emitted
	 * fifteen links into a folder that does not exist — in the one file a reader opens first.
	 *
	 * AN EPHEMERAL ROW IS AN ADDRESS, NOT A LINK ( §1.1 ). `work/`, `logs/`, `audits/` and the rest
	 * are not installed into a vault, so a LINK to one asserts something false by construction — and
	 * the validator says so, with the very `ephemeral-link` code this generator was minting six of
	 * into every fresh vault. The generated file could not pass the project's own validator. Rows for
	 * those directories still appear ( the map would be a lie by omission without them ); they carry
	 * their location as an address, which asserts nothing about occupancy.
	 */
	private static _navIndexHtml( docRoot: string ): string {
		const rows = VaultLayout.all()
			.filter( ( e ) => !e.dir.includes( '/' ) )
			.map( ( e ) => {
				const target = `${ docRoot }/${ e.dir }/`
				const where  = VaultLayout.ephemeralDirs().includes( e.dir )
					? `<span data-kcd-field="where" data-kcd-type="address">${ target }</span>`
					: `<a    data-kcd-field="where" data-kcd-type="path" href="${ target }">${ e.dir }</a>`
				return `\t\t\t<div data-kcd-slot="link">
				<span data-kcd-field="what"  data-kcd-type="text">${ e.dir }</span>
				${ where }
				<span data-kcd-field="why"   data-kcd-type="text">${ e.purpose }</span>
			</div>`
			} )
			.join( '\n' )

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Vault — Navigation Index</title>
	<link rel="stylesheet" href="kcd.css">
</head>
<body>

<article data-kcd="nav-index">

	<dl data-kcd-frontmatter>
		<dt>name</dt>          <dd data-kcd-field="name"           data-kcd-type="slug">vault</dd>
		<dt>description</dt>   <dd data-kcd-field="description"    data-kcd-type="text">The entry map for this project's KCD vault — every top-level folder and what belongs in it.</dd>
		<dt>type</dt>          <dd data-kcd-field="type"           data-kcd-type="enum">nav-index</dd>
		<dt>status</dt>        <dd data-kcd-field="status"         data-kcd-type="enum">active</dd>
		<dt>schema-version</dt><dd data-kcd-field="schema-version" data-kcd-type="text">0.1</dd>
	</dl>

	<h1>Vault — Index</h1>

	<p>The entry map for this project's KCD vault. Structure is defined in code by the
	<code>VaultLayout</code> table; this index is yours to grow.</p>

	<section data-kcd-section="structure">
		<h2>Structure</h2>
		<div data-kcd-table>
			<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
${ rows }
		</div>
	</section>

</article>

</body>
</html>
`
	}

}
