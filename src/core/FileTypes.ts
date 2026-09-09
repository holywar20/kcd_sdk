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

/** One matching LINE from a content search. The path is absolute because that is what a caller acts on
 *  next — a relative one would have to be rejoined against a root the caller then has to remember. The
 *  line is 1-indexed, to match every editor and every `path:line` convention that reads it. */
export type GrepRow = {
	path: string
	line: number
	text: string
}

/** What a content search returns.
 *
 *  `searched` is the count of files actually OPENED, and it is what makes an empty result interpretable:
 *  nothing found across 4,000 files is a real answer, nothing found across 0 means the walk never
 *  reached any source and the answer is meaningless.
 *
 *  `capped` and `cancelled` are carried separately because they mean different things to a person. Capped
 *  is "there are more of these"; cancelled is "I stopped because you asked". Both make the list partial,
 *  and a surface that showed neither would be claiming completeness it does not have. */
export type GrepScan = {
	rows:      GrepRow[]
	searched:  number
	capped:    boolean
	cancelled: boolean
}
