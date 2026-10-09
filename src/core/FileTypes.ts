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

/** What a content search returns. `searched` counts files actually opened: nothing found across 0 files
 *  is meaningless. `capped` (more exist) and `cancelled` (stopped on request) both mark the list partial. */
export type GrepScan = {
	rows:      GrepRow[]
	searched:  number
	capped:    boolean
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
}
