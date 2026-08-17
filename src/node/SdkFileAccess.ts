import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, cpSync, rmSync } from 'fs'
import { join, extname, relative, resolve, sep, dirname, basename } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TextTypes } from '../core/TextTypes'
import { Glob } from '../core/Glob'
import { NameMatch } from '../core/NameMatch'
import { EsCsv } from '../core/EsCsv'
import type { FileEntry, FileStat, FileRoots } from '../core/FileTypes'
import { higherLevel, operationsFor, verbFor, type AccessEntry } from '../core/AccessPolicy'
import { accessRank, type AccessLevel } from '../session/InjectedItem'
import type { GrantRef } from '../session/InjectedItem'

/**
 * What a path resolves to, and what supplied it.
 *
 * Carries `via` because BOTH outcomes have to be auditable, not just the refusal. `'config'` when the
 * configured floor is what permitted this, the grant itself when a grant lifted it above that floor, and
 * null only when the answer is `none` — so a caller can always answer "why was this allowed?" without
 * recomputing anything.
 */
export interface AccessVerdict {
	level: AccessLevel
	via:   'config' | GrantRef | null
	/**
	 * The depth GRANTS alone give this path — the fact "a person explicitly handed this subject over, at
	 * this rung", independent of whether that was what decided the verdict.
	 *
	 * Separate from `via` because they answer different questions and one caller needs both. `via` is for
	 * the AUDIT line and names a grant only when it changed the outcome. This is for the write surface,
	 * which relaxes its extension limit on an explicit hand-over — and that must not depend on whether
	 * configuration happened to already cover the path, or the same gesture would work on a file outside
	 * the project and be refused on one inside it, for reasons invisible to the person making it.
	 */
	granted: AccessLevel
}

const _execFile = promisify( execFile )

// Caps — guard the wire AND the heap, identically for every reader. A directory returns at most
// LIST_CAP entries (no pagination by design — a 50k folder shows its first 1000, navigate inward).
// A file reads only under READ_CAP_BYTES — never slurp a 2 GB file as utf-8. A glob returns at most
// GLOB_CAP matches and walks at most GLOB_WALK_CAP entries — when either trips, the walk halts with
// what it has and pings onWarn (the consumer routes that to its WARNINGS channel).
export const LIST_CAP       = 1000
export const READ_CAP_BYTES = 1_048_576   // 1 MiB
export const GLOB_CAP       = 1000
export const GLOB_WALK_CAP  = 50_000

// search()'s own caps — sized for a user-initiated, cancelable, whole-DRIVE walk rather than a
// bounded project-scoped glob, so they're deliberately much larger than GLOB_CAP/GLOB_WALK_CAP
// above: SEARCH_WALK_CAP is a backstop against a runaway walk (a symlink cycle, a truly enormous
// drive), not the primary control — the Cancel token is. SEARCH_YIELD_EVERY is how often the walk
// hands control back to the event loop; without this a whole-drive search would block the ENTIRE
// Electron main process (not just this feature) until it finished, and a cancel could never land.
export const SEARCH_MATCH_CAP   = 2000
export const SEARCH_WALK_CAP    = 2_000_000
export const SEARCH_YIELD_EVERY = 500

// The es.exe fast path's own timeout — spawn-and-parse a real Everything query, which the live
// benchmark clocked at 19-32ms even for a pathological single-letter whole-drive query. 5s is a
// generous ceiling for a call that should never realistically approach it; a hang here (not just a
// miss) still falls through to the walk rather than hanging the caller.
export const SEARCH_ES_TIMEOUT_MS = 5000

/** Cooperative-cancel handle for `search()` — the caller flips `cancelled` from elsewhere (a new
 *  query, an explicit Cancel click) and the walk notices it at its next yield point. Plain mutable
 *  data, not an AbortController: this needs to cross the IPC pull lane, which AbortController can't. */
export type SearchToken = { cancelled: boolean }

/** Yield one tick of the event loop — the walk's cooperative-cancellation + main-process-responsiveness
 *  seam. `setImmediate` (not a Promise microtask) so pending IPC/UI work actually gets a turn. */
function _tick(): Promise<void> {
	return new Promise( ( resolve ) => setImmediate( resolve ) )
}

/** A degrade observer — the consumer's tracer, INJECTED, never imported. This copies the SDK's
 *  established capability-injection idiom (see `LensObject`'s disk-reader strategy in `node/io.ts`):
 *  the shared core must stay framework-free. Reaching up to a concrete host logger here — e.g.
 *  `import { MainBus }` — is the bug class this guards against: it would couple this one core to a
 *  single host and silently break the others. The file MCP runs as a SEPARATE PROCESS with no
 *  MainBus; the renderer cannot import the node layer at all. So the consumer passes its own tracer
 *  and the core just calls it. Emits a bare event name + detail on every degraded path; the consumer
 *  namespaces/routes it (MainFileService → MainBus.debug, the MCP → its own trace, or nobody). */
export type FileWarn = ( event: string, detail: Record<string, unknown> ) => void

/**
 * SdkFileAccess — the shared filesystem READ core. Raw `fs`, framework-free: the floors (LIST_CAP,
 * READ_CAP_BYTES, the TextTypes gate) live HERE so every reader — MainFileService, the renderer
 * (via the pull channel), and the file MCP — enforces identical limits instead of drifting. Every
 * op guards-and-defaults: a denied / missing / oversized / binary case folds to `[]` / `null` and
 * pings the injected `onWarn` (if any), never a throw — a host built on this stays alive no matter
 * what it's pointed at.
 *
 * Distinct from `Vault` (jailed to a docRoot): this is general disk, jailed only by the caller. The
 * static `jail()` is the pure containment primitive the agent surface's `WhitelistGuard` builds on;
 * this class itself imposes no path jail — that is the caller's authorization layer, not the core's.
 */
export class SdkFileAccess {

	constructor(
		private readonly onWarn?: FileWarn,
		/** Path to a vendored `es.exe` (voidtools' Everything CLI) — search()'s optional fast path.
		 *  SAME capability-injection idiom as onWarn: the core stays framework-free and doesn't know
		 *  or care whether it's running under Electron or as the file MCP's separate process — each
		 *  consumer resolves ITS OWN binary location (dev vs packaged, main vs the MCP child) and
		 *  hands in the already-resolved path. Omitted/null → search() always uses the walk; never a
		 *  hard dependency (see _Claude/plans/search-all-files.html, Phase 5). */
		private readonly esBin?: string | null
	) {}

	/** The browser's navigation anchors: the user's home dir + every existing drive root. */
	roots(): FileRoots {
		return { home: homedir(), drives: this._drives() }
	}

	/** One directory's immediate children — dirs first, then files, each alphabetical. Capped at
	 *  LIST_CAP (a warn marks a truncated dir). Cheap: sorts off the dirent's own type and caps BEFORE
	 *  statting, so a 50k folder costs 50k dirents, not 50k stats. A missing / denied dir folds to []. */
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

	/** A text file's contents, or null. Gated THREE ways: a known text extension (TextTypes — the
	 *  whitelist, not a guess from bytes), a size under READ_CAP, and a successful read. A binary /
	 *  oversized / unreadable file → null + warn; never a heap-blowing slurp, never a throw. */
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

	/** Recursively match entries under `root` against a glob ( * within a segment, ** across ), using
	 *  the shared Glob matcher so disk-walk results match Vault's vault-glob exactly. Matches BOTH
	 *  files and dirs (an agent may be hunting a directory, not just files); every dir is traversed
	 *  regardless of whether it matched. Paths match relative to `root`, '/'-normalized. Bounded two
	 *  ways: at GLOB_CAP matches and GLOB_WALK_CAP visited entries — when either trips the walk halts
	 *  with what it has and warns (made-safe-locally, bubble-up). A denied / missing subtree folds to
	 *  a skip + warn, never a throw — the same guard-and-default contract as list/read. */
	glob( root: string, pattern: string ): FileEntry[] {
		const out:   FileEntry[] = []
		const stack: string[]    = [ root ]
		let   visited            = 0

		while( stack.length > 0 ) {
			const dir = stack.pop() as string

			let dirents: { name: string; isDir: boolean }[]
			try {
				dirents = readdirSync( dir, { withFileTypes: true } ).map( ( d ) => ( { name: d.name, isDir: d.isDirectory() } ) )
			} catch( err ) {
				this._warn( 'glob_walk_failed', { dir, message: this._msg( err ) } )
				continue
			}

			for( const d of dirents ) {
				visited += 1
				if( visited > GLOB_WALK_CAP ) {
					this._warn( 'glob_walk_capped', { root, pattern, cap: GLOB_WALK_CAP } )
					return out
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
						return out
					}
				}

				if( d.isDir ) {
					stack.push( full )
				}
			}
		}

		return out
	}

	/** Recursively find entries whose NAME contains `query` (case-insensitive substring — see
	 *  NameMatch). `roots` is EITHER a subfolder scope (one entry) OR the whole computer (an EMPTY
	 *  array — not an enumerated drive list; both this method and _esSearch expand '[]' to every
	 *  drive themselves, so the caller never has to know how "everywhere" is represented).
	 *
	 *  Tries the ES fast path FIRST when a binary was injected (see the constructor) — a real,
	 *  already-live Everything instance answers in tens of milliseconds instead of walking disk; see
	 *  _Claude/plans/search-all-files.html Phase 5. Any failure there (missing binary, Everything not
	 *  running, a timeout, a multi-root call ES's -path can't express) falls through silently to the
	 *  walk below — the fast path is a pure accelerant, never a hard dependency.
	 *
	 *  The walk itself is ASYNC and yields the event loop every SEARCH_YIELD_EVERY visited entries: a
	 *  whole-drive walk run synchronously would freeze the entire Electron main process, not just this
	 *  feature, and a cancel could never be noticed mid-walk. Pass a SearchToken and flip `.cancelled`
	 *  from elsewhere to stop it at its next yield point — it returns what it has so far, never throws.
	 *  A blank query returns [] immediately (never silently lists the whole machine). Bounded by
	 *  SEARCH_MATCH_CAP / SEARCH_WALK_CAP, same degrade-and-warn contract as glob(). */
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

	/** The fast path: ask a real, already-live Everything instance instead of walking disk. Returns
	 *  `null` — never throws — on ANY failure, which `search()` reads as "fall through to the walk":
	 *  missing binary (ENOENT), Everything not running, a timeout, unparseable output. Only engages
	 *  for zero or ONE root — es.exe's `-path` takes a single directory, and neither of our own
	 *  callers (folder scope, whole-computer scope) ever ask for more than that; a genuine multi-root
	 *  call skips straight to the walk rather than trying to fan out N processes for one query. */
	private async _esSearch( roots: string[], query: string ): Promise<FileEntry[] | null> {
		if( !this.esBin || roots.length > 1 ) return null

		let stdout: string
		try {
			( { stdout } = await _execFile( this.esBin, SdkFileAccess._esArgs( roots, query ), { timeout: SEARCH_ES_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 } ) )
		} catch( err ) {
			this._warn( 'search_es_unavailable', { message: this._msg( err ) } )
			return null
		}

		try {
			return EsCsv.parse( stdout )
		} catch( err ) {
			this._warn( 'search_es_parse_failed', { message: this._msg( err ) } )
			return null
		}
	}

	/** The es.exe argv for one search — a pure builder ( no spawn, no fs ) so the "-path
	 *  present/absent" scoping logic is directly testable without a real process. Column order is
	 *  FIXED by this exact flag order: Name, Filename ( full path ), Attributes, Size, Date Modified
	 *  — EsCsv.parse relies on it positionally ( -no-header ). -date-format 3 = ISO-8601 UTC,
	 *  parseable unambiguously regardless of the machine's local timezone. `roots.length === 0` (
	 *  whole computer ) omits -path entirely rather than enumerating drives — es.exe already searches
	 *  every indexed volume by default. */
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
	// The mutation half: pure `fs`, framework-free, the same degrade-and-default contract as the reads
	// but with a BOOLEAN currency — a write the caller must know succeeded, not a value that folds to
	// null. Every op guards-and-warns: a denied / colliding / failed write returns `false` and pings
	// `onWarn`, never a throw. Collision POLICY lives in the caller (MainFileService) — these are the
	// raw levers, exact-path-in. The Electron-only ops (recycle-bin trash, OS reveal) are NOT here:
	// they need `shell`, which would couple this framework-free core to one host — they live on the
	// service instead. NOTE: this is filesystem MANAGEMENT (mkdir/touch/move/copy/rename); writing file
	// CONTENT (the editor save) is a separate, later lever.

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

	/** Save text CONTENT to a file ( the editor save ) — the parent dir is created if missing, and an
	 *  existing file is OVERWRITTEN ( unlike createFile's no-clobber touch; overwriting is the point of a
	 *  save ). Boolean + warn like its siblings; the consumer surfaces the failure to the user ( a toast ),
	 *  this core just reports it and routes the OS reason to the warn hook. */
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

	/** A non-colliding variant of `desired`: the path itself if it's free, else the same name with a
	 *  numeric suffix ( "report.md" → "report 2.md", "Notes" → "Notes 2" ) — files keep their extension.
	 *  Pure: `existsSync` only, no mutation. The caller writes to the returned path. */
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
	 * THE resolver — how deeply this path may be reached, and what supplied that depth.
	 *
	 * The one question every guard asks. A read guard needs `read`, a write guard `write`, a delete guard
	 * `delete`, and all three ask this and compare with `levelMeets`. Before this existed the same fold
	 * was performed in five places; they agreed, but by five careful authors rather than by construction.
	 *
	 * Shared because it is enforced in two PROCESSES — the spawned `starmind_file` child and the
	 * in-process built-in behind `FileGate` — and a security rule living in two places is a security rule
	 * with two behaviours. `jail` alone was never enough to share: the COMBINATION rule is the part that
	 * has to match.
	 *
	 * FLOOR PLUS. The verdict is the deepest level anything grants this path — configured entries and
	 * grants alike, maximised, never most-specific. See AccessPolicy for why the model is deliberately
	 * this rigid.
	 *
	 * A grant covers EXACTLY its subject. A file grant permits that file; a folder grant permits that
	 * folder and what sits under it — because a folder grant compiles to a LISTING, and a listing the
	 * agent cannot then read from is a grant in name only. Nothing adjacent to either. Both cases run
	 * through the same `jail` a configured root uses, so a grant inherits its `..` collapse, its `sep`
	 * boundary ( a grant on "/a/b.ts" cannot be stretched to "/a/b.ts.bak" ) and its Windows case-folding,
	 * rather than growing a second path-comparison idiom beside the first.
	 *
	 * A grant is an exception to CONTAINMENT and nothing more. It does not reach the blacklist, which
	 * each caller applies afterwards: the deny-list exists to keep credentials out of a model's context,
	 * and a rule a stray click can switch off is not that.
	 *
	 * `via` NAMES THE GRANT ONLY WHEN THE GRANT MATTERED — when it lifted the verdict above what
	 * configuration alone would have given. That is the auditable fact: a capability EXCEPTION nobody can
	 * see is the one outcome worse than not having the feature, while a grant duplicating access the
	 * agent already had is not an exception at all and reporting it as one would train people to ignore
	 * the line.
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
			// A TOOL grant is not a path grant and has nothing to say about a path. Skipped by KIND rather
			// than left to its `none` level, because a qualified tool id is a string and `jail` would
			// happily resolve it as a relative directory name — improbable, and improbable is not a
			// containment argument.
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
	 * Everywhere an agent may go — the enabled roots plus the subject of every grant in force. The
	 * question `admits` answers one path at a time, answered instead as a LIST.
	 *
	 * Shared for the same reason `admits` is, and it earns it more than it looks: this list is what a
	 * REFUSAL points at. A refusal naming roots the guard would not actually honour teaches the agent to
	 * retry against a fiction, and it would be a convincing fiction — the agent has no other view of its
	 * own scope. One composer means the pointer and the boundary move together.
	 *
	 * A WITNESS, never the boundary. `admits` decides; this only describes. Should the two ever disagree,
	 * `admits` is right and this is the bug. Read the other way round it becomes a permission model made
	 * of prose.
	 *
	 * Deduped, because a granted path may already sit inside a configured root: the user handed over
	 * something the agent could already reach, which is not an error and not worth reporting twice.
	 *
	 * FILTERED BY THE LEVEL THE CALLER NEEDS. A refusal for a write that pointed at read-only roots would
	 * be the same fiction one rung down — the agent retries there and is refused again, having been told
	 * where to go. Defaults to `read` because that is what the existing callers mean; naming the level in
	 * the prose is Phase 6.
	 */
	static scope( entries: readonly AccessEntry[], grants: readonly GrantRef[] = [], required: AccessLevel = 'read' ): string[] {
		return SdkFileAccess.scopeEntries( entries, grants, required ).map( ( e ) => e.path )
	}

	/**
	 * The same witness, still carrying each path's LEVEL — what an agent needs to reason about a boundary
	 * instead of discovering it by tripping over it.
	 *
	 * The bare-path form above answers "where may I go", which is the right shape for a refusal that has
	 * already happened. It is the wrong shape for the question an agent asks BEFORE acting, because a list
	 * of paths with no depths means the only route to learning a root is read-only is to attempt a write and
	 * be refused — the agent is forced to probe the gate to read the policy, and the trace then records a
	 * failed attempt where it should have recorded an informed decision.
	 *
	 * FLOOR PLUS applies here too: a path named by both a configured entry and a grant reports the HIGHER of
	 * the two, exactly as `resolveLevel` would answer for it. Reporting either one alone would make this
	 * witness disagree with the boundary it describes, which is the one thing it may never do.
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
	 * The sentence a refusal POINTS with — where the caller may actually read, and what to do about it.
	 *
	 * A refusal that says "outside the whitelist" and stops tells an agent it was wrong without telling it
	 * what would be right, and an agent with no other view of its own scope answers that by guessing paths
	 * until one sticks. Naming the roots costs one line and ends the guessing.
	 *
	 * It rides on a REFUSAL and never as standing context. The agent does not need to carry its file scope
	 * through every turn; it needs it at the one moment it got the question wrong.
	 *
	 * Shared prose, not just a shared list: BOTH doors refuse — the spawned `starmind_file` child and the
	 * in-process built-in behind `FileGate` — and an agent that learns what to do from one refusal should
	 * not meet different advice from the other. Takes the already-composed scope ( see `scope` ) so the
	 * two callers compose the list once and this only words it.
	 *
	 * States the WHY before the where, and both matter. The why is what tells a caller this was a
	 * CONTAINMENT refusal rather than a missing file or a blacklisted one — three outcomes that want three
	 * different next moves, and an agent that cannot tell them apart retries the wrong one. The where is
	 * what stops the retry being a guess. Written to follow a caller's own `"…" was refused.` opener.
	 *
	 * ── AND NOW THE HOW DEEP, WHICH IS A THIRD OUTCOME, NOT A DETAIL ──
	 * A graded ladder made a refusal possible that the boolean pair could not express: the path is inside a
	 * configured root and the root is simply not deep enough. That is a different fact from "outside every
	 * root" and it wants a different next move — one says GO SOMEWHERE ELSE, the other says ASK FOR MORE
	 * HERE. Reported as the same refusal, an agent handed the first advice for the second problem relocates
	 * a file it should have asked about, which is the worse of the two mistakes and the silent one.
	 *
	 * Deliberately answers in OPERATIONS ( see `operationsFor` / `verbFor` ), never rung names, and the
	 * whole reason that vocabulary sits in the core beside the ladder is so this sentence and the spawned
	 * server's own scope report cannot word one fact two ways.
	 */
	static refusal( verdict: AccessVerdict, required: AccessLevel, scope: string[] ): string {
		// TOO SHALLOW — reachable, just not this deeply. Checked FIRST because it is the most specific thing
		// true about this path, and because the scope list below would otherwise send an agent looking
		// elsewhere for a file it is already standing on.
		if( verdict.level !== 'none' ) {
			return `It is within reach but not deeply enough: you may ${ operationsFor( verdict.level ) } there, `
				+ `and this needs ${ verbFor( required ) }. Ask the user to raise that folder in the file-access `
				+ 'settings, or to drop the file into the context gutter.'
		}

		if( !scope.length ) {
			// At READ this is the whole truth and says so. At a deeper rung it is not — an agent that may read
			// a dozen roots must not be told it has no file access because none of them reach `write`.
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

	/** The deny-list refusal, worded once for both doors. Says the thing an agent most needs to hear about
	 *  this particular refusal: it is not a reach problem, so no amount of asking or relocating fixes it and
	 *  a retry is wasted. Kept beside `refusal` because it is the OTHER containment answer, and the two doors
	 *  drift the moment either one writes its own. */
	static blacklistLine(): string {
		return 'It matches a protected pattern ( credentials, keys, and repository internals are off-limits by '
			+ 'policy ). This is not something a retry or a different path will fix.'
	}

	/** Pure path containment — resolve `path` and return it iff it sits inside one of `roots`, else
	 *  null. No fs touch, no instance state (static). `..` segments resolve away first, so an escaping
	 *  path lands outside every root and returns null; the `sep` boundary stops `/foo/bar` from matching
	 *  a `/foo/ba` root. The primitive `WhitelistGuard` turns a null into a loud GuardError. */
	static jail( path: string, roots: string[] ): string | null {
		const target = resolve( path )
		// Windows filesystems are case-INSENSITIVE — compare case-folded there, so a target whose casing
		// differs from the whitelisted root (a lowercased drive letter, a model that re-cased the path, …)
		// still resolves as contained. The RETURNED path keeps its real resolved casing for the fs op.
		const fold = process.platform === 'win32' ? ( s: string ) => s.toLowerCase() : ( s: string ) => s
		const t    = fold( target )
		for( const root of roots ) {
			const base = fold( resolve( root ) )
			if( t === base || t.startsWith( base + sep ) ) return target
		}
		return null
	}

	// ── private ──────────────────────────────────────────────────────────────────────

	/** Build one FileEntry, or null when the child can't be stat'd (a broken symlink, a permission
	 *  wall) — one bad child never aborts the whole listing. `isDir` comes from the dirent (cheaper
	 *  and symlink-honest enough for v1); size/mtime need the stat. */
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
