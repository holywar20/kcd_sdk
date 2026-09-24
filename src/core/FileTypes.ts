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
	/** Text files the walk REACHED — the denominator `searched` is a fraction of, counted before the
	 *  `glob` filter runs. It exists to tell two empty results apart that look identical to a caller:
	 *  a root holding nothing searchable, and a root full of files that the pattern excluded. Only the
	 *  second is a pattern the caller should go and fix. */
	candidates: number
	/** Of the files the glob rejected, how many it would have ACCEPTED had it been matched against the
	 *  bare filename instead of the path.
	 *
	 *  This is the one wrong mental model this grammar invites, and it invites it by rewarding it: a
	 *  pattern like `App.vue` works when the file sits at the search root, so a caller who tries it and
	 *  succeeds learns "globs match filenames" — and is then baffled when the same form finds nothing a
	 *  directory down. A hit that teaches the wrong rule is worse than a miss, and this number is what
	 *  lets the refusal say `**\/App.vue` instead of "widen your glob". */
	nearMisses: number
	/** The root was a FILE, not a directory — a legitimate search of exactly one file.
	 *
	 *  Carried because it is the only thing that tells an empty result from a misaimed one: every other
	 *  number here reads identically for "a directory holding nothing searchable" and "a path that is
	 *  not a directory at all", and the second used to be reported as the first. A caller that says
	 *  "nothing under this root" about a single .png has told the user to go and check a path that was
	 *  perfectly correct. */
	rootIsFile: boolean
}
