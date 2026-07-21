import * as fs from 'fs'
import * as path from 'path'
import { LensObject, VaultLayout } from '../core'

/**
 * VaultDeploy — install a KCD vault into a directory, and report on one that already exists.
 *
 * Driven entirely by the `VaultLayout` table: the structure is defined once in code, and this
 * creates it. That is the whole reason the table exists — a deployment that reads the same rows the
 * classifier and the index whitelist read cannot drift from them.
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
 *  `substrate` is the canonical framework library, copied from a master; `file` is a seeded document. */
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

/** The canonical substrate directory name, relative to the vault root. */
const SUBSTRATE_DIR = 'kcd'

/** Never copied out of the canonical substrate. The framework library is its own git repository in
 *  the project that hosts it; transplanting that into a new project would hand it a stale, unrelated
 *  history that looks like its own. */
const COPY_EXCLUDE = [ '.git' ]

/** Seeded from the substrate into the deployed tree — the base lens is auto-loaded into every
 *  session, so a vault without one has no floor to stand on. */
const BASE_LENS = 'lenses/_lens_base.html'

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

		items.push( ...VaultDeploy._substrate( vault, opts?.substrateSource, write ) )
		items.push( VaultDeploy._baseLens( vault, opts?.substrateSource, write ) )
		items.push( VaultDeploy._navIndex( vault, write ) )

		const missing = items.filter( ( i ) => !i.present ).length
		return { root: projectRoot, docRoot, items, missing, applied: write }
	}

	/**
	 * The canonical framework library, copied from a master. `force: false` is what makes this a
	 * FILL rather than a reset — an existing file is never overwritten, so a project that has been
	 * running for months keeps whatever it has and only gains what it lacks.
	 *
	 * A missing or unreadable source is reported, not thrown: a deploy that cannot find its master
	 * should say so plainly and leave the rest of the structure in place, because the directories
	 * are still worth having.
	 */
	private static _substrate( vault: string, source: string | undefined, write: boolean ): DeployItem[] {
		const dest = path.join( vault, SUBSTRATE_DIR )

		if( !source || !fs.existsSync( source ) ) {
			return [ {
				kind:    'substrate',
				path:    SUBSTRATE_DIR,
				present: fs.existsSync( dest ),
				note:    source ? `canonical substrate not found at "${ source }"` : 'no substrate source given'
			} ]
		}

		// "Present" means COMPLETE, not merely existing — a substrate missing files ( the real drift
		// case ) must report as incomplete or the maintenance read would call a partial vault healthy.
		const gaps = VaultDeploy._missingUnder( source, dest )
		const item: DeployItem = {
			kind:    'substrate',
			path:    SUBSTRATE_DIR,
			present: gaps.length === 0,
			note:    gaps.length === 0 ? 'complete' : `${ gaps.length } file(s) missing: ${ gaps.slice( 0, 5 ).join( ', ' ) }${ gaps.length > 5 ? '…' : '' }`
		}

		if( gaps.length > 0 && write ) {
			fs.cpSync( source, dest, {
				recursive: true,
				force:     false,          // never overwrite — this fills, it does not reset
				errorOnExist: false,
				filter:    ( src ) => !COPY_EXCLUDE.includes( path.basename( src ) )
			} )
		}
		return [ item ]
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

	/** Seed the deployed base lens from the substrate's copy. Every session auto-loads it, so a vault
	 *  without one has no floor — but an existing one is never replaced: it is the most-edited
	 *  document in a mature project. */
	private static _baseLens( vault: string, source: string | undefined, write: boolean ): DeployItem {
		const dest    = path.join( vault, BASE_LENS )
		const present = fs.existsSync( dest )
		const item: DeployItem = { kind: 'file', path: BASE_LENS, present, note: 'auto-loaded into every session' }
		if( present || !write || !source ) return item

		const from = path.join( source, BASE_LENS )
		if( !fs.existsSync( from ) ) {
			item.note = `substrate has no ${ BASE_LENS } to seed from`
			return item
		}
		fs.mkdirSync( path.dirname( dest ), { recursive: true } )
		fs.copyFileSync( from, dest )
		return item
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
	<link rel="stylesheet" href="kcd/kcd.css">
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
