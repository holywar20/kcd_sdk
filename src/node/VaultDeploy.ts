import * as fs from 'fs'
import * as path from 'path'
import { LensObject, VaultLayout, InstallManifest } from '../core'

/**
 * VaultDeploy — install a KCD vault into a directory, and report on one that already exists.
 * Driven by `VaultLayout` and `InstallManifest`. `inspect()` and `apply()` share one walk, so the
 * report is the plan, never a second implementation that could disagree with the fill.
 * Safe over existing code: nothing outside the doc root is touched, nothing present is overwritten.
 */

/** What a single deploy step is responsible for. `dir` is an empty directory from the layout table;
 *  `substrate` is one `InstallManifest` row, filled from the bundle; `file` is a seeded document. */
export type DeployItemKind = 'dir' | 'substrate' | 'file'

/**
 * `force` is the difference between REPAIR and RESET: with it, drifted framework files are written back
 * to canonical. It reaches only files the `InstallManifest` claims, so a project's own documents are untouchable.
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
	/** How many files under this step are ABSENT — the repair measurement. `present` says only whether
	 *  the step is satisfied. */
	missingFiles: number
	/** How many files under this step differ from what the bundle ships — the RESET measurement. Always 0
	 *  for a step with no canonical counterpart, which has nothing to drift from. */
	changed: number
}

/**
 * Returned by both `inspect()` and `apply()`, distinguished by `applied`. EVERY COUNT HERE DESCRIBES
 * WHAT THE WALK FOUND, not the state it left: an applied report's `missing` is work done, and a fresh
 * inspect() straight after answers 0. Read an applied report as a record, never as a health check.
 */
export interface DeployReport {
	root:    string
	docRoot: string
	items:   DeployItem[]
	/** How many steps were NOT already satisfied. 0 from inspect() = a complete, healthy vault. */
	missing: number
	/** How many FILES (not steps) differ from canonical across every substrate row — what a reset would
	 *  overwrite. A vault can be complete and still carry fifty edited framework documents. */
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

	/** What this vault is missing, changing nothing. */
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

		// Folders for `scaffold: 'copy'` rows belong here too, so an inspect with no substrate still names them.
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
	 * Every `InstallManifest` row, filled from the bundle. A missing row is reported per row, never thrown,
	 * so one absent optional row cannot leave the rest of the vault half-built.
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
			// Measured whether or not this run acts on it, so a repair preview can report edits without being a reset.
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
	 * Fills `dest` from `source`, retargeting bundled text. Public: the bundled skills land outside the vault with the same `_Claude/…` paths.
	 * Not `fs.cpSync`, because bundled links are not portable. Never overwrites: this FILLS.
	 */
	static fill( source: string, dest: string, docRoot: string, force = false ): void {
		// Required: the skills caller does not create its destination. Dropping this once broke it while the vault caller hid the fault.
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
	 * KCD text is retargeted; anything else is copied byte-for-byte. An allowlist, not a blocklist: a missed text type
	 * costs stale links a person can fix, while decoding a binary as UTF-8 corrupts it silently.
	 */
	private static _fillFile( source: string, dest: string, docRoot: string, force = false ): void {
		// Never overwrite; this FILLS. Even `force` skips a matching file, so no framework mtime moves.
		if( fs.existsSync( dest ) && ( !force || VaultDeploy._matches( source, dest, docRoot ) ) ) return

		if( !TEXT_SUFFIXES.some( ( s ) => source.toLowerCase().endsWith( s ) ) ) {
			fs.copyFileSync( source, dest )
			return
		}
		fs.writeFileSync( dest, VaultLayout.retargetDocRoot( fs.readFileSync( source, 'utf-8' ), docRoot ), 'utf-8' )
	}

	/**
	 * Is `dest` exactly what a fill would have written from `source`? Compared against the retargeted text,
	 * not the bundle's bytes: a vault at `_kcd` holds `_kcd/…` links and would otherwise read as drifted.
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
	 *  Disjoint from `_missingUnder` by design: a missing file is not a changed one. */
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

	/** The vault's root nav-index. Written only when absent, and deliberately minimal — a starting point
	 *  the project grows, not a generated artifact that would fight being edited. */
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
	 * Location is convention — always `<docRoot>/dev-utilities/commands.json`. Seeded EMPTY: a placeholder
	 * launcher would render as a button that does nothing, which is worse than an empty deck.
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
	 * The doc root is a parameter, never a literal, and an ephemeral directory is an address rather than a
	 * link — a link to one fails the validator. Its row still appears, or the map would lie by omission.
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
