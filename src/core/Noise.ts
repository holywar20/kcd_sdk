/**
 * Noise — the BUILD-ARTIFACT filter. Not a security boundary: secrets belong in `Blacklist`, and folding the two
 * together teaches people to trim a secret out of this array. It PRUNES rather than filters: every walk is capped,
 * so a skipped directory must never be descended into — in practice the cap trips inside `node_modules`. Only
 * near-universal machine output or vendored input belongs here, never a place a person writes code; a false
 * positive is invisible, so the bar is "would anyone be surprised", not "is it usually generated".
 *
 * TWO LISTS, BECAUSE FOUR OF THESE NAMES ARE AMBIGUOUS ( DEFECT-2893, BUG-229, BUG-231 ). `build`, `out`, `dist`
 * and `target` name machine output at a project root and name hand-written source anywhere else: this repository's
 * own `starmind/scripts/build` is the entire build pipeline, tracked, and it was pruned from every recursive walk —
 * so `grep` rooted at `scripts` answered "No match ... in 41 file( s )" for a string that is in it, and `glob`
 * listed the directory and none of its fifteen children. A false absence that reads as a clean search is the worst
 * answer this module can produce, and it was being produced by the very names its own header says do not meet the
 * bar. So those four are now pruned only where they sit BESIDE A PROJECT MANIFEST, which is where a toolchain
 * actually writes its output; everything else on the list is unambiguous machine naming and is pruned on sight.
 *
 * THE HEURISTIC IS STILL A HEURISTIC, and the second half of that repair is what makes it safe: both walks now
 * return every directory they pruned and both tools name them, so a wrong prune is visible to the caller instead
 * of reading as absence. `starmind/build` — icons and an installer script, tracked — is the known false positive
 * here, and it is reported by name rather than silently dropped.
 */

/** Directory NAMES never descended into, whatever they sit beside. Matched whole and case-insensitively against a
 *  single path segment — not a glob, because a segment compare is what a walk can afford per dirent. */
export const NOISE_DIRS: readonly string[] = [
	// version control internals
	'.git', '.svn', '.hg',
	// dependency trees ( the one that actually matters — see the header )
	'node_modules', 'bower_components',
	// framework + tooling caches
	'.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.gradle', '.terraform',
	// python environments and caches
	'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
	// coverage reports
	'coverage', '.nyc_output'
]

/** Directory names that mean machine OUTPUT beside a project manifest and mean SOURCE anywhere else — see the
 *  header. Pruned only when `skipsDir` is given the sibling names and one of them is a manifest. `vendor` is here
 *  rather than above for the same reason: it is a Go / PHP dependency tree at a module root and an ordinary folder
 *  name everywhere else. */
export const OUTPUT_DIRS: readonly string[] = [
	'dist', 'out', 'build', 'target', 'vendor'
]

/** Files whose presence marks a directory as a project root, so a `build` or `out` beside one is that project's
 *  output. Matched whole and case-insensitively against the candidate's SIBLINGS, which a walk already holds —
 *  there is no extra stat and no extra readdir anywhere in this check. */
export const PROJECT_MANIFESTS: readonly string[] = [
	'package.json', 'deno.json', 'deno.jsonc',
	'cargo.toml', 'go.mod', 'composer.json',
	'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt',
	'pyproject.toml', 'setup.py', 'gemfile',
	'cmakelists.txt', 'makefile'
]

/** File-name SUFFIXES never opened. Suffix, not glob: this runs once per candidate in a walk of tens of thousands.
 *  `.lock` covers most lockfiles; the two JSON/YAML ones are named, since their extensions are ones a person writes. */
export const NOISE_FILES: readonly string[] = [
	// minified + bundled output — a single one of these matches nearly every query, which is what
	// makes them worse than useless in a result list
	'.min.js', '.min.mjs', '.min.css', '.bundle.js', '.chunk.js',
	// source maps: machine-written, enormous, and a superset of text that is already searchable
	'.map',
	// lockfiles
	'.lock', 'package-lock.json', 'pnpm-lock.yaml'
]

export const Noise = {

	/**
	 * Should a walk refuse to descend into a directory of this NAME? Takes the bare segment, never a full path —
	 * re-splitting a joined path per dirent would be the expensive half of a check that runs per entry.
	 *
	 * `siblings` is the name list of the directory the candidate sits IN, which every walk already has in hand from
	 * its own readdir. It decides the ambiguous `OUTPUT_DIRS` group and nothing else. OMITTING IT FAILS OPEN — an
	 * `out` whose context is unknown is WALKED rather than pruned, because the cost of the two errors is not
	 * symmetric: a redundant walk is slow and visible, a wrong prune is a false absence that reads as a complete
	 * search, which is the whole of DEFECT-2893.
	 */
	skipsDir( name: string, siblings?: readonly string[] ): boolean {
		const key = name.toLowerCase()
		if( NOISE_DIRS.some( ( d ) => d === key ) ) return true
		if( !OUTPUT_DIRS.some( ( d ) => d === key ) ) return false
		return siblings ? Noise.isProjectRoot( siblings ) : false
	},

	/** Does this directory's own name list mark it a project root? Separated so a caller can ask the question
	 *  directly, and so the manifest list has exactly one reader. */
	isProjectRoot( names: readonly string[] ): boolean {
		for( const n of names ) {
			const key = n.toLowerCase()
			if( PROJECT_MANIFESTS.includes( key ) ) return true
			// The one wildcard worth carrying: a Visual Studio solution names the project root and its stem is
			// never predictable. Kept as an endsWith rather than a glob, like NOISE_FILES.
			if( key.endsWith( '.sln' ) ) return true
		}
		return false
	},

	/** Should a search refuse to OPEN a file of this name? Suffix match, case-insensitive. */
	skipsFile( name: string ): boolean {
		const key = name.toLowerCase()
		return NOISE_FILES.some( ( s ) => key.endsWith( s ) )
	}

}
