import type { ArtifactType } from '../primitives/types'

/**
 * VaultLayout — the canonical KCD directory structure, defined once, in code.
 *
 * The layout used to be written down three times — the SDK's path classifier, the library index's
 * whitelist, and a hand-drawn deployment canvas — and the three had already drifted apart. This
 * table is the single definition all of them derive from: classification, the index whitelist, and
 * the generated `vault-layout` reference. Filling a vault's CONTENTS is `InstallManifest`'s job, not
 * this table's — a vault used to carry its own canonical mirror under a `kcd` row here, but "canonical
 * is not deployed": the framework's master copy lives in the installed package now, and this table
 * only ever describes empty structure.
 *
 * Node-free by design. It is pure data plus string math, so the renderer reads the same structure
 * the main process and the deploy step do.
 *
 * Growing the layout is one row. A directory NOT listed here classifies `unknown` and is never
 * indexed — absence is the safe default, which is what keeps the whitelist meaningful.
 */

/** The two deployment layers left once the substrate moved into the package: `agent` = the
 *  Know+Care+Do artifacts an agent is built from; `data` = everything a project produces. */
export type VaultLayer = 'agent' | 'data'

/** One directory of the canonical layout. */
export interface LayoutEntry {
	/** Vault-relative directory — forward-slashed, no trailing slash. */
	dir: string
	/** What a file directly under this directory classifies as. `unknown` marks a real, expected
	 *  directory that holds no governed artifacts — scratch and output space, not a gap. */
	type: ArtifactType
	layer: VaultLayer
	/** Whether the library index descends into it. */
	indexed: boolean
	/** The one-line description the generated reference publishes. */
	purpose: string
}

/**
 * The table. Order is presentation only — `entryFor` matches the LONGEST directory prefix, so
 * `kcd/templates` beats `kcd` regardless of where either sits here. That means adding a row can
 * never silently change how an existing one classifies.
 */
const LAYOUT: readonly LayoutEntry[] = [

	// ── Agent layer — the Know + Care + Do artifacts an agent is composed from ──
	{
		dir: 'lenses', type: 'lens', layer: 'agent', indexed: true,
		purpose: 'Know+Care personalities. One folder per lens, each holding its lens file and a context/ of support material.'
	},
	{
		dir: 'analyzers', type: 'analyzer', layer: 'agent', indexed: true,
		purpose: 'Read-anywhere, write-one-report agents.'
	},
	{
		dir: 'generators', type: 'generator', layer: 'agent', indexed: true,
		purpose: 'Manifest-driven write agents — broad write authority, no judgment of their own.'
	},
	{
		dir: 'habits', type: 'habit', layer: 'agent', indexed: true,
		purpose: 'Atomic behavior fragments. Flat files, no subfolders.'
	},

	// ── Data / output layer — what a project accumulates as it runs ──
	{
		dir: 'references', type: 'reference', layer: 'data', indexed: true,
		purpose: 'The project knowledge store, categorized by folder — the folder IS the category.'
	},
	{
		dir: 'contracts', type: 'contract', layer: 'data', indexed: true,
		purpose: 'Behavioral agreements — composable prose a third party can evaluate against.'
	},
	{
		dir: 'utilities', type: 'utility', layer: 'data', indexed: true,
		purpose: 'The registered tool tier — draft/ (unapproved) and deployed/ (approved), with a registry.'
	},
	{
		dir: 'plans', type: 'plan', layer: 'data', indexed: true,
		purpose: 'Promoted plans that authorize action, plus the plans_complete/ and plans_deferred/ buckets beneath.'
	},

	// ── Data / output layer, untyped ──
	// Real, expected directories that hold no governed artifacts. Listed rather than omitted so a
	// deploy knows to create them and the index knows to skip them — a directory absent from this
	// table is genuinely unrecognized, which is a different and useful signal. Agentic work generates
	// drift and throwaway content fast; these are where it is allowed to land.
	{
		dir: 'work', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Per-lens scratch space (AI/, human/, plans/). Cheap and discardable until something is promoted out of it.'
	},
	{
		dir: 'logs', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Session log plus per-lens completed/, todo/, and agent-status/.'
	},
	{
		dir: 'reports', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Analyzer output.'
	},
	{
		dir: 'audits', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Generator raw output and vault backups. Deliberately unindexed — backup copies here are what made the library accrue duplicate references.'
	},
	{
		dir: 'scratch', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Free scratch space with no per-lens structure.'
	},
	{
		dir: 'dev-utilities', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'The dev command deck — JSON-declared scripts run against the project, not governed artifacts.'
	}

]

/** The filename that is a nav-index wherever it sits. */
const NAV_INDEX_FILE = 'nav-index.html'

/** Framework-layer documents that live directly at vault root — `InstallManifest` deploys them
 *  there, but they sit outside every `LAYOUT` directory row, so `classify` special-cases them the
 *  same way it does `NAV_INDEX_FILE`. */
const FRAMEWORK_ROOT_FILES = [ 'root.html', 'root-context.html', 'kcd_framework.html' ]

/** Path depth at which a file under `lenses/` stops being the lens itself: `lenses/{name}/{file}`
 *  is the lens, anything deeper is support material. */
const LENS_MAX_DEPTH = 3

export class VaultLayout {

	/** Every row, in table order — for the doc generator and anything enumerating the structure. */
	static all(): readonly LayoutEntry[] {
		return LAYOUT
	}

	/**
	 * The row governing a vault-relative path ( the part BELOW the doc root ), or null when nothing
	 * owns it. Longest matching directory prefix wins, so a more specific row always beats a shorter
	 * one it also sits under.
	 */
	static entryFor( sub: string ): LayoutEntry | null {
		const norm = sub.replace( /\\/g, '/' )
		let best: LayoutEntry | null = null
		for( const entry of LAYOUT ) {
			if( norm !== entry.dir && !norm.startsWith( entry.dir + '/' ) ) continue
			if( best && best.dir.length >= entry.dir.length ) continue
			best = entry
		}
		return best
	}

	/**
	 * A vault-root-relative path ( `_Claude/...` ) to its artifact type — the one path taxonomy.
	 *
	 * Four rules run before the table, because none of them is decided by which folder a file sits
	 * in: a nav-index is a nav-index anywhere; a root-level framework file is `framework` regardless
	 * of the table; a `context/` descendant is support material for whatever owns it; and inside
	 * `lenses/`, only the lens's own file is the lens. Everything else is the table.
	 */
	static classify( relPath: string, docRoot = '_Claude' ): ArtifactType {
		const norm = relPath.replace( /\\/g, '/' )
		if( !norm.startsWith( docRoot + '/' ) ) return 'unknown'
		if( norm.endsWith( '/' + NAV_INDEX_FILE ) ) return 'nav-index'

		const sub = norm.slice( docRoot.length + 1 )
		if( FRAMEWORK_ROOT_FILES.includes( sub ) ) return 'framework'
		if( sub.includes( '/context/' ) ) return 'reference'

		const entry = VaultLayout.entryFor( sub )
		if( !entry ) return 'unknown'
		if( entry.dir === 'lenses' && sub.split( '/' ).length > LENS_MAX_DEPTH ) return 'reference'

		return entry.type
	}

	/**
	 * The top-level directory names the library index descends into — the scanner's whitelist gates
	 * only immediate children of the doc root, so a nested indexed row ( `kcd/templates` ) folds into
	 * its top-level segment ( `kcd` ) rather than appearing on its own.
	 */
	static indexedDirs(): string[] {
		const out = new Set<string>()
		for( const entry of LAYOUT ) {
			if( !entry.indexed ) continue
			out.add( entry.dir.split( '/' )[ 0 ] )
		}
		return [ ...out ]
	}

	/**
	 * The inverse of `indexedDirs` — scratch and output space. These directories are not part of the
	 * library and are NOT installed into a user's vault, so occupancy inside them can never be
	 * asserted. Protocol §1.1 therefore forbids a link into one; an address is the correct encoding.
	 *
	 * Derived from the registry rather than written out, so the ban tracks the layout automatically
	 * and there is no second list to keep in step.
	 */
	static ephemeralDirs(): string[] {
		const indexed = new Set( VaultLayout.indexedDirs() )
		const out = new Set<string>()
		for( const entry of LAYOUT ) {
			const top = entry.dir.split( '/' )[ 0 ]
			if( !indexed.has( top ) ) out.add( top )
		}
		return [ ...out ]
	}

	/**
	 * Does a project-root-relative href land in ephemeral space? Hrefs resolve against the PROJECT
	 * root ( `resolveHref` ), so a vault target carries its doc-root segment — `_Claude/work/x` — and
	 * that segment is stripped before the first path element is judged.
	 */
	static isEphemeralHref( href: string, docRoot = '_Claude' ): boolean {
		const parts = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' ).filter( p => p !== '' )

		// Accepts both an href ( `_Claude/work/x` ) and an absolute file path
		// ( `C:/…/_Claude/work/x` ), by anchoring on the doc-root segment wherever it appears. Without
		// the anchor the leading segment is taken as-is, which is the plain relative-href case.
		const anchor = parts.lastIndexOf( docRoot )
		const top    = anchor >= 0 ? parts[ anchor + 1 ] : parts[ 0 ]

		return top !== undefined && VaultLayout.ephemeralDirs().includes( top )
	}

}
