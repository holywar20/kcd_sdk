/**
 * Glob — the shared `*` / `**` / `**\/` matcher, so every reader (vault, disk walk, renderer) matches identically.
 * Paths must be '/'-normalized and relative to the search base. Pure, Node-free.
 *
 * `**\/` means ZERO OR MORE segments, so `**\/*.ts` matches a root-level file. It once compiled to `.*\/`, which
 * silently dropped root-level files while the list still called itself complete. Zero-or-more is the standard in
 * shell, gitignore and minimatch. It only ever matches more, so Blacklist deny patterns stay safe.
 */
export class Glob {

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
