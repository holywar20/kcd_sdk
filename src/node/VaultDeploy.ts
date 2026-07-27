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

/** One step of a deployment — what it is, where it goes ( vault-relative ), and whether it was
 *  already there. `present: true` in an apply() report means "left alone", never "overwritten". */
export interface DeployItem {
	kind:    DeployItemKind
	path:    string
	present: boolean
	note?:   string
}

/** The full effect of a deploy — every step, whether it ran, and how much was missing. Returned by
 *  both `inspect()` ( nothing happened ) and `apply()` ( it did ), distinguished by `applied`. */
export interface DeployReport {
	root:    string
	docRoot: string
	items:   DeployItem[]
	/** How many steps were NOT already satisfied. 0 from inspect() = a complete, healthy vault. */
	missing: number
	applied: boolean
}

/** Never copied out of the bundle. Defensive — the bundle itself should never carry a `.git`, but a
 *  `substrateSource` pointed at a live checkout ( dev, self-hosting ) might. */
const COPY_EXCLUDE = [ '.git' ]

export class VaultDeploy {

	/** What this vault is missing, changing nothing. The 4.e maintenance read: point it at any
	 *  project and it answers "is this vault whole?" without touching disk. */
	static inspect( projectRoot: string, opts?: { docRoot?: string; substrateSource?: string } ): DeployReport {
		return VaultDeploy._run( projectRoot, opts, false )
	}

	/** Fill every gap `inspect()` would report. Idempotent: anything already present is left exactly
	 *  as it is, so running this against a healthy vault is a no-op that still returns a full report. */
	static apply( projectRoot: string, opts?: { docRoot?: string; substrateSource?: string } ): DeployReport {
		return VaultDeploy._run( projectRoot, opts, true )
	}

	/**
	 * The one walk both operations share. `write` is the only difference between a preview and a
	 * deployment — every decision about WHAT should exist is made identically either way.
	 */
	private static _run( projectRoot: string, opts: { docRoot?: string; substrateSource?: string } | undefined, write: boolean ): DeployReport {
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
			items.push( { kind: 'dir', path: entry.dir, present, note: entry.purpose } )
			if( !present && write ) fs.mkdirSync( abs, { recursive: true } )
		}

		items.push( ...VaultDeploy._manifest( vault, opts?.substrateSource, write ) )
		items.push( VaultDeploy._navIndex( vault, write ) )
		items.push( VaultDeploy._commandDeck( vault, write ) )

		const missing = items.filter( ( i ) => !i.present ).length
		return { root: projectRoot, docRoot, items, missing, applied: write }
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
	private static _manifest( vault: string, source: string | undefined, write: boolean ): DeployItem[] {
		const items: DeployItem[] = []

		for( const entry of InstallManifest.all() ) {
			const dest = path.join( vault, entry.vaultHome )
			const src  = source ? path.join( source, entry.bundleSource ) : undefined

			if( !src || !fs.existsSync( src ) ) {
				items.push( {
					kind:    'substrate',
					path:    entry.vaultHome,
					present: fs.existsSync( dest ),
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
			const item: DeployItem = {
				kind:    'substrate',
				path:    entry.vaultHome,
				present: gaps.length === 0,
				note:    gaps.length === 0 ? 'complete' : `${ gaps.length } file(s) missing: ${ gaps.slice( 0, 5 ).join( ', ' ) }${ gaps.length > 5 ? '…' : '' }`
			}

			if( gaps.length > 0 && write ) {
				if( isDir ) {
					fs.mkdirSync( dest, { recursive: true } )
					fs.cpSync( src, dest, {
						recursive: true,
						force:     false,          // never overwrite — this fills, it does not reset
						errorOnExist: false,
						filter:    ( s ) => !COPY_EXCLUDE.includes( path.basename( s ) )
					} )
				} else {
					fs.mkdirSync( path.dirname( dest ), { recursive: true } )
					fs.copyFileSync( src, dest )
				}
			}
			items.push( item )
		}
		return items
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
	private static _navIndex( vault: string, write: boolean ): DeployItem {
		const rel     = 'nav-index.html'
		const dest    = path.join( vault, rel )
		const present = fs.existsSync( dest )
		const item: DeployItem = { kind: 'file', path: rel, present, note: 'the vault entry map' }
		if( present || !write ) return item
		fs.writeFileSync( dest, VaultDeploy._navIndexHtml(), 'utf-8' )
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
		const item: DeployItem = { kind: 'file', path: rel, present, note: 'the command deck\'s launchers' }
		if( present || !write ) return item
		fs.mkdirSync( path.dirname( dest ), { recursive: true } )
		fs.writeFileSync( dest, '[]\n', 'utf-8' )
		return item
	}

	private static _navIndexHtml(): string {
		const rows = VaultLayout.all()
			.filter( ( e ) => !e.dir.includes( '/' ) )
			.map( ( e ) => `\t\t\t<div data-kcd-slot="link">
				<span data-kcd-field="what"  data-kcd-type="text">${ e.dir }</span>
				<a    data-kcd-field="where" data-kcd-type="path" href="_Claude/${ e.dir }/">${ e.dir }</a>
				<span data-kcd-field="why"   data-kcd-type="text">${ e.purpose }</span>
			</div>` )
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
