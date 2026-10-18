/**
 * FileTypes — the wire shapes for the filesystem read surface. Node-free core currency so every
 * reader speaks ONE shape across the bridge / MCP wire: the main file service, the renderer facade,
 * and the file MCP. Plain data — a listing is FileEntry[], a stat is FileStat, the nav anchors are
 * FileRoots.
 */

/** One directory child — what a browser row needs. `ext` is the lowercased extension without the dot
 *  (''+ for none); `path` is the full OS path (the id you navigate / read by). */
export type FileEntry = {
	name:  string
	path:  string
	isDir: boolean
	size:  number
	ext:   string
	mtime: number
}

/** One entry's metadata, when you stat a single path. */
export type FileStat = {
	isDir: boolean
	size:  number
	mtime: number
}

/** The browser's navigation anchors: the user's home dir and every existing drive root. */
export type FileRoots = {
	home:   string
	drives: string[]
}

/** One LINE from a content search — a match, or context around one. The path is absolute; the line is
 *  1-indexed. `context` is set only on a context line, so its absence reads as "this line matched". */
export type GrepRow = {
	path:     string
	line:     number
	text:     string
	/** True when this line is only NEIGHBOURING a match rather than carrying one. */
	context?: boolean
}

/** How many matching lines one file holds — the exact count, deliberately unaffected by `maxPerFile`.
 *  A display limit clipped here would answer "how widespread" with a number about the row budget. */
export type GrepCount = {
	path:    string
	matches: number
}

/** Why a FILE root was never opened. Each one is already known at the moment the scan gives up, and
 *  collapsing them into one sentence is what let a 2026-10-13 triage record "binary or oversized" as the
 *  cause of a plain-text 1.4 MB file it simply had no table entry for ( DEFECT-342 ). The fix a reader needs
 *  differs per cause — edit a table, raise a cap, widen a root — so the cause travels rather than the prose. */
export type GrepSkip = 'noise' | 'nontext' | 'protected' | 'empty' | 'oversized' | 'unreadable'

/** WHICH ceiling stopped a search, for the same reason `GrepSkip` exists: the remedy differs per cause and
 *  one word for all of them sends a caller at the wrong dial. `rows` is the budget across the whole walk —
 *  raising it is the fix. `file` is the per-file match ceiling, hit while the row budget still had room, so
 *  there is nothing left to narrow and `maxPerFile` is the only dial that moves it. `walk` is the directory
 *  entry ceiling: the tree is too large and the root is what wants narrowing. Null means nothing was cut. */
export type GrepCapped = 'rows' | 'file' | 'walk' | null

/** What a content search returns. `searched` counts files actually opened: nothing found across 0 files
 *  is meaningless. `capped` (more exist) and `cancelled` (stopped on request) both mark the list partial. */
export type GrepScan = {
	rows:      GrepRow[]
	searched:  number
	capped:    boolean
	/** WHICH ceiling fired, when one did — see `GrepCapped`. The row and walk caps outrank the per-file one
	 *  because they end the WALK, while a per-file clip leaves the search free to carry on into the next file:
	 *  told `file` when the budget is also gone, a caller raises `maxPerFile` and gets the same list back. */
	cappedBy:  GrepCapped
	cancelled: boolean
	/** One entry per opened file that held a match, in walk order. Always filled. */
	counts:    GrepCount[]
	/** Text files the walk reached, counted before `glob` runs. Tells an empty result from a root with
	 *  nothing searchable apart from one the pattern excluded; only the second is a pattern to fix. */
	candidates: number
	/** Of the files the glob rejected, how many it would have accepted matched against the bare filename.
	 *  Lets the refusal say `**\/App.vue`, not "widen your glob" — a root-only hit teaches the wrong rule. */
	nearMisses: number
	/** The root was a FILE — a legitimate one-file search. Without this, an empty result for a path that is
	 *  not a directory reads the same as a directory holding nothing searchable. */
	rootIsFile: boolean
	/** WHY that one file was never opened, when it was not. Set only on the `rootIsFile` path and only when
	 *  `searched` is 0 — on every other shape it is null, because a directory walk skips many files for many
	 *  reasons and one cause could not honestly stand for them. Null therefore means "no single file was
	 *  refused", never "refused for an unknown reason". */
	fileSkip: GrepSkip | null
}
