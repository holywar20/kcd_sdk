/**
 * InstallManifest — what a fresh vault needs from the kit's bundled substrate, and where it lands.
 *
 * "Canonical is not deployed": the framework library's master copy lives in the installed PACKAGE
 * ( `daedalus/substrate/` ), never inside a project's own vault. A vault used to carry its own
 * `kcd/` mirror of that master — this table is what replaced it. `VaultDeploy` walks these rows to
 * fill a new vault; `VaultUtilities.reset` walks them the other direction, to find one deployed
 * path's canonical counterpart in the bundle.
 *
 * Directory-level, same idiom as `VaultLayout`: a handful of declared rows, not one per file, so the
 * table doesn't drift out of step with what the bundle actually contains. `bundleSource` and
 * `vaultHome` are independent — the bundle's own internal shape does not have to mirror the vault's.
 *
 * Node-free by design, like `VaultLayout` — pure data, so both the deploy step ( Node ) and anything
 * that only needs to reason about the shape ( renderer, docs generator ) can read the same table.
 */

/** One row: a piece of the bundle, and the vault-relative home it fills. `required` rows are the
 *  framework's own floor — a vault missing one cannot function as a KCD project. `optional` rows are
 *  filled when present in the bundle but their absence is not a defect. */
export interface ManifestEntry {
	/** Path relative to the bundle's substrate root ( `daedalus/substrate/` ). */
	bundleSource: string
	/** Vault-relative target — below the docRoot. */
	vaultHome: string
	required: boolean
	purpose: string
}

/** The base lens's filename — `_`-prefixed because it is INFRASTRUCTURE, not an authored domain lens
 *  ( the KCD naming rule, see `KcdAddress` ). Declared here rather than in each reader because the
 *  string was being re-spelled at five call sites that all had to agree about the inheritance floor. */
const BASE_LENS_FILE = '_lens-base.html'

const MANIFEST: readonly ManifestEntry[] = [

	{
		bundleSource: `lenses/${ BASE_LENS_FILE }`, vaultHome: `lenses/${ BASE_LENS_FILE }`, required: true,
		purpose: 'The base lens, auto-loaded into every session. A vault without it has no floor to stand on.'
	},
	{
		bundleSource: 'lenses/lens-crafter', vaultHome: 'lenses/lens-crafter', required: true,
		purpose: 'The authoring lens. REQUIRED, not a nicety: the bundled kcd-configure skill defers all lens-authoring taste to it ( `kcd_compile { lenses: ["lens-crafter"] }` ) before writing anything, so a vault without it leaves the one shipped skill compiling nothing at the exact step where it starts producing value. Shipped as a directory so the lens keeps its `{name}/{name}.html` + `context/` anatomy.'
	},
	{
		bundleSource: 'habits', vaultHome: 'habits', required: true,
		purpose: 'Atomic behavior fragments the base lens and every domain lens link into.'
	},
	{
		bundleSource: 'analyzers/_analyzer_base.html', vaultHome: 'analyzers/_analyzer_base.html', required: true,
		purpose: 'The shared analyzer contract every read-anywhere, write-one-report agent extends.'
	},
	{
		bundleSource: 'generators', vaultHome: 'generators', required: true,
		purpose: 'The base generator contract plus the bundled manifest-driven write agents.'
	},
	{
		bundleSource: 'contracts', vaultHome: 'contracts', required: true,
		purpose: 'The behavioral agreements the bundled lenses and generators are evaluated against.'
	},
	{
		bundleSource: 'references/kcd_sdk', vaultHome: 'references/kcd_sdk', required: true,
		purpose: 'The protocol and primitives references the framework itself assumes a vault can link to.'
	},
	{
		bundleSource: 'references/how-to', vaultHome: 'references/how-to', required: true,
		purpose: 'Procedural references the bundled lenses link into by path. Currently read-a-survey, which lens-crafter loads when proposing artifacts for an unfamiliar codebase — the "read this INSTEAD of exploring" instruction that the whole survey-as-anchor design rests on.'
	},
	{
		bundleSource: 'prompts', vaultHome: 'prompts', required: true,
		purpose: 'The house agent\'s prompt relics — the wording every house task sends. REQUIRED in the strongest sense: `HouseTask.prompt` names a relic and `instructionFor` THROWS on a missing one by ruling, with deliberately no inline fallback, so a vault without this directory does not degrade — it explodes on its first house task. Titling fires automatically on a session\'s first prompt, so the failure is immediate rather than eventual. Shipped as a directory: the set grows with the task registry, and a row per relic would drift out of step with it.'
	},
	{
		bundleSource: 'utilities/deployed', vaultHome: 'utilities/deployed', required: false,
		purpose: 'Bundled example utilities for the registered tool tier — a starting point, not a requirement.'
	},
	{
		bundleSource: 'root.html', vaultHome: 'root.html', required: true,
		purpose: 'THE ENTRY DOCUMENT — the first thing every session reads, and what the generated CLAUDE.md points at. Required in the strongest sense: `root-context.html` instructs the agent to open it three times over, so a vault without it hands every new user a broken first instruction. It was missing entirely until 2026-07-26. Shipped as a starting point and meant to be edited; `lens-index` splices its Lenses table.'
	},
	{
		bundleSource: 'root-context.html', vaultHome: 'root-context.html', required: true,
		purpose: 'The host-seed carrier — CLAUDE.md / AGENTS.md / GEMINI.md are generated from this.'
	},
	{
		bundleSource: 'kcd.css', vaultHome: 'kcd.css', required: true,
		purpose: 'The vault-wide stylesheet every governed document links.'
	},
	{
		bundleSource: 'kcd_framework.html', vaultHome: 'kcd_framework.html', required: false,
		purpose: 'The framework\'s own self-description — useful context, not load-bearing.'
	},

]

export class InstallManifest {

	/** The base lens's vault-relative home — THE one place the inheritance floor is named. Every reader
	 *  that has to tell the floor apart from an authored lens ( `Agent.domainLenses`, Starmind's
	 *  `Agents.withBase` / `_lensPathsOf`, `VaultUtilities.compile` ) resolves it through here. */
	static readonly BASE_LENS = `lenses/${ BASE_LENS_FILE }`

	/** Is this path the base lens — the auto-loaded floor rather than an authored domain lens? Matches on
	 *  the trailing SEGMENT, so it is true for a vault-relative path, an OS-absolute one, and either slash
	 *  flavour, and false for a same-suffixed name that merely ends in the same characters. Null / empty
	 *  ( an in-memory lens with no path ) is not the base lens. */
	static isBaseLens( path: string | null | undefined ): boolean {
		if( !path ) return false
		const segments = path.replace( /\\/g, '/' ).split( '/' )
		return segments[ segments.length - 1 ] === BASE_LENS_FILE
	}

	/** Every row, in table order. */
	static all(): readonly ManifestEntry[] {
		return MANIFEST
	}

	/**
	 * The row governing a vault-relative deployed path, or null when nothing in the manifest owns
	 * it. Longest matching `vaultHome` prefix wins, mirroring `VaultLayout.entryFor` — a specific row
	 * ( `references/kcd_sdk` ) can sit inside a directory this table does not otherwise cover.
	 */
	static entryFor( vaultRelPath: string ): ManifestEntry | null {
		const norm = vaultRelPath.replace( /\\/g, '/' )
		let best: ManifestEntry | null = null
		for( const entry of MANIFEST ) {
			if( norm !== entry.vaultHome && !norm.startsWith( entry.vaultHome + '/' ) ) continue
			if( best && best.vaultHome.length >= entry.vaultHome.length ) continue
			best = entry
		}
		return best
	}

}
