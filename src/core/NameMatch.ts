/**
 * NameMatch — the shared name-search matcher. Plain, case-insensitive substring matching (the same
 * default Everything/voidtools itself uses) — deliberately NOT a glob pattern (see Glob.ts, a
 * different concern: shape-matching, not free-text search) and no fuzzy scoring in v1. Pure,
 * Node-free, lives in @kcd/core so SdkFileAccess's search walk and any future renderer surface
 * match identically instead of drifting.
 */
export class NameMatch {

	/** Does `name` contain `query`, case-insensitively? A blank query matches nothing — the caller
	 *  guards against turning an empty search into "list every file on the machine". */
	static matches( name: string, query: string ): boolean {
		const q = query.trim()
		if( !q ) return false
		return name.toLowerCase().includes( q.toLowerCase() )
	}
}
