/**
 * Noise — the BUILD-ARTIFACT filter. Not a security boundary: secrets belong in `Blacklist`, and folding the two
 * together teaches people to trim a secret out of this array. It PRUNES rather than filters: every walk is capped,
 * so a skipped directory must never be descended into — in practice the cap trips inside `node_modules`. Only
 * near-universal machine output or vendored input belongs here, never a place a person writes code; a false
 * positive is invisible, so the bar is "would anyone be surprised", not "is it usually generated".
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

	/** Should a walk refuse to descend into a directory of this NAME? Takes the bare segment, never a full path —
	 *  re-splitting a joined path per dirent would be the expensive half of a check that runs per entry. */
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
