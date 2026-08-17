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
	/** Retired content — still shipped, still linkable, but NOT graded.
	 *
	 *  Deliberately distinct from `indexed: false`. Ephemeral means "not installed into a vault at
	 *  all", which is why protocol §1.1 forbids linking into it. Archival means the opposite on that
	 *  axis: the content ships and live artifacts legitimately link to it for provenance. What it
	 *  stops being is held to the CURRENT standard — a document retired under an older one is a
	 *  historical record, and grading it reports a category error rather than a defect.
	 *
	 *  Matched by LONGEST PREFIX rather than top-level segment, so a nested bucket can be archival
	 *  while its parent stays graded. That is the whole reason the flag exists separately. */
	archival?: boolean
	/** The document types this directory ACCEPTS on a write, when that is broader than the single type
	 *  it implies. Absent ⇒ exactly `[ type ]`, which is the common case.
	 *
	 *  This exists because "what is here" and "may this land here" are different questions, and a write
	 *  guard that answers the first cannot answer the second. `utilities/` implies `utility`, which is not
	 *  a document type at all — so without this the directory would accept no document, and the registry
	 *  that belongs there could never be written. Collapsing the two questions into one equality check is
	 *  what made a valid on-disk document impossible to save back. */
	accepts?: readonly ArtifactType[]
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
		// No `accepts` row: every document here is a `reference`. The subfolders ARE the categories, and
		// there is deliberately no type per category — `note` and `how-to` briefly had one and were
		// retired for exactly that reason ( see ArtifactType ).
		dir: 'references', type: 'reference', layer: 'data', indexed: true,
		purpose: 'The project knowledge store, categorized by folder — the folder IS the category.'
	},
	{
		dir: 'contracts', type: 'contract', layer: 'data', indexed: true,
		purpose: 'Behavioral agreements — composable prose a third party can evaluate against.'
	},
	{
		dir: 'utilities', type: 'utility', layer: 'data', indexed: true,
		// `utility` is not a document type — the protocol says so outright — so a directory implying it
		// accepts NO document at all unless this says otherwise. The registry the purpose line names is a
		// document about utilities, which is a reference.
		accepts: [ 'utility', 'reference', 'nav-index' ],
		purpose: 'The registered tool tier — draft/ (unapproved) and deployed/ (approved), with a registry.'
	},
	{
		dir: 'plans', type: 'plan', layer: 'data', indexed: true,
		purpose: 'Promoted plans that authorize action, plus the plans_complete/ and plans_deferred/ buckets beneath.'
	},
	{
		// Nested and ARCHIVAL, not ephemeral — the distinction is load-bearing. Retired plans are linked
		// from live artifacts for provenance ( 23 of them at last count, 50 link sites in the plans
		// nav-index alone ), so putting them in ephemeral space would make every one of those links
		// illegal under §1.1. They ship; they are simply not graded.
		dir: 'plans/plans_complete', type: 'plan', layer: 'data', indexed: true, archival: true,
		purpose: 'Retired plans, kept as a historical record. Shipped and linkable, but never graded — the standard they were written against has moved on.'
	},
	{
		// Archival for the OPPOSITE reason to plans_complete: not "the standard moved on after this was
		// written" but "this has not been brought up to standard yet". A deferred plan is a draft in
		// churn — many are abandoned rather than finished — so grading it reports what everyone already
		// knows and makes a clean vault harder to reach for no gain.
		//
		// THE WALL IS AT THE EXIT, NOT THE ENTRANCE. A deferred plan is graded when it is promoted OUT
		// of here, which is the moment before it authorizes anything; until then it authorizes nothing.
		// Grading it earlier buys no safety. And the exclusion binds only the unscoped sweep — anyone
		// who wants a verdict on a parked draft names the file and gets one.
		dir: 'plans/plans_deferred', type: 'plan', layer: 'data', indexed: true, archival: true,
		purpose: 'Parked drafts, kept in case they come back. Shipped and linkable, but never graded — a draft in churn is held to the standard when it is promoted out, not while it sits.'
	},
	{
		// `data`, not `agent`: a partial is never composed INTO an agent. It is appended after context
		// compilation as part of the user message, which is exactly why it sits with what a project produces
		// rather than with what an agent is built from.
		dir: 'prompts', type: 'prompt-partial', layer: 'data', indexed: true,
		purpose: 'Reusable prompt wording a human fills in — the text a task sends, kept where it can be read and edited.'
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

/** Framework-layer documents that live directly at vault root — `InstallManifest` deploys them
 *  there, but they sit outside every `LAYOUT` directory row, so `classify` special-cases them the
 *  same way it does `NAV_INDEX_FILE`. */
const FRAMEWORK_ROOT_FILES = [ 'root.html', 'root-context.html', 'kcd_framework.html' ]

/** Path depth at which a file under `lenses/` stops being the lens itself: `lenses/{name}/{file}`
 *  is the lens, anything deeper is support material. */
const LENS_MAX_DEPTH = 3

export class VaultLayout {

	/** The filename that IS a nav-index, wherever it sits — the name carries the type, so a nav-index
	 *  under any other filename is not one. Public because three places had their own copy of the
	 *  string; the table that owns the taxonomy should own this too. */
	static readonly NAV_INDEX_FILE = 'nav-index.html'

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
		if( norm.endsWith( '/' + VaultLayout.NAV_INDEX_FILE ) ) return 'nav-index'

		const sub = norm.slice( docRoot.length + 1 )
		if( FRAMEWORK_ROOT_FILES.includes( sub ) ) return 'framework'
		if( sub.includes( '/context/' ) ) return 'reference'

		const entry = VaultLayout.entryFor( sub )
		if( !entry ) return 'unknown'
		if( entry.dir === 'lenses' && sub.split( '/' ).length > LENS_MAX_DEPTH ) return 'reference'

		return entry.type
	}

	/**
	 * Every document type that may legally be WRITTEN at this path — the write-time counterpart of
	 * `classify`. Classification answers "what is here"; this answers "what may land here", and the two
	 * differ wherever a directory holds a family rather than a single type.
	 *
	 * Always includes what `classify` returns, so the two can never disagree about the obvious case. An
	 * empty array means anything goes: `unknown` is scratch space, and scratch that refused writes would
	 * be useless.
	 */
	static acceptedTypes( relPath: string, docRoot = '_Claude' ): readonly ArtifactType[] {
		const implied = VaultLayout.classify( relPath, docRoot )
		if( implied === 'unknown' ) return []

		const norm  = relPath.replace( /\\/g, '/' )
		const entry = VaultLayout.entryFor( norm.slice( docRoot.length + 1 ) )
		const extra = entry?.accepts ?? []

		return extra.includes( implied ) ? extra : [ implied, ...extra ]
	}

	/**
	 * May a document declaring `declared` be written at this path? The one question a write guard should
	 * ask. An empty accepted set is untyped space and takes anything.
	 */
	static accepts( relPath: string, declared: ArtifactType, docRoot = '_Claude' ): boolean {
		const allowed = VaultLayout.acceptedTypes( relPath, docRoot )
		return allowed.length === 0 || allowed.includes( declared )
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
	 * The directories holding retired content — shipped and linkable, but not graded.
	 *
	 * Unlike `ephemeralDirs`, these are NOT collapsed to a top-level segment. The point of an archival
	 * row is that a nested bucket differs from its parent, so the full declared prefix is what matters:
	 * collapsing would archive `plans/` whole, or nothing at all.
	 */
	static archivalDirs(): string[] {
		return LAYOUT.filter( e => e.archival ).map( e => e.dir )
	}

	/**
	 * Does this path land in archival space? LONGEST-PREFIX match on the doc-root-anchored remainder,
	 * using the same anchoring `isEphemeralHref` does — so an href ( `_Claude/plans/plans_complete/x` ),
	 * a vault-relative path, and an absolute file path all answer alike.
	 *
	 * A path is archival if it IS a declared directory or sits beneath one. Segment-boundary matching,
	 * never bare `startsWith`: `plans/plans_completed-notes` must not match `plans/plans_complete`.
	 */
	static isArchivalPath( href: string, docRoot = '_Claude' ): boolean {
		const parts  = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' ).filter( p => p !== '' )
		const anchor = parts.lastIndexOf( docRoot )
		const rel    = ( anchor >= 0 ? parts.slice( anchor + 1 ) : parts ).join( '/' )
		return VaultLayout.archivalDirs().some( d => rel === d || rel.startsWith( d + '/' ) )
	}

	/**
	 * Does a project-root-relative href land in ephemeral space? Hrefs resolve against the PROJECT
	 * root ( `resolveHref` ), so a vault target carries its doc-root segment — `_Claude/work/x` — and
	 * that segment is stripped before the first path element is judged.
	 *
	 * TOP-LEVEL segment only, deliberately — contrast `isArchivalPath` above, which matches the longest
	 * declared prefix. The two exclusions are not interchangeable: ephemeral content never ships and may
	 * not be linked into ( §1.1 ); archival content ships and must stay linkable.
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
