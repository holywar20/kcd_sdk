import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, cpSync, rmSync } from 'fs'
import { join, extname, relative, resolve, sep, dirname, basename } from 'path'
import { homedir } from 'os'
import { TextTypes } from '../core/TextTypes'
import { Glob } from '../core/Glob'
import type { FileEntry, FileStat, FileRoots } from '../core/FileTypes'

// Caps — guard the wire AND the heap, identically for every reader. A directory returns at most
// LIST_CAP entries (no pagination by design — a 50k folder shows its first 1000, navigate inward).
// A file reads only under READ_CAP_BYTES — never slurp a 2 GB file as utf-8. A glob returns at most
// GLOB_CAP matches and walks at most GLOB_WALK_CAP entries — when either trips, the walk halts with
// what it has and pings onWarn (the consumer routes that to its WARNINGS channel).
export const LIST_CAP       = 1000
export const READ_CAP_BYTES = 1_048_576   // 1 MiB
export const GLOB_CAP       = 1000
export const GLOB_WALK_CAP  = 50_000

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

	constructor( private readonly onWarn?: FileWarn ) {}

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
