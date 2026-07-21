import type { ArtifactType } from '../primitives/types'

/**
 * VaultLayout — the canonical KCD directory structure, defined once, in code.
 *
 * The layout used to be written down three times — the SDK's path classifier, the library index's
 * whitelist, and a hand-drawn deployment canvas — and the three had already drifted apart. This
 * table is the single definition all of them derive from: classification, the index whitelist, the
 * deploy scaffold, and the generated `vault-layout` reference.
 *
 * Node-free by design. It is pure data plus string math, so the renderer reads the same structure
 * the main process and the deploy step do.
 *
 * Growing the layout is one row. A directory NOT listed here classifies `unknown` and is never
 * indexed — absence is the safe default, which is what keeps the whitelist meaningful.
 */

/** The three deployment layers. `agent` = the Know+Care+Do artifacts an agent is built from;
 *  `substrate` = the locked canonical framework library; `data` = everything a project produces. */
export type VaultLayer = 'agent' | 'substrate' | 'data'

/** What a deploy does with a directory — create it empty, or fill it from the canonical master. */
export type ScaffoldMode = 'mkdir' | 'copy'

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
	scaffold: ScaffoldMode
	/** The one-line description the generated reference publishes. */
	purpose: string
}

/**
 * The table. Order is presentation only — `entryFor` matches the LONGEST directory prefix, so
 * `kcd/templates` beats `kcd` regardless of where either sits here. That means adding a row can
 * never silently change how an existing one classifies.
 */
const LAYOUT: readonly LayoutEntry[] = [

	// ── Canonical substrate — the locked framework library, copied in at deploy ──
	{
		dir: 'kcd', type: 'framework', layer: 'substrate', indexed: true, scaffold: 'copy',
		purpose: 'The locked canonical framework library. Never edited in a deployed instance — changes belong in the framework\'s own repo.'
	},
	{
		dir: 'kcd/templates', type: 'template', layer: 'substrate', indexed: true, scaffold: 'copy',
		purpose: 'Authoring scaffolds — copy one, fill the placeholders, delete the scaffold note.'
	},

	// ── Agent layer — the Know + Care + Do artifacts an agent is composed from ──
	{
		dir: 'lenses', type: 'lens', layer: 'agent', indexed: true, scaffold: 'mkdir',
		purpose: 'Know+Care personalities. One folder per lens, each holding its lens file and a context/ of support material.'
	},
	{
		dir: 'analyzers', type: 'analyzer', layer: 'agent', indexed: true, scaffold: 'mkdir',
		purpose: 'Read-anywhere, write-one-report agents.'
	},
	{
		dir: 'generators', type: 'generator', layer: 'agent', indexed: true, scaffold: 'mkdir',
		purpose: 'Manifest-driven write agents — broad write authority, no judgment of their own.'
	},
	{
		dir: 'habits', type: 'habit', layer: 'agent', indexed: true, scaffold: 'mkdir',
		purpose: 'Atomic behavior fragments. Flat files, no subfolders.'
	},

	// ── Data / output layer — what a project accumulates as it runs ──
	{
		dir: 'references', type: 'reference', layer: 'data', indexed: true, scaffold: 'mkdir',
		purpose: 'The project knowledge store, categorized by folder — the folder IS the category.'
	},
	{
		dir: 'contracts', type: 'contract', layer: 'data', indexed: true, scaffold: 'mkdir',
		purpose: 'Behavioral agreements — composable prose a third party can evaluate against.'
	},
	{
		dir: 'utilities', type: 'utility', layer: 'data', indexed: true, scaffold: 'mkdir',
		purpose: 'The registered tool tier — draft/ (unapproved) and deployed/ (approved), with a registry.'
	},
	{
		dir: 'plans', type: 'plan', layer: 'data', indexed: true, scaffold: 'mkdir',
		purpose: 'Promoted plans that authorize action, plus the plans_complete/ and plans_deferred/ buckets beneath.'
	},

	// ── Data / output layer, untyped ──
	// Real, expected directories that hold no governed artifacts. Listed rather than omitted so a
	// deploy knows to create them and the index knows to skip them — a directory absent from this
	// table is genuinely unrecognized, which is a different and useful signal. Agentic work generates
	// drift and throwaway content fast; these are where it is allowed to land.
	{
		dir: 'work', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'Per-lens scratch space (AI/, human/, plans/). Cheap and discardable until something is promoted out of it.'
	},
	{
		dir: 'logs', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'Session log plus per-lens completed/, todo/, and agent-status/.'
	},
	{
		dir: 'reports', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'Analyzer output.'
	},
	{
		dir: 'audits', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'Generator raw output and vault backups. Deliberately unindexed — backup copies here are what made the library accrue duplicate references.'
	},
	{
		dir: 'scratch', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'Free scratch space with no per-lens structure.'
	},
	{
		dir: 'dev-utilities', type: 'unknown', layer: 'data', indexed: false, scaffold: 'mkdir',
		purpose: 'The dev command deck — JSON-declared scripts run against the project, not governed artifacts.'
	}

]

/** The filename that is a nav-index wherever it sits. */
const NAV_INDEX_FILE = 'nav-index.html'

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
	 * owns it. Longest matching directory prefix wins, so `kcd/templates/x.html` resolves to the
	 * templates row and not the `kcd` row it also sits under.
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
	 * Three rules run before the table, because none of them is decided by which folder a file sits
	 * in: a nav-index is a nav-index anywhere; a `context/` descendant is support material for
	 * whatever owns it; and inside `lenses/`, only the lens's own file is the lens. Everything else
	 * is the table.
	 */
	static classify( relPath: string, docRoot = '_Claude' ): ArtifactType {
		const norm = relPath.replace( /\\/g, '/' )
		if( !norm.startsWith( docRoot + '/' ) ) return 'unknown'
		if( norm.endsWith( '/' + NAV_INDEX_FILE ) ) return 'nav-index'

		const sub = norm.slice( docRoot.length + 1 )
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

}
