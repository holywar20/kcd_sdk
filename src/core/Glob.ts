/**
 * Glob — the shared glob matcher. ONE place that turns a `*` / `**` pattern into a regex test, so
 * every reader (Vault's vault-relative glob, SdkFileAccess's disk walk, and any future renderer
 * surface) matches identically instead of drifting. Pure: no fs, Node-free, lives in @kcd/core.
 *
 *   *  — within one path segment   (becomes [^/]*)
 *   ** — across segments           (becomes .*)
 *
 * Paths must be '/'-normalized and relative to the search base before matching.
 */
export class Glob {

	/** Does a '/'-normalized relative path match the glob pattern? Anchored, full-string match. */
	static matches( relativePath: string, pattern: string ): boolean {
		const regexStr = pattern
			.replace( /[.+^${}()|[\]\\]/g, '\\$&' )   // escape regex specials
			.replace( /\*\*/g, '\x01' )               // protect ** before replacing *
			.replace( /\*/g, '[^/]*' )                // * → within-segment wildcard
			.replace( /\x01/g, '.*' )                 // ** → cross-segment wildcard
		return new RegExp( `^${ regexStr }$` ).test( relativePath )
	}
}
