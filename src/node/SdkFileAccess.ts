import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, extname, relative, resolve, sep } from 'path'
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

	/** Pure path containment — resolve `path` and return it iff it sits inside one of `roots`, else
	 *  null. No fs touch, no instance state (static). `..` segments resolve away first, so an escaping
	 *  path lands outside every root and returns null; the `sep` boundary stops `/foo/bar` from matching
	 *  a `/foo/ba` root. The primitive `WhitelistGuard` turns a null into a loud GuardError. */
	static jail( path: string, roots: string[] ): string | null {
		const target = resolve( path )
		for( const root of roots ) {
			const base = resolve( root )
			if( target === base || target.startsWith( base + sep ) ) return target
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
