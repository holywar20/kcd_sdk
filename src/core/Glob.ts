/**
 * Glob — the shared glob matcher. ONE place that turns a `*` / `**` pattern into a regex test, so
 * every reader (Vault's vault-relative glob, SdkFileAccess's disk walk, and any future renderer
 * surface) matches identically instead of drifting. Pure: no fs, Node-free, lives in @kcd/core.
 *
 *   `*`     — within one path segment          (becomes `[^\/]*`)
 *   `**`    — across segments                  (becomes `.*`)
 *   `**\/`  — across ZERO OR MORE segments      (becomes `(?:.*\/)?`)
 *
 * Paths must be '/'-normalized and relative to the search base before matching.
 *
 * ── WHY `**\/` IS ITS OWN CASE ────────────────────────────────────────────────────────────────
 *
 * It was not, until 2026-08-25, and the omission silently under-reported files for as long as this
 * matcher has existed. `**` alone became `.*`, so `**\/*.ts` compiled to `.*\/[^\/]*\.ts` — a pattern
 * REQUIRING a literal slash in the path, and therefore incapable of matching a file sitting directly
 * in the search root. Measured live against a directory holding 7 `.ts` files and no subdirectories:
 * `*` returned 7, `*.ts` returned 7, and `**\/*` returned 0.
 *
 * THE FAILURE MODE IS THE DANGEROUS ONE: it never errored. It returned a SHORTER list and called it
 * complete, on the one pattern form the file tools' own documentation offers as its example. A caller
 * asking for every `.ts` file under a root got every one except the ones at the top — and nothing
 * about the answer said so.
 *
 * Zero-or-more is what this form means in every glob dialect worth matching ( shell, gitignore,
 * minimatch ), so this is a correction toward the standard rather than a local convention. It can
 * only ever match MORE than before, which is also why it is safe for `Blacklist`: a deny pattern
 * that starts excluding root-level files was always meant to.
 */
export class Glob {

	/** Does a '/'-normalized relative path match the glob pattern? Anchored, full-string match. */
	static matches( relativePath: string, pattern: string ): boolean {
		const regexStr = pattern
			.replace( /[.+^${}()|[\]\\]/g, '\\$&' )   // escape regex specials
			// ORDER IS LOAD-BEARING: `**/` must be claimed before the bare `**` below, or the slash is left
			// behind as a mandatory separator and the zero-directory case is lost again.
			.replace( /\*\*\//g, '\x02' )             // protect **/ — the ZERO-or-more-directories form
			.replace( /\*\*/g, '\x01' )               // protect ** before replacing *
			.replace( /\*/g, '[^/]*' )                // * → within-segment wildcard
			.replace( /\x01/g, '.*' )                 // ** → cross-segment wildcard
			.replace( /\x02/g, '(?:.*/)?' )           // **/ → any number of directories, INCLUDING none
		return new RegExp( `^${ regexStr }$` ).test( relativePath )
	}
}
