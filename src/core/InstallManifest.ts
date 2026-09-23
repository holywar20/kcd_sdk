/**
 * InstallManifest — what a fresh vault needs from the kit's bundled substrate, and where it lands.
 *
 * "Canonical is not deployed": the framework library's master copy lives in the substrate the host
 * app ships, never inside a project's own vault. A vault used to carry its own
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
	/** Path relative to the substrate root. */
	bundleSource: string
	/** Vault-relative target — below the docRoot. */
	vaultHome: string
	required: boolean
	purpose: string
}

const MANIFEST: readonly ManifestEntry[] = [

	{
		bundleSource: 'lenses/documentation', vaultHome: 'lenses/documentation', required: true,
		purpose: 'The authoring lens the Lens Crafter agent wears. REQUIRED, not a nicety: a new vault\'s entry document sends its first session to Lens Crafter before any lens is written, so a vault without it fails at the exact step where it starts producing value. Shipped as a directory so the lens keeps its `{name}/{name}.html` + `context/` anatomy.'
	},
	{
		bundleSource: 'lenses/house', vaultHome: 'lenses/house', required: true,
		purpose: 'The house lens — what the project\'s house agent is composed from. REQUIRED: every project is minted with a house agent wearing it, and Starmind\'s automatic work ( session titles, compaction ) runs on that agent, so a vault without it cannot host its own house agent. Pairs with `prompts`, which carries each task\'s wording; the lens carries the stance they all share. Shipped as a directory for the same anatomy reason as documentation.'
	},
	{
		bundleSource: 'habits', vaultHome: 'habits', required: true,
		purpose: 'Atomic behavior fragments the shipped agents carry.'
	},
	{
		bundleSource: 'analyzers/_analyzer_base.html', vaultHome: 'analyzers/_analyzer_base.html', required: true,
		purpose: 'The shared analyzer contract every read-anywhere, write-one-report SKILL extends.'
	},
	{
		bundleSource: 'generators', vaultHome: 'generators', required: true,
		purpose: 'The base generator contract plus the bundled manifest-driven write agents.'
	},
	{
		bundleSource: 'contracts', vaultHome: 'contracts', required: true,
		purpose: 'The invocable procedures the bundled lenses and generators are evaluated against.'
	},
	{
		bundleSource: 'references', vaultHome: 'references', required: true,
		purpose: 'Every reference the bundle carries, whatever category it sits in: the protocol and primitives the framework assumes a vault can link to ( `kcd_sdk` ), and the procedural references the bundled lenses and habits link into by path ( `how-to` ). ONE DIRECTORY ROW ON PURPOSE — a row per category meant a canonical reference filed under a new one silently failed to deploy, and the first sign of it was a shipped habit pointing at a link that did not exist in a fresh vault.'
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
		purpose: 'THE ENTRY DOCUMENT — the first thing every session reads, and what the generated CLAUDE.md points at. Required in the strongest sense: `root-context.html` instructs the agent to open it three times over, so a vault without it hands every new user a broken first instruction. It was missing entirely until 2026-07-26. Shipped as a starting point and meant to be edited.'
	},
	{
		bundleSource: 'agent-defaults.json', vaultHome: 'agent-defaults.json', required: true,
		purpose: 'The shipped agents — Basic, Lane and Lens Crafter — named in strings: their lenses, system prompt, habits and tools. The project\'s own copy, edited by a person; its agents follow it at the next load. Laid down here so the entry document\'s link to it resolves from the first open, before the agents are seeded.'
	},
	{
		bundleSource: 'root-context.html', vaultHome: 'root-context.html', required: true,
		purpose: 'The host-seed carrier — the root entry file ( CLAUDE.md ) is generated from this.'
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
