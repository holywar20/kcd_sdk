/**
 * Noise — the BUILD-ARTIFACT filter. It is not a security boundary, and the distance between this
 * file and `Blacklist` beside it is the point.
 *
 * `Blacklist` hides SECRETS. Its defaults cannot be switched off, every reader enforces it, and a
 * path it refuses is refused. This list hides things that are merely UNINTERESTING — a dependency
 * tree, a bundler's output, a lockfile — and any caller may ignore it outright. Blacklist's own
 * header asks for exactly this separation, in these words: noise "belongs to a separate, opt-in
 * flag, because mixing the two teaches people to trim this list." Folded together, the noise half
 * invites editing, and the person editing it eventually trims a secret out of the same array.
 *
 * ── IT PRUNES, IT DOES NOT FILTER, AND THAT IS THE WHOLE REASON IT EXISTS ──
 * Every walk in this SDK is capped. Applied to the RESULTS of one, a noise list buys nothing: the
 * cap trips deep inside the dependency tree and the walk returns before it ever reaches the source.
 * Measured on this project — 83,491 entries, of which 57,943 sit under `node_modules`, against a
 * GLOB_CAP of 1,000 — a content search of the project root finds its first thousand matches inside
 * the first `node_modules` it meets and reports no matches for strings that plainly exist. So a
 * skipped directory is never DESCENDED INTO, which is a different operation from dropping its
 * entries afterwards, and the only one that helps.
 *
 * ── WHAT EARNS A PLACE HERE ──
 * Only directories that are, by near-universal convention, MACHINE OUTPUT or vendored input — never
 * a place a person writes code. `bin/`, `obj/` and `env/` were considered and rejected on that test:
 * `bin/` holds hand-written CLI entry points in most Node projects, and `env` is too generic a word
 * to claim. A false positive here is invisible — the file simply cannot be found — so the bar is
 * "would anyone be surprised", not "is it usually generated".
 */

/** Directory NAMES never descended into. Matched whole and case-insensitively against a single path
 *  segment — not a glob, because a segment compare is what a walk can afford per dirent. */
export const NOISE_DIRS: readonly string[] = [
	// version control internals
	'.git', '.svn', '.hg',
	// dependency trees ( the one that actually matters — see the header )
	'node_modules', 'vendor', 'bower_components',
	// build output
	'dist', 'out', 'build', 'target',
	// framework + tooling caches
	'.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.gradle', '.terraform',
	// python environments and caches
	'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
	// coverage reports
	'coverage', '.nyc_output'
]

/** File-name SUFFIXES never opened. Suffix rather than glob for the same reason the directories are
 *  a name compare: this runs once per candidate file in a walk of tens of thousands.
 *
 *  `.lock` covers `yarn.lock`, `Cargo.lock`, `poetry.lock` and `composer.lock` in one entry; the two
 *  JSON/YAML lockfiles have to be named because their extensions are ones a person also writes. */
export const NOISE_FILES: readonly string[] = [
	// minified + bundled output — a single one of these matches nearly every query, which is what
	// makes them worse than useless in a result list ( this project vendors four, ~900 KB each )
	'.min.js', '.min.mjs', '.min.css', '.bundle.js', '.chunk.js',
	// source maps: machine-written, enormous, and a superset of text that is already searchable
	'.map',
	// lockfiles
	'.lock', 'package-lock.json', 'pnpm-lock.yaml'
]

export const Noise = {

	/** Should a walk refuse to descend into a directory of this NAME? Takes the bare segment, never a
	 *  full path — the caller has the dirent's name already and joining a path to re-split it would be
	 *  the expensive half of a check that runs per entry. */
	skipsDir( name: string ): boolean {
		const key = name.toLowerCase()
		return NOISE_DIRS.some( ( d ) => d === key )
	},

	/** Should a search refuse to OPEN a file of this name? Suffix match, case-insensitive. */
	skipsFile( name: string ): boolean {
		const key = name.toLowerCase()
		return NOISE_FILES.some( ( s ) => key.endsWith( s ) )
	}

}
