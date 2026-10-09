import type { ArtifactType } from '../primitives/types'

/**
 * VaultLayout — the canonical KCD directory structure, defined once. Classification, the index whitelist and the
 * generated `vault-layout` reference all derive from this table, and it describes EMPTY structure only: filling a
 * vault is `InstallManifest`'s job. Node-free, so the renderer reads the same structure as the main process.
 *
 * Growing the layout is one row. A directory NOT listed classifies `unknown` and is never indexed — absence is the
 * safe default, which is what keeps the whitelist meaningful.
 */

/** `agent` is the Know+Care+Do layer, `data` what a project produces. `agent` NAMES THE LAYER, NEVER THE ARTIFACT:
 *  nothing here is an actor. `layer` is a grouping label, not a behaviour switch. */
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
	/** Retired content: still shipped and linkable for provenance, but NOT graded. Distinct from `indexed: false`,
	 *  which means not installed and illegal to link into. LONGEST PREFIX, so a nested bucket can be archival. */
	archival?: boolean
	/** Machine state that must SURVIVE a sweep of the directory it sits in. Independent of `indexed`: a durable row is
	 *  still unindexed and illegal to link, so protecting it from deletion must not make it citable. LONGEST PREFIX. */
	durable?: boolean
	/** The document types this directory ACCEPTS on a write, when broader than the type it implies. Absent ⇒ `[ type ]`.
	 *  "What is here" and "may this land here" are different questions; a write guard has to answer the second. */
	accepts?: readonly ArtifactType[]
	/** Where this directory's documents are DRAFTED before landing here: a path under ephemeral space, `*` = one per lens.
	 *  A draft authorizes nothing and is listed as an ADDRESS only (protocol §1.1). */
	drafts?: string
	/** The one-line description the generated reference publishes. */
	purpose: string
}

/** Order is presentation only: `entryFor` matches the LONGEST directory prefix, so adding a row never silently
 *  changes how an existing one classifies. */
const LAYOUT: readonly LayoutEntry[] = [

	// ── Agent layer — the Know + Care + Do artifacts an agent is composed from ──
	{
		dir: 'lenses', type: 'lens', layer: 'agent', indexed: true,
		purpose: 'Know+Care personalities. One folder per lens, each holding its lens file and a context/ of support material.'
	},
	{
		dir: 'analyzers', type: 'analyzer', layer: 'agent', indexed: true,
		purpose: 'Read-anywhere, write-one-report SKILLS. Not a second kind of actor — see the note on `VaultLayer`.'
	},
	{
		dir: 'generators', type: 'generator', layer: 'agent', indexed: true,
		purpose: 'Manifest-driven write SKILLS — broad write authority, no judgment of their own.'
	},
	{
		dir: 'habits', type: 'habit', layer: 'agent', indexed: true,
		purpose: 'Atomic behavior fragments. One folder per habit-class holding its mutually-exclusive poles, plus unslotted/ for habits that fill no slot.'
	},

	// ── Data / output layer — what a project accumulates as it runs ──
	{
		// No `accepts` row: every document here is a `reference`. The subfolders ARE the categories, so there is
		// deliberately no type per category ( see ArtifactType ).
		dir: 'references', type: 'reference', layer: 'data', indexed: true,
		purpose: 'The project knowledge store, categorized by folder — the folder IS the category.'
	},
	{
		dir: 'contracts', type: 'contract', layer: 'data', indexed: true,
		purpose: 'Invocable procedures — composable prose a third party can evaluate against.'
	},
	{
		dir: 'utilities', type: 'utility', layer: 'data', indexed: true,
		// `utility` is not a document type, so without `accepts` this directory would accept no document at all.
		// The registry the purpose line names is a reference.
		accepts: [ 'utility', 'reference', 'nav-index' ],
		purpose: 'The registered tool tier — draft/ (unapproved) and deployed/ (approved), with a registry.'
	},
	{
		dir: 'plans', type: 'plan', layer: 'data', indexed: true, drafts: 'work/*/plans',
		purpose: 'Promoted plans that authorize action, plus the plans_complete/ and plans_deferred/ buckets beneath.'
	},
	{
		// Nested and ARCHIVAL, not ephemeral: live artifacts link retired plans for provenance, and ephemeral space
		// would make every one of those links illegal under §1.1. They ship; they are simply not graded.
		dir: 'plans/plans_complete', type: 'plan', layer: 'data', indexed: true, archival: true,
		purpose: 'Retired plans, kept as a historical record. Shipped and linkable, but never graded — the standard they were written against has moved on.'
	},
	{
		// Archival for the OPPOSITE reason to plans_complete: a parked draft is in churn, not yet at standard.
		// THE WALL IS AT THE EXIT: graded when promoted out, and only an unscoped sweep skips it while it sits.
		dir: 'plans/plans_deferred', type: 'plan', layer: 'data', indexed: true, archival: true,
		purpose: 'Parked drafts, kept in case they come back. Shipped and linkable, but never graded — a draft in churn is held to the standard when it is promoted out, not while it sits.'
	},
	{
		// `data`, not `agent`: a partial is never composed INTO an agent. It is appended after context compilation,
		// as part of the user message.
		dir: 'prompts', type: 'prompt-partial', layer: 'data', indexed: true,
		purpose: 'Reusable prompt wording a human fills in — the text a task sends, kept where it can be read and edited.'
	},

	// ── Data / output layer, untyped ──
	// Real directories holding no governed artifacts, listed so a deploy creates them. Absence from this table
	// means unrecognized, which is a different signal.
	{
		dir: 'work', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Per-lens scratch space (AI/, human/, plans/). Cheap and discardable until something is promoted out of it.'
	},
	{
		dir: 'logs', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Per-lens todo/ and agent-status/, plus raw chat capture. What happened is the action log, a table, not a file here.'
	},
	{
		// `unknown` is deliberate: an audit produces a searchable note, not a governed document.
		dir: 'reports', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Being emptied. Held analyzer output under fixed, undated names until audits became searchable notes rather than documents; nothing governed lands here now.'
	},
	{
		dir: 'bug-reports', type: 'bug-report', layer: 'data', indexed: false,
		purpose: 'Filed defects and the proof of their repair ( the bug-report contract ). Ephemeral — verified reports are deleted at the monthly sweep.'
	},
	{
		dir: 'audits', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Generator raw output and vault backups. Deliberately unindexed — backup copies here are what made the library accrue duplicate references. Disposable, EXCEPT ledgers/ beneath it.'
	},
	{
		// Durable inside disposable `audits/`, and the nesting is the point. `indexed: false` stays: a ledger is
		// machine state, never a link target; `durable` only forbids deleting it.
		dir: 'audits/ledgers', type: 'unknown', layer: 'data', indexed: false, durable: true,
		purpose: 'Analyzer coverage ledgers — durable state the audit analyzers read and rewrite across runs. Unindexed and never a link target, like the rest of audits/, but NOT disposable: these carry what has already been audited.'
	},
	{
		dir: 'scratch', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Free scratch space with no per-lens structure.'
	},
	{
		dir: 'dev-utilities', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'The dev command deck — JSON-declared scripts run against the project, not governed artifacts.'
	},
	{
		// Plain HTML reports with no `<article data-kcd>` root, by design. Unindexed so a vault-wide sweep does not
		// report them as parse failures.
		dir: 'research', type: 'unknown', layer: 'data', indexed: false,
		purpose: 'Sourced research reports and their templates — plain HTML, styled by research.css, never KCD artifacts.'
	}

]

/** Framework documents at vault root, outside every `LAYOUT` row; `classify` special-cases them like `NAV_INDEX_FILE`. */
const FRAMEWORK_ROOT_FILES = [ 'root.html', 'root-context.html', 'kcd_framework.html' ]

/** Path depth at which a file under `lenses/` stops being the lens itself: `lenses/{name}/{file}`
 *  is the lens, anything deeper is support material. */
const LENS_MAX_DEPTH = 3

export class VaultLayout {

	/** The filename that IS a nav-index, wherever it sits: the name carries the type. Public, so no copy is kept. */
	static readonly NAV_INDEX_FILE = 'nav-index.html'

	/** The vault folder's name WHEN NOBODY DECLARED ONE: a default, never a fact. Defined once, here. */
	static readonly DEFAULT_DOC_ROOT = '_Claude'

	/** Text authored against the DEFAULT doc root, retargeted at the vault it lands in. Identity for the default,
	 *  so the ordinary install is untouched; anywhere else, every occurrence of the default is wrong by construction. */
	static retargetDocRoot( text: string, docRoot: string ): string {
		if( !docRoot || docRoot === VaultLayout.DEFAULT_DOC_ROOT ) return text
		return text.split( VaultLayout.DEFAULT_DOC_ROOT ).join( docRoot )
	}

	/** Every row, in table order — for the doc generator and anything enumerating the structure. */
	static all(): readonly LayoutEntry[] {
		return LAYOUT
	}

	/** The row governing a path BELOW the doc root, or null. Longest directory prefix wins, so a more specific
	 *  row always beats a shorter one it sits under. */
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

	/** A vault-root-relative path to its artifact type. Four rules run before the table, none decided by folder:
	 *  a nav-index anywhere, a framework file at root, `context/` as support material, inside `lenses/` only the lens file. */
	static classify( relPath: string, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): ArtifactType {
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

	/** Types that may legally be WRITTEN here: the write-time counterpart of `classify`, always including its answer.
	 *  An empty array means anything goes; `unknown` is scratch, and scratch that refused writes would be useless. */
	static acceptedTypes( relPath: string, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): readonly ArtifactType[] {
		const implied = VaultLayout.classify( relPath, docRoot )
		if( implied === 'unknown' ) return []

		const norm  = relPath.replace( /\\/g, '/' )
		const entry = VaultLayout.entryFor( norm.slice( docRoot.length + 1 ) )
		const extra = entry?.accepts ?? []

		return extra.includes( implied ) ? extra : [ implied, ...extra ]
	}

	/** May a document declaring `declared` be written at this path? The one question a write guard should ask. */
	static accepts( relPath: string, declared: ArtifactType, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): boolean {
		const allowed = VaultLayout.acceptedTypes( relPath, docRoot )
		return allowed.length === 0 || allowed.includes( declared )
	}

	/** Top-level directory names the library index descends into; a nested indexed row folds into its top segment. */
	static indexedDirs(): string[] {
		const out = new Set<string>()
		for( const entry of LAYOUT ) {
			if( !entry.indexed ) continue
			out.add( entry.dir.split( '/' )[ 0 ] )
		}
		return [ ...out ]
	}

	/** The inverse of `indexedDirs`: scratch and output space, never installed, so no occupancy can be asserted.
	 *  Protocol §1.1 forbids a link into one; an address is the encoding. Derived from the registry: no second list. */
	static ephemeralDirs(): string[] {
		const indexed = new Set( VaultLayout.indexedDirs() )
		const out = new Set<string>()
		for( const entry of LAYOUT ) {
			const top = entry.dir.split( '/' )[ 0 ]
			if( !indexed.has( top ) ) out.add( top )
		}
		return [ ...out ]
	}

	/** The directories holding retired content: shipped and linkable, not graded. NOT collapsed to a top segment,
	 *  unlike `ephemeralDirs`: collapsing would archive `plans/` whole, not just its retired bucket. */
	static archivalDirs(): string[] {
		return LAYOUT.filter( e => e.archival ).map( e => e.dir )
	}

	/** Is this path archival? Segment-boundary prefix match on the doc-root-anchored remainder, so an href and an absolute
	 *  path answer alike. Never bare `startsWith`: `plans/plans_completed-notes` must not match `plans/plans_complete`. */
	static isArchivalPath( href: string, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): boolean {
		const parts  = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' ).filter( p => p !== '' )
		const anchor = parts.lastIndexOf( docRoot )
		const rel    = ( anchor >= 0 ? parts.slice( anchor + 1 ) : parts ).join( '/' )
		return VaultLayout.archivalDirs().some( d => rel === d || rel.startsWith( d + '/' ) )
	}

	/** The directories holding durable machine state, NOT collapsed to a top segment. THE ONE PLACE TO ASK: anything
	 *  that cleans or empties part of a vault reads this rather than keeping a second list. */
	static durableDirs(): string[] {
		return LAYOUT.filter( e => e.durable ).map( e => e.dir )
	}

	/** Does this path hold durable state? Same matching as `isArchivalPath`. Segment-boundary, never bare `startsWith`:
	 *  a sibling `audits/ledgers-old` is a different directory and is NOT protected by the `audits/ledgers` row. */
	static isDurablePath( href: string, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): boolean {
		const parts  = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' ).filter( p => p !== '' )
		const anchor = parts.lastIndexOf( docRoot )
		const rel    = ( anchor >= 0 ? parts.slice( anchor + 1 ) : parts ).join( '/' )
		return VaultLayout.durableDirs().some( d => rel === d || rel.startsWith( d + '/' ) )
	}

	/** Does a project-root-relative href land in ephemeral space? Judged on the element after the doc-root segment.
	 *  TOP-LEVEL only, deliberately: ephemeral may not be linked into (§1.1), archival must stay linkable. */
	static isEphemeralHref( href: string, docRoot = VaultLayout.DEFAULT_DOC_ROOT ): boolean {
		const parts = href.replace( /\\/g, '/' ).replace( /^\.\//, '' ).split( '/' ).filter( p => p !== '' )

		// Anchors on the doc-root segment wherever it appears, so an href and an absolute path answer alike.
		const anchor = parts.lastIndexOf( docRoot )
		const top    = anchor >= 0 ? parts[ anchor + 1 ] : parts[ 0 ]

		return top !== undefined && VaultLayout.ephemeralDirs().includes( top )
	}

}
