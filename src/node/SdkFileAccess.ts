import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, cpSync, rmSync, realpathSync, lstatSync, readlinkSync } from 'fs'
import { join, extname, relative, resolve, sep, dirname, basename } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TextTypes } from '../core/TextTypes'
import { Glob } from '../core/Glob'
import { NameMatch } from '../core/NameMatch'
import { Noise } from '../core/Noise'
import { Blacklist } from '../core/Blacklist'
import { EsCsv } from '../core/EsCsv'
import type { FileEntry, FileStat, FileRoots, GlobScan, GlobCapped, GrepRow, GrepCount, GrepScan, GrepSkip, GrepCapped } from '../core/FileTypes'
import { higherLevel, operationsFor, verbFor, type AccessEntry } from '../core/AccessPolicy'
import { accessRank, type AccessLevel } from '../session/InjectedItem'
import type { GrantRef } from '../session/InjectedItem'

/** What a path resolves to, and what supplied it. `via` names the floor or the lifting grant, so both outcomes stay auditable. */
export interface AccessVerdict {
	level: AccessLevel
	via:   'config' | GrantRef | null
	/** Depth the GRANTS alone give this path. Not `via`: a door keying on the gesture must not depend on whether configuration
	 *  already covered the path, or one gesture would pass outside the project and fail inside it. */
	granted: AccessLevel
}

const _execFile = promisify( execFile )

// Caps guard the wire and the heap, identically for every reader. A walk that trips a cap halts with what it has
// and pings onWarn rather than running on.
export const LIST_CAP       = 1000
export const READ_CAP_BYTES = 1_048_576   // 1 MiB
export const GLOB_CAP       = 1000
export const GLOB_WALK_CAP  = 50_000

// search() walks a whole drive, so these caps sit far above glob's. The Cancel token is the primary stop;
// SEARCH_YIELD_EVERY keeps the walk yielding, or a cancel could never land and the main process would freeze.
export const SEARCH_MATCH_CAP   = 2000
export const SEARCH_WALK_CAP    = 2_000_000
export const SEARCH_YIELD_EVERY = 500

// Ceiling on the es.exe fast path. A hang falls through to the walk rather than blocking the caller.
export const SEARCH_ES_TIMEOUT_MS = 5000

// GREP_READ_BYTES skips logs, traces and bundles; hand-written source is never this large.
// GREP_YIELD_BUDGET is weighted work, not an entry count: an unweighted walk blocks for seconds once it opens files.
export const GREP_ROW_CAP       = 500       // matching lines, total
export const GREP_CONTEXT_CAP   = 10        // lines of context either side of a match, at most
export const GREP_FILE_CAP      = 20        // matching lines from any ONE file
export const GREP_LINE_CHARS    = 400       // a reported line is truncated past this
export const GREP_READ_BYTES    = 262_144   // 256 KiB
export const GREP_WALK_CAP      = 200_000
export const GREP_YIELD_BUDGET  = 200
export const GREP_READ_COST     = 10

/**
 * How long a content walk may run before it stops and SAYS it stopped ( DEFECT-2904 ).
 *
 * The one ceiling this walk never had. Every other cap above bounds a payload — rows, bytes, entries — and a walk
 * can run long without approaching any of them, so the only thing that ended a slow one was a wall outside the
 * walk: the calling keystone's routed budget, or the transport's own idle timeout. Both KILL the call, so the
 * caller got an abort with no output, which is precisely the shape every other ceiling here exists to avoid.
 *
 * TWENTY SECONDS, AND THE NUMBER IS CHOSEN AGAINST THE WALLS ABOVE IT rather than from how long a search feels
 * acceptable. The reported abort was a 30-second keystone budget racing a 30-second transport timeout — two walls
 * of the SAME length, so which one fired was a coin toss and neither could produce output. This sits below both
 * with room to spare, so the walk's own stop is reached FIRST and the answer comes back partial and labelled.
 * Raising it past a caller's wall puts the coin toss back.
 */
export const GREP_DEADLINE_MS = 20_000

/** How many pruned directories a walk NAMES before it stops listing them ( DEFECT-2893 ). A monorepo walk prunes a
 *  `node_modules` per package, and a hundred names in a tool reply is the kind of noise that gets the whole
 *  disclosure skipped. `prunedTotal` carries the real figure, so the reply can say what it is not naming. */
export const PRUNE_REPORT_CAP = 25

/** Hops `real` follows before it calls a link chain a loop; the OS's own limit is of this order. */
const LINK_HOPS = 40
/** Where a path that cannot be resolved lands — a spelling no root can contain, so it is refused. */
const UNREACHABLE = '\0unreachable'

/** How to walk for a pattern. `glob` imposes no authorization of its own — the caller admits the root before
 *  calling and filters protected matches out of the result, which is why there is no `deny` here: unlike the
 *  grep walk, this one opens nothing, so a protected path is dropped by the caller rather than never entered. */
export type GlobScanOptions = {
	/** Skip build output, dependency trees and generated files ( see `Noise` ). Default TRUE, as on the grep walk and
	 *  for the reason `Noise`'s own header gives: every walk is capped, and an unpruned walk of a project tree spends
	 *  its cap inside `node_modules` and reports nothing for a file that is there ( DEFECT-046 ). A pattern that names
	 *  a pruned directory outright is honoured regardless, so this cannot hide a path somebody explicitly asked for.
	 *
	 *  RULED BY BRYAN, 2026-10-22, on DEFECT-046: pruning stays. That also SETTLES the glob/grep disagreement BUG-138's
	 *  notes recorded as open — in grep's favour — so a reader who goes looking for that asymmetry will not find it. */
	skipNoise?: boolean
	/** Directory entries to visit before the walk gives up. Default GLOB_WALK_CAP. Lower it for a cheap bounded probe —
	 *  the result says `cappedBy: 'walk'` either way, so a caller can always tell a finished walk from a stopped one. */
	walkCap?:   number
}

/** How to search file contents. `grepText` imposes no authorization of its own: the caller admits the root
 *  before calling and passes its own `deny` patterns down. */
export type GrepScanOptions = {
	caseInsensitive?: boolean
	/** Match only where the query is bounded by non-word characters. */
	wholeWord?:       boolean
	/** The caller's deny-list ( see `Blacklist` ) — subtree semantics, applied to directories BEFORE
	 *  they are descended into and to files before they are opened. */
	deny?:            readonly string[]
	/** Skip build output, dependency trees and generated files (see `Noise`). Default TRUE: without it the search returns the wrong answer. */
	skipNoise?:       boolean
	/** Only open files whose path, relative to the root, matches this glob. Narrows which files open, never which
	 *  directories are walked: the directory holding a match is unknown until the walk reaches it. Ignored when the root is a file. */
	glob?:            string
	/** How long the walk may run before it stops and reports `cappedBy: 'time'`. Default GREP_DEADLINE_MS; `0`
	 *  turns the clock off, which only a caller with a wall of its own should do. A deadline is read at the
	 *  points the walk already pauses at — see `grepText` — so the overshoot is one file read, not unbounded. */
	deadlineMs?:      number
	/** Largest file to open, in bytes. Default GREP_READ_BYTES. */
	maxBytes?:        number
	/** Matching lines to collect before the walk stops. Default GREP_ROW_CAP. */
	maxRows?:         number
	/** Matching lines from any ONE file, so a generated file cannot eat the row budget. Not a summary: a surface where a
	 *  person navigates should set it well above the agent default, or a file's hits are silently cut short. */
	maxPerFile?:      number
	/** Lines of context before each match, clamped to GREP_CONTEXT_CAP. Context lines are spent out of `maxRows`. */
	before?:          number
	/** Lines of context to report AFTER each matching line. Clamped to GREP_CONTEXT_CAP. */
	after?:           number
	/** `rows` returns matching lines and context, `count` per-file totals, `files` stops each file at its first hit.
	 *  maxRows counts whatever the mode returns, so every mode still stops and says so. */
	mode?:            GrepMode
}

/** See `GrepScanOptions.mode`. */
export type GrepMode = 'rows' | 'count' | 'files'

/** Cooperative-cancel handle for search() and grepText(): the caller flips `cancelled`, and the walk sees it at its next yield.
 *  Plain data, not an AbortController, because it has to cross the IPC pull lane. */
export type SearchToken = { cancelled: boolean }

/** Yields one event-loop tick. setImmediate, not a microtask, so pending IPC and UI work actually gets a turn. */
function _tick(): Promise<void> {
	return new Promise( ( resolve ) => setImmediate( resolve ) )
}

/** Does one line carry the needle? Under wholeWord it scans past a hit bounded on one side only, so it is a loop, not a test.
 *  `needle` arrives already folded when `fold` is set. */
function _lineHas( line: string, needle: string, fold: boolean, wholeWord: boolean ): boolean {
	const hay = fold ? line.toLowerCase() : line
	if( !wholeWord ) return hay.includes( needle )

	const word = /\w/
	for( let at = hay.indexOf( needle ); at !== -1; at = hay.indexOf( needle, at + 1 ) ) {
		const before = at === 0 ? '' : hay[ at - 1 ] ?? ''
		const after  = hay[ at + needle.length ] ?? ''
		if( !word.test( before ) && !word.test( after ) ) return true
	}
	return false
}

/** A degrade observer, INJECTED by the consumer. The core must never import a host logger: the file MCP runs as a
 *  separate process with no MainBus, and the renderer cannot import the node layer. */
export type FileWarn = ( event: string, detail: Record<string, unknown> ) => void

/**
 * SdkFileAccess — the shared filesystem read core. Framework-free, and every op degrades rather than throws: a denied,
 * missing, oversized or binary read folds to `[]` / `null` and pings `onWarn`. The caps and the TextTypes gate live here
 * so every reader enforces the same limits.
 *
 * This class imposes NO path jail. `jail()` is a pure primitive the caller applies; authorization is the caller's layer.
 */
export class SdkFileAccess {

	constructor(
		private readonly onWarn?: FileWarn,
		/** Path to a vendored `es.exe` for search()'s fast path, resolved by each consumer. Omitted or null, search() always walks:
		 *  the fast path is never a hard dependency. */
		private readonly esBin?: string | null
	) {}

	/** The browser's navigation anchors: the user's home dir + every existing drive root. */
	roots(): FileRoots {
		return { home: homedir(), drives: this._drives() }
	}

	/** One directory's children, dirs first, capped at LIST_CAP. The cap applies BEFORE statting, so a 50k folder costs
	 *  50k dirents rather than 50k stats. A missing or denied dir folds to []. */
	list( path: string ): FileEntry[] {
		let dirents: { name: string; isDir: boolean }[]
		try {
			dirents = readdirSync( path, { withFileTypes: true } ).map( ( d ) => ( { name: d.name, isDir: d.isDirectory() } ) )
		} catch( err ) {
			this._warn( 'list_failed', { path, message: this._msg( err ) } )
			return []
		}

		dirents.sort( ( a, b ) => a.isDir !== b.isDir ? ( a.isDir ? -1 : 1 ) : a.name.localeCompare( b.name ) )
		if( dirents.length > LIST_CAP ) {
			this._warn( 'list_truncated', { path, total: dirents.length, cap: LIST_CAP } )
		}

		const out: FileEntry[] = []
		for( const d of dirents.slice( 0, LIST_CAP ) ) {
			const entry = this._entry( path, d.name, d.isDir )
			if( entry ) out.push( entry )
		}
		return out
	}

	/** One entry's metadata, or null when it can't be stat'd. */
	stat( path: string ): FileStat | null {
		try {
			const s = statSync( path )
			return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }
		} catch( err ) {
			this._warn( 'stat_failed', { path, message: this._msg( err ) } )
			return null
		}
	}

	/** A text file's contents, or null. Gated three ways: a TextTypes extension (a whitelist, never a guess from bytes), a size
	 *  under READ_CAP_BYTES, and a successful read. A binary, oversized or unreadable file warns and returns null. */
	read( path: string ): string | null {
		if( !TextTypes.isText( path ) ) {
			this._warn( 'read_skipped_nontext', { path } )
			return null
		}
		try {
			const s = statSync( path )
			if( s.size > READ_CAP_BYTES ) {
				this._warn( 'read_too_large', { path, size: s.size, cap: READ_CAP_BYTES } )
				return null
			}
			return readFileSync( path, 'utf-8' )
		} catch( err ) {
			this._warn( 'read_failed', { path, message: this._msg( err ) } )
			return null
		}
	}

	/**
	 * Entries under `root` matching a glob, via the shared Glob matcher so results agree with Vault's. Bounded by GLOB_CAP
	 * matches and GLOB_WALK_CAP visited entries, and WHICH of the two fired travels in the result — see `GlobCapped`.
	 *
	 * IT REPORTS THE WALK CAP RATHER THAN LETTING THE CALLER INFER IT ( DEFECT-046 ). This returned a bare array, so the one
	 * caller computed its disclosure from the match count: a walk that spent all 50,000 visits and matched NOTHING came back
	 * empty and claimed completeness, and `sm_file__glob` printed a flat "No match" for a file that was on disk. An empty
	 * answer is the case where the false conclusion is total rather than partial, so it is the case that most needs the fact.
	 *
	 * NOISE DIRECTORIES ARE PRUNED, as `grepText` already prunes them and for the identical reason its own header gives: an
	 * unpruned walk of a project tree spends its cap inside `node_modules` and reports nothing for a file that is there. That
	 * was this defect's actual cause — `**\/Glob.ts` at the repository root found nothing while the same pattern one level
	 * down found it instantly. Pruning is what makes the cap reachable only by trees that are genuinely too large, rather
	 * than by every project with dependencies installed. `skipNoise: false` turns it off for a caller that means to look
	 * inside build output ( ruled by Bryan 2026-10-22 — the pruning stays, and the glob/grep asymmetry BUG-138's notes
	 * recorded as an open question is settled in grep's favour ), and a pattern naming a noise directory outright is
	 * honoured rather than pruned ( below ), so
	 * `**\/node_modules\/exa*\/**` still works and this cannot become a new way to hide a file from an agent.
	 */
	glob( root: string, pattern: string, opts: GlobScanOptions = {} ): GlobScan {
		const out:   FileEntry[] = []
		const stack: string[]    = [ root ]
		let   visited            = 0

		// WHAT THE WALK DID NOT LOOK AT ( DEFECT-2893 ). A prune used to be silent, which made an answer over a
		// partly-walked tree indistinguishable from one over the whole of it — the exact shape of "no match in 41
		// file( s )" for a string sitting in a pruned `scripts/build`. Recorded here and reported by the caller.
		const pruned: string[] = []
		let   prunedTotal      = 0

		// Taken from the options with the constant as the floor, the same shape `grepText` already uses for every
		// one of its ceilings. A caller wanting a cheap bounded probe sets it low; nothing else passes it.
		const walkCap = opts.walkCap ?? GLOB_WALK_CAP

		// A pattern that NAMES a pruned directory means it: pruning it would answer an explicit request with
		// silence, which is the same false absence this repair exists to remove. Read off the pattern text only,
		// never the disk, so it discloses nothing.
		const noise  = opts.skipNoise !== false
		const asked  = ( name: string ): boolean => pattern.includes( name )

		const done = ( cappedBy: GlobCapped ): GlobScan =>
			( { entries: out, visited, capped: cappedBy !== null, cappedBy, pruned, prunedTotal } )

		while( stack.length > 0 ) {
			const dir = stack.pop() as string

			let dirents: { name: string; isDir: boolean }[]
			try {
				dirents = readdirSync( dir, { withFileTypes: true } ).map( ( d ) => ( { name: d.name, isDir: d.isDirectory() } ) )
			} catch( err ) {
				this._warn( 'glob_walk_failed', { dir, message: this._msg( err ) } )
				continue
			}

			// Taken once per directory, not once per entry: this is the sibling list `Noise.skipsDir` needs to tell a
			// toolchain's `out` from a source directory of the same name, and the readdir above already paid for it.
			const siblings = dirents.map( ( d ) => d.name )

			for( const d of dirents ) {
				visited += 1
				if( visited > walkCap ) {
					this._warn( 'glob_walk_capped', { root, pattern, cap: walkCap } )
					return done( 'walk' )
				}

				const full = join( dir, d.name )
				const rel  = relative( root, full ).split( sep ).join( '/' )

				if( Glob.matches( rel, pattern ) ) {
					const entry = this._entry( dir, d.name, d.isDir )
					if( entry ) {
						out.push( entry )
					}
					if( out.length >= GLOB_CAP ) {
						this._warn( 'glob_truncated', { root, pattern, cap: GLOB_CAP } )
						return done( 'matches' )
					}
				}

				if( d.isDir ) {
					// Pruned, not filtered: the subtree is never entered. Same order and same reasoning as the grep walk.
					if( noise && Noise.skipsDir( d.name, siblings ) && !asked( d.name ) ) {
						prunedTotal += 1
						if( pruned.length < PRUNE_REPORT_CAP ) pruned.push( rel )
						continue
					}
					stack.push( full )
				}
			}
		}

		return done( null )
	}

	/** Entries whose NAME contains `query` (case-insensitive, via NameMatch). `roots` is one folder, or [] for the whole computer.
	 *  A blank query returns [] and never lists the machine. Tries the Everything fast path first; any failure — AND an empty
	 *  answer, which from an index is not evidence of absence — falls through to the walk, which yields the event loop so a
	 *  cancel can land. */
	async search( roots: string[], query: string, token: SearchToken = { cancelled: false } ): Promise<FileEntry[]> {
		const q = query.trim()
		if( !q || token.cancelled ) return []

		if( this.esBin ) {
			const fast = await this._esSearch( roots, q )
			if( fast !== null ) return fast
		}

		const out:   FileEntry[] = []
		const stack: string[]    = roots.length > 0 ? [ ...roots ] : this._drives()
		let   visited            = 0

		while( stack.length > 0 ) {
			const dir = stack.pop() as string

			let dirents: { name: string; isDir: boolean }[]
			try {
				dirents = readdirSync( dir, { withFileTypes: true } ).map( ( d ) => ( { name: d.name, isDir: d.isDirectory() } ) )
			} catch( err ) {
				this._warn( 'search_walk_failed', { dir, message: this._msg( err ) } )
				continue
			}

			for( const d of dirents ) {
				visited += 1
				if( visited > SEARCH_WALK_CAP ) {
					this._warn( 'search_walk_capped', { query, cap: SEARCH_WALK_CAP } )
					return out
				}

				if( NameMatch.matches( d.name, q ) ) {
					const entry = this._entry( dir, d.name, d.isDir )
					if( entry ) out.push( entry )
					if( out.length >= SEARCH_MATCH_CAP ) {
						this._warn( 'search_truncated', { query, cap: SEARCH_MATCH_CAP } )
						return out
					}
				}

				if( d.isDir ) stack.push( join( dir, d.name ) )

				if( visited % SEARCH_YIELD_EVERY === 0 ) {
					await _tick()
					if( token.cancelled ) {
						this._warn( 'search_cancelled', { query, matched: out.length, visited } )
						return out
					}
				}
			}
		}

		return out
	}

	/**
	 * Literal content search under one root: walk, open, match, report matching lines with their context. A file root is searched
	 * directly. Noise directories are PRUNED, not filtered: an unpruned walk of a project spends its cap inside node_modules and
	 * reports "no matches" for a string that is there. The walk yields to the event loop, so a cancelled token stops it.
	 *
	 * AND IT HAS A CLOCK ( DEFECT-2904 ). Every other ceiling here bounds a payload, so a walk could run long without
	 * approaching any of them and the only thing that ended it was a wall OUTSIDE the walk — a caller's routed budget, or a
	 * transport timeout. Both kill the call, so the answer was an abort with no output rather than the partial, self-naming
	 * list every other cap produces. `deadlineMs` is read at the three points this walk already pauses at, and trips
	 * `cappedBy: 'time'`.
	 */
	async grepText( root: string, query: string, opts: GrepScanOptions = {}, token: SearchToken = { cancelled: false } ): Promise<GrepScan> {
		const rows:   GrepRow[]   = []
		const counts: GrepCount[] = []
		if( !query || token.cancelled ) return { rows, searched: 0, capped: false, cappedBy: null, cancelled: token.cancelled, counts, candidates: 0, nearMisses: 0, rootIsFile: false, fileSkip: null, pruned: [], prunedTotal: 0 }

		const fold     = opts.caseInsensitive === true
		const needle   = fold ? query.toLowerCase() : query
		const deny     = opts.deny ?? []
		const noise    = opts.skipNoise !== false
		const filter   = opts.glob ?? ''
		const maxBytes = opts.maxBytes ?? GREP_READ_BYTES
		const maxRows  = opts.maxRows  ?? GREP_ROW_CAP
		const maxFile  = opts.maxPerFile ?? GREP_FILE_CAP
		const mode     = opts.mode ?? 'rows'
		// Clamped rather than refused: honouring the ceiling answers the question the caller meant.
		const before   = Math.min( Math.max( Math.trunc( opts.before ?? 0 ), 0 ), GREP_CONTEXT_CAP )
		const after    = Math.min( Math.max( Math.trunc( opts.after  ?? 0 ), 0 ), GREP_CONTEXT_CAP )

		/** Budget spent? The unit is the mode's own, lines or files: a cap counting a payload the mode never returns never fires. */
		const spent = (): boolean => ( mode === 'rows' ? rows.length : counts.length ) >= maxRows

		const stack: string[] = [ root ]
		let   visited    = 0
		let   searched   = 0
		let   capped     = false
		// WHICH ceiling fired, not just that one did: `maxRows` cannot relieve a per-file clip and `maxPerFile`
		// cannot relieve a spent row budget, so a caller told only "capped" has an even chance of reaching for
		// a dial that changes nothing ( DEFECT-611 ). The row and walk caps WIN over the per-file one when both
		// fire, because they ended the walk: raising `maxPerFile` against a spent budget returns the same list.
		let   cappedBy: GrepCapped = null
		const _capAt = ( by: Exclude<GrepCapped, null> ): void => {
			capped = true
			if( cappedBy === null || by !== 'file' ) cappedBy = by
		}
		// Counted at the glob filter, the only place that can tell 'nothing here' from 'nothing your pattern kept'.
		let   candidates = 0
		let   nearMisses = 0

		// Weighted yield budget: a file open costs GREP_READ_COST against a directory entry's 1, or the walk blocks once reads begin.
		let budget = 0

		// THE WALK'S OWN CLOCK ( DEFECT-2904 ). Read at the points below where the walk already pauses — once per
		// directory popped, after each file scanned, and at each yield — rather than per directory ENTRY. Those are
		// the three places the expensive units end, so the overshoot past the deadline is one file read or one
		// directory's dirents, and a 200,000-entry walk does not pay for a clock read per entry to get it.
		//
		// `0` turns it off, which is the one thing a caller with a wall of its own might want. It is not the default:
		// a walk with no clock is what produced an abort with no output, and absence of failure lines from a call
		// that was killed looks exactly like a clean search.
		const deadline = ( opts.deadlineMs ?? GREP_DEADLINE_MS ) > 0
			? Date.now() + ( opts.deadlineMs ?? GREP_DEADLINE_MS )
			: Number.POSITIVE_INFINITY
		const overtime = (): boolean => Date.now() >= deadline

		// WHAT THE WALK DID NOT LOOK AT ( DEFECT-2893 ). Separate from every cap above, and the more dangerous fact of
		// the two: a cap makes a visibly short list, while a silent prune makes a COMPLETE-looking answer over a tree
		// that was never fully walked — "No match for X in 41 file( s )" with the string sitting in a pruned
		// `scripts/build`. Carried on every directory-walk return so no exit can drop it.
		const pruned: string[] = []
		let   prunedTotal      = 0

		// WHY one file was skipped, written by `scanFile` and read ONLY on the single-file path below. The walk
		// overwrites it freely and that is harmless: the walk's returns all carry null, because one cause cannot
		// honestly speak for a tree full of skipped files.
		let skip: GrepSkip | null = null

		/** Open one candidate and take its matching lines. TRUE only when actually read: skips are not searches. Sets `capped` on an
		 *  early stop. A closure, because every ceiling it honours is already in scope. */
		const scanFile = ( full: string ): boolean => {
			let size: number
			try { size = statSync( full ).size }
			catch( err ) { this._warn( 'grep_stat_failed', { path: full, message: this._msg( err ) } ); skip = 'unreadable'; return false }
			// The two are separated because the fix differs: an empty file is the answer, an oversized one is a cap.
			if( size === 0 )        { skip = 'empty';     return false }
			if( size > maxBytes )   { skip = 'oversized'; return false }

			let body: string
			try { body = String( readFileSync( full, 'utf-8' ) ) }
			catch( err ) { this._warn( 'grep_read_failed', { path: full, message: this._msg( err ) } ); skip = 'unreadable'; return false }

			const lines = body.split( /\r?\n/ )

			// Find, then report: a context window can cover a hit, and a hit must not be labelled context.
			// Knowing every hit first makes that label a lookup rather than a guess.
			const hitAt: number[] = []
			for( let i = 0; i < lines.length; i++ ) {
				if( !_lineHas( lines[ i ] ?? '', needle, fold, opts.wholeWord === true ) ) continue
				hitAt.push( i )
				// A locating search stops at its first hit: the rest of the file cannot change which files match.
				if( mode === 'files' ) break
			}
			if( hitAt.length === 0 ) return true
			counts.push( { path: full, matches: hitAt.length } )
			if( mode !== 'rows' ) return true

			const isHit = new Set( hitAt )
			// The last line already pushed, so overlapping context windows never report a line twice.
			let emitted = -1
			let taken   = 0
			for( const i of hitAt ) {
				// Asked apart, and the budget first: both can be true at once, and the one that ended the WALK is
				// the one worth reporting.
				if( spent() )          { _capAt( 'rows' ); break }
				if( taken >= maxFile ) { _capAt( 'file' ); break }
				taken += 1
				const from = Math.max( emitted + 1, i - before )
				const to   = Math.min( lines.length - 1, i + after )
				for( let j = from; j <= to; j++ ) {
					if( spent() ) { _capAt( 'rows' ); break }
					const line = lines[ j ] ?? ''
					// Truncate the line, never drop the match: a generated file past every filter would otherwise eat the result.
					const text = line.length > GREP_LINE_CHARS ? line.slice( 0, GREP_LINE_CHARS ) + ' …' : line
					rows.push( isHit.has( j ) ? { path: full, line: j + 1, text } : { path: full, line: j + 1, text, context: true } )
					emitted = j
				}
			}
			// A backstop, and deliberately NOT an attribution: every path that leaves hits untaken has already
			// named its own cap above, and guessing here would overwrite a true `rows` with a false `file`.
			if( taken < hitAt.length ) capped = true
			return true
		}

		// A file root is searched directly and the glob is not consulted: a filter over one file narrows nothing.
		// Noise and deny rules still apply, since they govern what may be opened, which one explicit path does not overrule.
		// Stat'd directly, not via this.stat: a missing root is the walk's to report, not a second stat_failed.
		let rootIsFile = false
		try { rootIsFile = !statSync( root ).isDirectory() } catch { /* missing or unreadable — the walk says so */ }
		if( rootIsFile ) {
			// Asked in refusal order rather than as one boolean, so the cause that applied is the cause reported.
			// Noise first and protection last matches the walk's own order, where the cheapest refusal runs first.
			const refused: GrepSkip | null =
				  noise && Noise.skipsFile( basename( root ) ) ? 'noise'
				: !TextTypes.isText( root )                    ? 'nontext'
				: Blacklist.excludes( root, deny )             ? 'protected'
				: null
			// A file root enters no directory, so there is nothing it could have pruned — `[]` here is a fact, not a default.
			if( refused ) return { rows, searched: 0, capped: false, cappedBy: null, cancelled: false, counts, candidates: 0, nearMisses: 0, rootIsFile: true, fileSkip: refused, pruned: [], prunedTotal: 0 }
			const read = scanFile( root )
			return { rows, searched: read ? 1 : 0, capped, cappedBy, cancelled: false, counts, candidates: 1, nearMisses: 0, rootIsFile: true, fileSkip: read ? null : skip, pruned: [], prunedTotal: 0 }
		}

		/** Out of time, with what it has. One expression so the three checkpoints below cannot disagree about the
		 *  verdict they write, and `_capAt` is not used: this did not cut a payload, it ended the walk. */
		const outOfTime = (): GrepScan => {
			this._warn( 'grep_deadline', { root, query, searched, visited } )
			return { rows, searched, capped: true, cappedBy: 'time', cancelled: false, counts, candidates, nearMisses, rootIsFile: false, fileSkip: null, pruned, prunedTotal }
		}

		while( stack.length > 0 ) {
			// CHECKPOINT ONE, before the readdir rather than after it: a directory is the unit this loop cannot
			// interrupt, so the cheapest honest place to stop is before entering another one.
			if( overtime() ) return outOfTime()

			const dir = stack.pop() as string

			let dirents: { name: string; isDir: boolean; isLink: boolean }[]
			try {
				dirents = readdirSync( dir, { withFileTypes: true } ).map( ( d ) => ( { name: d.name, isDir: d.isDirectory(), isLink: d.isSymbolicLink() } ) )
			} catch( err ) {
				this._warn( 'grep_walk_failed', { dir, message: this._msg( err ) } )
				continue
			}

			// Taken once per directory, not once per entry: this is the sibling list `Noise.skipsDir` needs to tell a
			// toolchain's `out` from a source directory of the same name, and the readdir above already paid for it.
			const siblings = dirents.map( ( d ) => d.name )

			for( const d of dirents ) {
				visited += 1
				budget  += 1
				if( visited > GREP_WALK_CAP ) {
					this._warn( 'grep_walk_capped', { root, query, cap: GREP_WALK_CAP } )
					return { rows, searched, capped: true, cappedBy: 'walk', cancelled: false, counts, candidates, nearMisses, rootIsFile: false, fileSkip: null, pruned, prunedTotal }
				}

				const full = join( dir, d.name )

				if( d.isDir ) {
					// Pruned, not filtered: the subtree is never entered — and now RECORDED, so the answer can name it.
					if( noise && Noise.skipsDir( d.name, siblings ) ) {
						prunedTotal += 1
						if( pruned.length < PRUNE_REPORT_CAP ) pruned.push( relative( root, full ).split( sep ).join( '/' ) )
						continue
					}
					// A protected subtree is NOT reported: naming it would confirm that a path the blacklist exists to
					// conceal is there. The noise list protects nothing, which is why it can be disclosed.
					if( Blacklist.excludes( full, deny ) ) continue
					stack.push( full )
					continue
				}

				// Links are never opened: the root was admitted, and a link under it can point anywhere, which breaks containment by one name.
				if( d.isLink ) continue
				// Cheap refusals run before the stat, and the stat before the read: a protected file is dropped, never read then withheld.
				if( noise && Noise.skipsFile( d.name ) ) continue
				if( !TextTypes.isText( full ) ) continue
				candidates += 1
				if( filter ) {
					const rel = relative( root, full ).split( sep ).join( '/' )
					if( !Glob.matches( rel, filter ) ) {
						// A basename hit here means the caller read the glob as filename matching; counted so the refusal can name the fix.
						if( Glob.matches( d.name, filter ) ) nearMisses += 1
						continue
					}
				}
				if( Blacklist.excludes( full, deny ) ) continue

				if( !scanFile( full ) ) continue
				searched += 1
				budget   += GREP_READ_COST

				// CHECKPOINT TWO. A file read is the single most expensive thing this walk does, so the deadline is
				// read once per read — that is what bounds the overshoot to one file rather than to one directory.
				if( overtime() ) return outOfTime()

				// The budget ends the walk, not just this file: a partial answer gains nothing from more opens.
				if( spent() ) {
					this._warn( 'grep_truncated', { root, query, cap: maxRows, mode } )
					return { rows, searched, capped: true, cappedBy: 'rows', cancelled: false, counts, candidates, nearMisses, rootIsFile: false, fileSkip: null, pruned, prunedTotal }
				}

				if( budget >= GREP_YIELD_BUDGET ) {
					budget = 0
					await _tick()
					if( token.cancelled ) return { rows, searched, capped, cappedBy, cancelled: true, counts, candidates, nearMisses, rootIsFile: false, fileSkip: null, pruned, prunedTotal }
					// CHECKPOINT THREE, beside the cancel and AFTER the tick. Time spent suspended is still time the
					// caller waited, and a loop that only ever checked before yielding would not count it.
					if( overtime() ) return outOfTime()
				}
			}
		}

		return { rows, searched, capped, cappedBy, cancelled: false, counts, candidates, nearMisses, rootIsFile: false, fileSkip: null, pruned, prunedTotal }
	}

	/** Asks a live Everything instance instead of walking. Returns `null`, never throws, on any failure, which search() reads
	 *  as fall through to the walk. Engages for zero or one root only: es.exe's `-path` takes one directory.
	 *
	 *  THE INDEX IS A MIRROR, AND A MIRROR LAGS IN BOTH DIRECTIONS. It can still hold a path that is gone, and it can
	 *  not yet hold one that exists. Both are handled below, and only one of them can be handled by filtering. */
	private async _esSearch( roots: string[], query: string ): Promise<FileEntry[] | null> {
		if( !this.esBin || roots.length > 1 ) return null

		let stdout: string
		try {
			( { stdout } = await _execFile( this.esBin, SdkFileAccess._esArgs( roots, query ), { timeout: SEARCH_ES_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 } ) )
		} catch( err ) {
			this._warn( 'search_es_unavailable', { message: this._msg( err ) } )
			return null
		}

		let rows: FileEntry[]
		try {
			rows = EsCsv.parse( stdout )
		} catch( err ) {
			this._warn( 'search_es_parse_failed', { message: this._msg( err ) } )
			return null
		}

		const live = SdkFileAccess._esLive( rows )
		if( ( live?.length ?? 0 ) < rows.length ) this._warn( 'search_es_stale_rows', { query, dropped: rows.length - ( live?.length ?? 0 ) } )
		if( live === null ) this._warn( 'search_es_empty', { query } )

		return live
	}

	/**
	 * The index's rows judged against the disk — the whole of this fast path's staleness policy, in one place.
	 * `null` means the index gave NO USABLE ANSWER, which search() reads as fall through to the walk.
	 *
	 * Deleted-but-indexed is the direction a filter CAN fix: one existsSync a row, and a hit that cannot be opened
	 * is worse than no hit at all. The rows are bounded by `-max-results`, so this is SEARCH_MATCH_CAP stats at worst.
	 *
	 * NOTHING FROM THE INDEX IS NOT EVIDENCE OF ABSENCE, and that direction no filter reaches. Everything knows a
	 * volume it is monitoring; a folder made seconds ago, or anything on a volume it does not watch at all, is simply
	 * not in it — and that answer is shaped exactly like "no such file". So an empty answer is read as no answer and
	 * the walk runs: the walk is what every query did before this fast path existed, with the same cap, the same
	 * yielding and the same cancel token, so the cost is the old one and it is now paid only when the index said
	 * nothing. A NON-empty answer is trusted — the index knew about this query.
	 *
	 * Split from the spawn so it is testable against real files with no live Everything, which is the same reason
	 * _esArgs and EsCsv are pure.
	 */
	static _esLive( rows: FileEntry[] ): FileEntry[] | null {
		const live = rows.filter( ( e ) => existsSync( e.path ) )
		return live.length > 0 ? live : null
	}

	/** Pure argv builder, testable without a process. Column order is FIXED by these flags: EsCsv.parse reads it positionally.
	 *  -date-format 3 is ISO-8601 UTC, unambiguous across timezones. An empty `roots` omits -path, which searches every volume. */
	static _esArgs( roots: string[], query: string ): string[] {
		const args = [
			'-csv', '-no-header',
			'-name', '-filename-column', '-attributes', '-size', '-date-modified', '-date-format', '3',
			'-max-results', String( SEARCH_MATCH_CAP )
		]
		if( roots.length === 1 && roots[ 0 ] ) args.push( '-path', roots[ 0 ] )
		args.push( query )
		return args
	}

	// ── writes ───────────────────────────────────────────────────────────────────────
	// Each write returns a boolean the caller must trust. Collision policy lives in the caller, and the Electron-only
	// ops (trash, reveal) stay off this core because they need `shell`, which would couple it to one host.

	/** Make a directory ( recursive — parents created as needed ). */
	mkdir( path: string ): boolean {
		try {
			mkdirSync( path, { recursive: true } )
			return true
		} catch( err ) {
			this._warn( 'mkdir_failed', { path, message: this._msg( err ) } )
			return false
		}
	}

	/** Create a new EMPTY file. The `wx` flag refuses to clobber an existing file (a fresh touch only,
	 *  never an overwrite) — the caller de-collides the name first, so a collision here is a real fault. */
	createFile( path: string ): boolean {
		try {
			writeFileSync( path, '', { flag: 'wx' } )
			return true
		} catch( err ) {
			this._warn( 'create_failed', { path, message: this._msg( err ) } )
			return false
		}
	}

	/** Save text content. Parent dirs are created, and an existing file is OVERWRITTEN, unlike createFile's no-clobber touch. */
	write( path: string, content: string ): boolean {
		try {
			mkdirSync( dirname( path ), { recursive: true } )
			writeFileSync( path, content, 'utf-8' )
			return true
		} catch( err ) {
			this._warn( 'write_failed', { path, message: this._msg( err ) } )
			return false
		}
	}

	/** Rename / move by exact paths — the raw lever. `from` → `to`, no collision check (the caller owns
	 *  that policy). A cross-volume move surfaces as EXDEV; for that, use `move`, which falls back. */
	rename( from: string, to: string ): boolean {
		try {
			renameSync( from, to )
			return true
		} catch( err ) {
			this._warn( 'rename_failed', { from, to, message: this._msg( err ) } )
			return false
		}
	}

	/** Recursively copy `from` to the exact path `to` ( file or whole directory ). */
	copy( from: string, to: string ): boolean {
		try {
			cpSync( from, to, { recursive: true } )
			return true
		} catch( err ) {
			this._warn( 'copy_failed', { from, to, message: this._msg( err ) } )
			return false
		}
	}

	/** Move `from` to the exact path `to`. A plain rename first ( atomic, same-volume ); on a cross-volume
	 *  EXDEV failure, fall back to copy-then-remove so a move across drives still works. */
	move( from: string, to: string ): boolean {
		try {
			renameSync( from, to )
			return true
		} catch( err ) {
			if( ( err as NodeJS.ErrnoException )?.code === 'EXDEV' ) {
				try {
					cpSync( from, to, { recursive: true } )
					rmSync( from, { recursive: true, force: true } )
					return true
				} catch( err2 ) {
					this._warn( 'move_failed', { from, to, message: this._msg( err2 ) } )
					return false
				}
			}
			this._warn( 'move_failed', { from, to, message: this._msg( err ) } )
			return false
		}
	}

	/** A non-colliding variant of `desired`: the path itself if it's free, else the same name with a numeric suffix
	 *  ("report.md" → "report 2.md", "Notes" → "Notes 2"), keeping the extension. Pure: existsSync only, no mutation. */
	uniquePath( desired: string ): string {
		if( !existsSync( desired ) ) return desired
		const dir  = dirname( desired )
		const ext  = extname( desired )
		const stem = basename( desired, ext )
		for( let n = 2; n < 10000; n += 1 ) {
			const candidate = join( dir, `${ stem } ${ n }${ ext }` )
			if( !existsSync( candidate ) ) return candidate
		}
		return desired
	}

	/**
	 * How deeply `path` may be reached, and what supplied that depth. Shared by the spawned MCP child and the in-process
	 * FileGate built-in, since a security rule living in two places behaves two ways. Floor plus: the deepest level anything
	 * grants, maximised. A grant covers exactly its subject and goes through the same `jail` as a configured root, so the `..`
	 * collapse, the `sep` boundary and Windows case-folding are inherited. A grant is an exception to containment only: it does
	 * not reach the blacklist. `via` names a grant only when it lifted the verdict above configuration.
	 */
	static resolveLevel( path: string, entries: readonly AccessEntry[], grants: readonly GrantRef[] = [] ): AccessVerdict {
		let configured: AccessLevel = 'none'
		for( const entry of entries ) {
			if( SdkFileAccess.jail( path, [ entry.path ] ) === null ) continue
			configured = higherLevel( configured, entry.level )
		}

		let best: GrantRef | null = null
		let granted: AccessLevel = 'none'
		for( const grant of grants ) {
			// Skipped by kind, not by level: a qualified tool id is a string that `jail` would resolve as a relative directory name.
			if( grant.kind !== 'file' && grant.kind !== 'folder' ) continue
			if( SdkFileAccess.jail( path, [ grant.subject ] ) === null ) continue
			if( accessRank( grant.level ) <= accessRank( granted ) ) continue
			granted = grant.level
			best    = grant
		}

		if( accessRank( granted ) > accessRank( configured ) ) return { level: granted, via: best, granted }
		if( configured !== 'none' ) return { level: configured, via: 'config', granted }
		return { level: 'none', via: null, granted }
	}

	/**
	 * Everywhere an agent may go: the enabled roots plus every grant subject, deduped. A refusal points at this list, so it is
	 * a WITNESS, never the boundary: resolveLevel decides, and this only describes it. Filtered by `required`, so a refusal
	 * never sends a write toward read-only roots.
	 */
	static scope( entries: readonly AccessEntry[], grants: readonly GrantRef[] = [], required: AccessLevel = 'read' ): string[] {
		return SdkFileAccess.scopeEntries( entries, grants, required ).map( ( e ) => e.path )
	}

	/**
	 * The scope witness with each path's LEVEL, so an agent can see a boundary before it hits it. A path named twice reports
	 * the HIGHER level, as resolveLevel would, or this would disagree with the boundary. It carries no origin marker and must
	 * not grow one: one row can merge a configured entry and a grant.
	 */
	static scopeEntries( entries: readonly AccessEntry[], grants: readonly GrantRef[] = [], required: AccessLevel = 'read' ): AccessEntry[] {
		const best = new Map<string, AccessLevel>()
		const raise = ( path: string, level: AccessLevel ): void => {
			const held = best.get( path )
			best.set( path, held ? higherLevel( held, level ) : level )
		}
		for( const entry of entries ) {
			if( accessRank( entry.level ) >= accessRank( required ) ) raise( entry.path, entry.level )
		}
		for( const grant of grants ) {
			if( grant.kind !== 'file' && grant.kind !== 'folder' ) continue
			if( accessRank( grant.level ) >= accessRank( required ) ) raise( grant.subject, grant.level )
		}
		return [ ...best ].map( ( [ path, level ] ) => ( { path, level } ) )
	}

	/**
	 * The sentence a refusal points with. It states the why (a containment refusal, not a missing or blacklisted file) before
	 * the where (the scope, so an agent does not guess paths), and both doors share it so the advice cannot diverge.
	 * Too shallow is a third outcome with its own next move. Answer in operations, never rung names.
	 */
	static refusal( verdict: AccessVerdict, required: AccessLevel, scope: string[] ): string {
		// Too shallow is checked first: it is the most specific truth, and the scope list would send the agent away from a file it stands on.
		if( verdict.level !== 'none' ) {
			return `It is within reach but not deeply enough: you may ${ operationsFor( verdict.level ) } there, `
				+ `and this needs ${ verbFor( required ) }. Ask the user to raise that folder in the file-access `
				+ 'settings, or to drop the file into the context gutter.'
		}

		if( !scope.length ) {
			// Only at READ is "no file access at all" true; at a deeper rung it would mislead an agent that has some access.
			return required === 'read'
				? 'You have no file access at all right now — no roots are configured and nothing has been handed to you. '
					+ 'Ask the user to add a root in the file-access settings, or to drop the file into the context gutter.'
				: `Nothing you can reach is deep enough to ${ verbFor( required ) } — that is off everywhere right now. `
					+ 'Ask the user to raise a root in the file-access settings, or to drop the file into the context gutter.'
		}

		return `It sits outside every path you may ${ verbFor( required ) }. You may ${ verbFor( required ) } within: `
			+ `${ scope.join( ', ' ) }. Work inside one of those, or ask the user to add that folder or drop the `
			+ 'file into the context gutter.'
	}

	/** The deny-list refusal, worded once for both doors. It is not a reach problem, so asking or relocating will not fix it. */
	static blacklistLine(): string {
		// Names the rule and its reference: a listed file cannot be opened to learn why it was refused, so this line is the only route.
		return 'It matches a protected pattern ( credentials, keys and repository internals, plus the Runbook\'s '
			+ 'command roster and a skill\'s `SKILL.md`, which are authored instruction rather than data ) — the deny-list\'s '
			+ 'defaults hold unconditionally and no configuration can switch one off. This is not something a '
			+ 'retry, a different path or a granted file will fix. What each pattern protects, and the roster\'s '
			+ 'shape if a user needs to edit it themselves, is in '
			+ '_Claude/references/file/protected-paths-and-the-command-roster.html.'
	}

	/** The REAL path if it sits inside one of `roots`, else null. Both sides are resolved through links, so a link inside a root
	 *  cannot lead out, and a caller must open the returned path, never the spelling it was given. `..` collapses first, and the
	 *  `sep` boundary stops `/foo/bar` matching a `/foo/ba` root. */
	static jail( path: string, roots: string[] ): string | null {
		const target = SdkFileAccess.real( path )
		// Windows is case-insensitive: compare folded, but return the real casing for the fs op.
		const fold = process.platform === 'win32' ? ( s: string ) => s.toLowerCase() : ( s: string ) => s
		const t    = fold( target )
		for( const root of roots ) {
			const base = fold( SdkFileAccess.real( root ) )
			if( t === base || t.startsWith( base + sep ) ) return target
		}
		return null
	}

	/**
	 * Where a path really is: every link followed, `..` collapsed. A missing path resolves through its deepest existing ancestor,
	 * so nothing that does not exist can redirect. A dangling link is followed to its stated target, since a write through one creates it.
	 */
	static real( path: string, hops = 0 ): string {
		const target = resolve( path )
		if( hops > LINK_HOPS ) return UNREACHABLE
		const tail: string[] = []
		let head = target
		for( ;; ) {
			try {
				return join( realpathSync.native( head ), ...tail )
			} catch {
				const pointed = SdkFileAccess._pointsAt( head )
				if( pointed !== null ) return SdkFileAccess.real( join( pointed, ...tail ), hops + 1 )
				const parent = dirname( head )
				if( parent === head ) return target
				tail.unshift( basename( head ) )
				head = parent
			}
		}
	}

	/** Where a link at `path` says it goes, or null when `path` is not a link. */
	private static _pointsAt( path: string ): string | null {
		try {
			if( !lstatSync( path ).isSymbolicLink() ) return null
			return resolve( dirname( path ), readlinkSync( path ) )
		} catch {
			return null
		}
	}

	// ── private ──────────────────────────────────────────────────────────────────────

	/** One FileEntry, or null when the child cannot be stat'd: one bad child never aborts a listing. `isDir` comes from the dirent. */
	private _entry( dir: string, name: string, isDir: boolean ): FileEntry | null {
		const full = join( dir, name )
		try {
			const s = statSync( full )
			return {
				name,
				path:  full,
				isDir,
				size:  s.size,
				ext:   extname( name ).replace( /^\./, '' ).toLowerCase(),
				mtime: s.mtimeMs
			}
		} catch {
			return null
		}
	}

	/** Existing drive roots. Windows: probe A:..Z: (cheap existsSync). POSIX: the single '/'. */
	private _drives(): string[] {
		if( process.platform !== 'win32' ) return [ '/' ]
		const out: string[] = []
		for( let c = 65; c <= 90; c += 1 ) {
			const root = `${ String.fromCharCode( c ) }:\\`
			if( existsSync( root ) ) out.push( root )
		}
		return out
	}

	private _warn( event: string, detail: Record<string, unknown> ): void {
		this.onWarn?.( event, detail )
	}

	private _msg( err: unknown ): string {
		return err instanceof Error ? err.message : String( err )
	}
}
