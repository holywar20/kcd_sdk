import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { join, basename, resolve } from 'path'
import { tmpdir } from 'os'
import { SdkFileAccess, SEARCH_MATCH_CAP, SEARCH_YIELD_EVERY, type SearchToken } from '../SdkFileAccess'
import type { FileEntry } from '../../core/FileTypes'

// search() touches real disk ( it's the shared core's own contract — raw fs, no mocking ) so every
// test works against throwaway dirs under the OS temp folder, cleaned up after each test.

const dirs: string[] = []

function tmpDir(): string {
	const d = mkdtempSync( join( tmpdir(), 'sdkfileaccess-search-' ) )
	dirs.push( d )
	return d
}

afterEach( () => {
	while( dirs.length > 0 ) {
		const d = dirs.pop() as string
		rmSync( d, { recursive: true, force: true } )
	}
} )

describe( 'containment through links', () => {

	/** A project with a secret next door, and a link inside the project pointing at the secret's folder. */
	function planted(): { root: string; outside: string; link: string } {
		const root    = tmpDir()
		const outside = tmpDir()
		writeFileSync( join( outside, 'secret.md' ), 'not yours' )
		const link = join( root, 'link' )
		symlinkSync( outside, link, 'junction' )
		return { root, outside, link }
	}

	/** A FILE symlink, which Windows only lets an elevated or developer-mode process make. */
	function fileLink( target: string, at: string ): boolean {
		try { symlinkSync( target, at, 'file' ); return true }
		catch { return false }
	}

	it( 'judges a path by where it lands, not how it is spelled', () => {
		const { root, link } = planted()
		expect( SdkFileAccess.jail( join( link, 'secret.md' ), [ root ] ) ).toBeNull()
		expect( SdkFileAccess.resolveLevel( join( link, 'secret.md' ), [ { path: root, level: 'delete' } ] ).level ).toBe( 'none' )
	} )

	it( 'judges a file that does not exist yet by its deepest real folder', () => {
		const { root, link } = planted()
		expect( SdkFileAccess.jail( join( link, 'new', 'pwned.md' ), [ root ] ) ).toBeNull()
		expect( SdkFileAccess.jail( join( root, 'new', 'fine.md' ), [ root ] ) ).not.toBeNull()
	} )

	it( 'still contains a project that itself sits behind a link', () => {
		const real  = tmpDir()
		const alias = join( tmpDir(), 'alias' )
		symlinkSync( real, alias, 'junction' )
		writeFileSync( join( real, 'notes.md' ), 'mine' )

		expect( SdkFileAccess.jail( join( alias, 'notes.md' ), [ real ] ) ).not.toBeNull()
		expect( SdkFileAccess.jail( join( real, 'notes.md' ), [ alias ] ) ).not.toBeNull()
	} )

	it( 'returns the real path, so the caller opens what was judged', () => {
		const root = tmpDir()
		writeFileSync( join( root, 'notes.md' ), 'mine' )
		expect( SdkFileAccess.jail( join( root, 'notes.md' ), [ root ] ) ).toBe( join( realpathSync.native( root ), 'notes.md' ) )
	} )

	it( 'follows a dangling link to where a write through it would land', ( ctx ) => {
		const { root, outside } = planted()
		if( !fileLink( join( outside, 'created-by-write.md' ), join( root, 'innocent.md' ) ) ) ctx.skip()
		expect( SdkFileAccess.jail( join( root, 'innocent.md' ), [ root ] ) ).toBeNull()
	} )

	it( 'lands a link loop nowhere', ( ctx ) => {
		const root = tmpDir()
		if( !fileLink( join( root, 'b.md' ), join( root, 'a.md' ) ) || !fileLink( join( root, 'a.md' ), join( root, 'b.md' ) ) ) ctx.skip()
		expect( SdkFileAccess.jail( join( root, 'a.md' ), [ root ] ) ).toBeNull()
	} )

	it( 'never opens a link while searching file contents', async () => {
		const { root, outside } = planted()
		writeFileSync( join( root, 'own.md' ), 'not yours either way' )
		// When the machine allows a file link, it is planted too; the junction is there either way.
		fileLink( join( outside, 'secret.md' ), join( root, 'secret-link.md' ) )

		const scan = await new SdkFileAccess().grepText( root, 'not yours' )

		expect( scan.rows.map( ( r ) => r.path ) ).toEqual( [ join( root, 'own.md' ) ] )
	} )
} )

/**
 * A file is a root too. `readdirSync` throws ENOTDIR on a file, and a swallowed throw reads as a root holding
 * nothing; `rootIsFile` lets callers tell the two apart.
 */
describe( 'SdkFileAccess.grepText with a FILE as the root', () => {

	it( 'searches the one file and flags which shape of root it got', async () => {
		const root = tmpDir()
		const file = join( root, 'notes.md' )
		writeFileSync( file, 'alpha\nbeta\ngamma\n' )

		const scan = await new SdkFileAccess().grepText( file, 'beta' )

		expect( scan.rows ).toEqual( [ { path: file, line: 2, text: 'beta' } ] )
		expect( scan.rootIsFile ).toBe( true )
		expect( scan.searched ).toBe( 1 )
		expect( scan.candidates ).toBe( 1 )
	} )

	it( 'separates a real MISS from an unsearchable root, which used to look identical', async () => {
		const root = tmpDir()
		const file = join( root, 'notes.md' )
		writeFileSync( file, 'alpha\n' )

		const miss = await new SdkFileAccess().grepText( file, 'nowhere' )
		// Searched it and found nothing — the path was never in question.
		expect( miss.searched ).toBe( 1 )
		expect( miss.candidates ).toBe( 1 )
		expect( miss.rootIsFile ).toBe( true )

		const binary = join( root, 'blob.png' )
		writeFileSync( binary, Buffer.from( [ 0x89, 0x50, 0x4e, 0x47 ] ) )
		const unsearchable = await new SdkFileAccess().grepText( binary, 'PNG' )
		// Never opened — but still plainly a file, so a caller cannot report it as a missing directory.
		expect( unsearchable.searched ).toBe( 0 )
		expect( unsearchable.candidates ).toBe( 0 )
		expect( unsearchable.rootIsFile ).toBe( true )
	} )

	it( 'ignores a glob over a set of one', async () => {
		const root = tmpDir()
		const file = join( root, 'notes.md' )
		writeFileSync( file, 'gamma\n' )

		const scan = await new SdkFileAccess().grepText( file, 'gamma', { glob: '**/*.rs' } )

		expect( scan.rows ).toHaveLength( 1 )
	} )

	it( 'leaves a DIRECTORY root reporting exactly as it always has', async () => {
		const root = tmpDir()
		writeFileSync( join( root, 'notes.md' ), 'gamma\n' )

		const scan = await new SdkFileAccess().grepText( root, 'gamma' )

		expect( scan.rootIsFile ).toBe( false )
		expect( scan.rows ).toHaveLength( 1 )
	} )

	it( 'still reports a path that is neither, so a bad root is a bad root', async () => {
		const scan = await new SdkFileAccess().grepText( join( tmpDir(), 'no-such-dir' ), 'anything' )

		expect( scan.rootIsFile ).toBe( false )
		expect( scan.candidates ).toBe( 0 )
		expect( scan.rows ).toEqual( [] )
	} )

	/**
	 * Each skip cause carries a different fix, so each is pinned separately rather than as one truthy check.
	 */
	it( 'names which cause skipped a single file, and distinguishes the ones that look alike', async () => {
		const root = tmpDir()
		const fs   = new SdkFileAccess()

		// EMPTY vs OVERSIZED — both are "nothing came back", and only one of them is a cap to raise.
		const empty = join( root, 'empty.md' )
		writeFileSync( empty, '' )
		expect( ( await fs.grepText( empty, 'anything' ) ).fileSkip ).toBe( 'empty' )

		const big = join( root, 'big.md' )
		writeFileSync( big, 'x'.repeat( 4096 ) )
		expect( ( await fs.grepText( big, 'x', { maxBytes: 16 } ) ).fileSkip ).toBe( 'oversized' )

		// NONTEXT: a binary file, which must not read as merely oversized.
		const blob = join( root, 'blob.png' )
		writeFileSync( blob, Buffer.from( [ 0x89, 0x50, 0x4e, 0x47 ] ) )
		expect( ( await fs.grepText( blob, 'PNG' ) ).fileSkip ).toBe( 'nontext' )

		// PROTECTED is a different refusal from unreadable, and must not borrow its wording.
		const secret = join( root, 'secret.md' )
		writeFileSync( secret, 'alpha\n' )
		expect( ( await fs.grepText( secret, 'alpha', { deny: [ '**/secret.md' ] } ) ).fileSkip ).toBe( 'protected' )

		// A FILE THAT WAS ACTUALLY SEARCHED REPORTS NULL, so null never has to stand in for a cause.
		const fine = join( root, 'fine.md' )
		writeFileSync( fine, 'beta\n' )
		const read = await fs.grepText( fine, 'beta' )
		expect( read.fileSkip ).toBeNull()
		expect( read.searched ).toBe( 1 )

		// A MISS IS NOT A SKIP EITHER — it was opened and read, and the query simply was not in it.
		expect( ( await fs.grepText( fine, 'nowhere' ) ).fileSkip ).toBeNull()
	} )

	/** The extension whitelist, at the layer that gates every door onto a file. */
	it( 'opens a .jsonl now, and still will not open a real binary', async () => {
		const root = tmpDir()
		const fs   = new SdkFileAccess()

		const jsonl = join( root, 'trace-perf.jsonl' )
		writeFileSync( jsonl, '{"verb":"PERF.LOOP.DONE"}\n{"verb":"BOOT.SERVICE.DONE"}\n', 'utf-8' )
		const scan = await fs.grepText( jsonl, 'PERF.LOOP.DONE' )
		expect( scan.searched ).toBe( 1 )
		expect( scan.fileSkip ).toBeNull()
		expect( scan.rows ).toHaveLength( 1 )

		const nd = join( root, 'stream.ndjson' )
		writeFileSync( nd, '{"a":1}\n', 'utf-8' )
		expect( ( await fs.grepText( nd, '"a"' ) ).searched ).toBe( 1 )

		// The whitelist is still a whitelist: widening it did not turn it into a sniff of the bytes.
		const blob = join( root, 'icon.png' )
		writeFileSync( blob, Buffer.from( [ 0x89, 0x50, 0x4e, 0x47 ] ) )
		expect( ( await fs.grepText( blob, 'PNG' ) ).searched ).toBe( 0 )
	} )
} )

/**
 * Context and the cheap modes: a caller must tell a hit from its neighbours, and a mode returning no rows
 * must still be bounded and say when it stopped early.
 */
describe( 'SdkFileAccess.grepText context and modes', () => {

	/** Two files, one with two matches close enough for their context windows to overlap. */
	function planted(): { root: string; one: string; two: string } {
		const root = tmpDir()
		const one  = join( root, 'one.md' )
		const two  = join( root, 'two.md' )
		writeFileSync( one, 'a\nb\nNEEDLE\nd\nNEEDLE\nf\ng\n' )
		writeFileSync( two, 'x\nNEEDLE\nz\n' )
		return { root, one, two }
	}

	it( 'marks context lines and leaves a match unmarked', async () => {
		const { one } = planted()

		const scan = await new SdkFileAccess().grepText( one, 'NEEDLE', { before: 1, after: 1 } )

		expect( scan.rows.map( ( r ) => [ r.line, r.context === true ] ) )
			.toEqual( [ [ 2, true ], [ 3, false ], [ 4, true ], [ 5, false ], [ 6, true ] ] )
	} )

	it( 'reports a line once when two windows overlap, and never labels a match as context', async () => {
		const { one } = planted()

		const scan = await new SdkFileAccess().grepText( one, 'NEEDLE', { before: 3, after: 3 } )

		// Eight lines, because the trailing newline ends an eighth ( empty ) one.
		expect( scan.rows.map( ( r ) => r.line ) ).toEqual( [ 1, 2, 3, 4, 5, 6, 7, 8 ] )
		// Line 5 sits inside line 3's trailing window AND is a match itself — the two-pass scan is what
		// keeps it reported as the second rather than the first.
		expect( scan.rows.filter( ( r ) => !r.context ).map( ( r ) => r.line ) ).toEqual( [ 3, 5 ] )
	} )

	it( 'clamps context rather than refusing it', async () => {
		const { one } = planted()
		const scan = await new SdkFileAccess().grepText( one, 'NEEDLE', { before: 500, after: 500 } )
		expect( scan.rows ).toHaveLength( 8 )
	} )

	it( 'spends context out of the row budget, and says the answer is partial', async () => {
		const { one } = planted()

		const scan = await new SdkFileAccess().grepText( one, 'NEEDLE', { after: 1, maxRows: 2 } )

		expect( scan.rows ).toHaveLength( 2 )
		expect( scan.capped ).toBe( true )
	} )

	it( 'counts every matching line per file, returning no rows', async () => {
		const { root, one, two } = planted()

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE', { mode: 'count' } )

		expect( scan.rows ).toEqual( [] )
		expect( [ ...scan.counts ].sort( ( a, b ) => a.path.localeCompare( b.path ) ) )
			.toEqual( [ { path: one, matches: 2 }, { path: two, matches: 1 } ] )
	} )

	it( 'counts exactly even when maxPerFile would have clipped the rows', async () => {
		const { one } = planted()
		const scan = await new SdkFileAccess().grepText( one, 'NEEDLE', { mode: 'count', maxPerFile: 1 } )
		expect( scan.counts ).toEqual( [ { path: one, matches: 2 } ] )
	} )

	it( 'locates files at one hit each, and spends the budget in FILES', async () => {
		const { root } = planted()

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE', { mode: 'files' } )
		expect( scan.rows ).toEqual( [] )
		expect( scan.counts.map( ( c ) => c.matches ) ).toEqual( [ 1, 1 ] )

		const capped = await new SdkFileAccess().grepText( root, 'NEEDLE', { mode: 'files', maxRows: 1 } )
		expect( capped.counts ).toHaveLength( 1 )
		expect( capped.capped ).toBe( true )
	} )

	it( 'gives a cheap mode no reach a row search does not have', async () => {
		const { root, one } = planted()

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE', { mode: 'count', deny: [ '**/two.md' ] } )

		expect( scan.counts.map( ( c ) => c.path ) ).toEqual( [ one ] )
	} )
} )

describe( 'SdkFileAccess.search', () => {

	it( 'finds a nested match under a single root ( subfolder scope )', async () => {
		const root = tmpDir()
		const deep = join( root, 'sub', 'deep' )
		mkdirSync( deep, { recursive: true } )
		writeFileSync( join( deep, 'target-file.txt' ), '' )
		writeFileSync( join( root, 'unrelated.txt' ), '' )

		const fs = new SdkFileAccess()
		const out = await fs.search( [ root ], 'target' )

		expect( out.map( ( e ) => e.name ) ).toEqual( [ 'target-file.txt' ] )
	} )

	it( 'merges matches across multiple roots ( whole-computer-style scope )', async () => {
		const rootA = tmpDir()
		const rootB = tmpDir()
		writeFileSync( join( rootA, 'alpha-match.txt' ), '' )
		writeFileSync( join( rootB, 'bravo-match.txt' ), '' )

		const fs = new SdkFileAccess()
		const out = await fs.search( [ rootA, rootB ], 'match' )

		expect( out.map( ( e ) => e.name ).sort() ).toEqual( [ 'alpha-match.txt', 'bravo-match.txt' ] )
	} )

	it( 'stops promptly once cancelled mid-walk, without throwing', async () => {
		const root = tmpDir()
		const total = SEARCH_YIELD_EVERY * 2
		for( let i = 0; i < total; i += 1 ) {
			writeFileSync( join( root, `match-${ String( i ).padStart( 4, '0' ) }.txt` ), '' )
		}

		const token: SearchToken = { cancelled: false }
		// Queued before the search: the flip lands before the walk's first yield check, so exactly one batch runs.
		setImmediate( () => { token.cancelled = true } )

		const fs  = new SdkFileAccess()
		const out = await fs.search( [ root ], 'match', token )

		expect( out.length ).toBe( SEARCH_YIELD_EVERY )
		expect( out.length ).toBeLessThan( total )
	} )

	it( 'returns [] immediately for a token that is ALREADY cancelled ( never starts a doomed walk )', async () => {
		const root = tmpDir()
		writeFileSync( join( root, 'match.txt' ), '' )

		const fs = new SdkFileAccess()
		expect( await fs.search( [ root ], 'match', { cancelled: true } ) ).toEqual( [] )
	} )

	it( 'truncates at SEARCH_MATCH_CAP and warns, without throwing', async () => {
		const root = tmpDir()
		const total = SEARCH_MATCH_CAP + 5
		for( let i = 0; i < total; i += 1 ) {
			writeFileSync( join( root, `match-${ String( i ).padStart( 5, '0' ) }.txt` ), '' )
		}

		const warnings: { event: string; detail: Record<string, unknown> }[] = []
		const fs = new SdkFileAccess( ( event, detail ) => warnings.push( { event, detail } ) )
		const out = await fs.search( [ root ], 'match' )

		expect( out.length ).toBe( SEARCH_MATCH_CAP )
		expect( warnings.some( ( w ) => w.event === 'search_truncated' ) ).toBe( true )
	} )

	it( 'returns [] for a blank query without touching disk', async () => {
		const root = tmpDir()
		writeFileSync( join( root, 'anything.txt' ), '' )

		const fs = new SdkFileAccess()
		expect( await fs.search( [ root ], '' ) ).toEqual( [] )
		expect( await fs.search( [ root ], '   ' ) ).toEqual( [] )
	} )
} )

// ── the ES ( voidtools Everything CLI ) fast path — see search-all-files.html Phase 5 ──────────
// The argv builder and CSV parser are pure and tested in EsCsv.test.ts; what is left here is spawn and fallback wiring.

describe( 'SdkFileAccess._esArgs', () => {
	it( 'omits -path for whole-computer scope ( empty roots )', () => {
		const args = SdkFileAccess._esArgs( [], 'query' )
		expect( args ).not.toContain( '-path' )
		expect( args[ args.length - 1 ] ).toBe( 'query' )   // the query text is always the last token
	} )

	it( 'includes -path <dir> for a single-folder scope', () => {
		const args = SdkFileAccess._esArgs( [ 'D:\\Projects' ], 'query' )
		const i = args.indexOf( '-path' )
		expect( i ).toBeGreaterThanOrEqual( 0 )
		expect( args[ i + 1 ] ).toBe( 'D:\\Projects' )
	} )

	it( 'requests -no-header ( positional parsing depends on it )', () => {
		expect( SdkFileAccess._esArgs( [], 'q' ) ).toContain( '-no-header' )
	} )
} )

describe( 'SdkFileAccess.search — ES fast path fallback', () => {

	it( 'falls back to the walk when esBin points at nothing ( never a hard dependency )', async () => {
		const root = tmpDir()
		writeFileSync( join( root, 'target-file.txt' ), '' )

		const fs  = new SdkFileAccess( undefined, join( root, 'does-not-exist.exe' ) )
		const out = await fs.search( [ root ], 'target' )

		expect( out.map( ( e ) => e.name ) ).toEqual( [ 'target-file.txt' ] )
	} )

	it( 'skips the fast path outright for a genuine multi-root call ( es -path takes one dir )', async () => {
		const rootA = tmpDir()
		const rootB = tmpDir()
		writeFileSync( join( rootA, 'alpha-match.txt' ), '' )
		writeFileSync( join( rootB, 'bravo-match.txt' ), '' )
		// Points esBin at something that would answer WRONG if it were ever actually invoked — proves
		// the >1-root guard short-circuits before any spawn attempt, not just that a spawn happened to fail.
		const fs  = new SdkFileAccess( undefined, join( rootA, 'unreachable.exe' ) )
		const out = await fs.search( [ rootA, rootB ], 'match' )

		expect( out.map( ( e ) => e.name ).sort() ).toEqual( [ 'alpha-match.txt', 'bravo-match.txt' ] )
	} )
} )

// ── the index is a MIRROR, and it lags in both directions ──────────────────────────────────────
// _esLive is the staleness policy, split off the spawn so it can be judged against real files.
// `null` means the index gave no usable answer, and search() falls through to the walk.

describe( 'SdkFileAccess._esLive', () => {

	/** One row shaped the way EsCsv.parse emits them; only `path` is read here. */
	function row( path: string ): FileEntry {
		return { name: basename( path ), path, isDir: false, size: 0, ext: 'txt', mtime: 0 }
	}

	it( 'drops a row the index still holds for a path that is gone', () => {
		const root = tmpDir()
		const here = join( root, 'still-here.txt' )
		writeFileSync( here, '' )

		const live = SdkFileAccess._esLive( [ row( here ), row( join( root, 'deleted.txt' ) ) ] )

		// A hit that cannot be opened is worse than no hit: the survivor is the one on disk.
		expect( live?.map( ( e ) => e.path ) ).toEqual( [ here ] )
	} )

	it( 'reads an EMPTY answer as no answer, so search walks rather than reporting absence', () => {
		// The folder made seconds ago that the index has not caught up with yet. Zero rows and "nothing
		// exists" are the same shape, and only the walk can tell them apart.
		expect( SdkFileAccess._esLive( [] ) ).toBeNull()
	} )

	it( 'reads an answer whose every row is gone as no answer too', () => {
		const root = tmpDir()
		expect( SdkFileAccess._esLive( [ row( join( root, 'a.txt' ) ), row( join( root, 'b.txt' ) ) ] ) ).toBeNull()
	} )

	it( 'trusts a non-empty answer — the index knew about this query', () => {
		const root = tmpDir()
		const a = join( root, 'a.txt' )
		const b = join( root, 'b.txt' )
		writeFileSync( a, '' )
		writeFileSync( b, '' )

		expect( SdkFileAccess._esLive( [ row( a ), row( b ) ] )?.map( ( e ) => e.path ) ).toEqual( [ a, b ] )
	} )
} )

/**
 * glob — the pattern walk, and the two ceilings it has to keep apart ( DEFECT-046 ).
 *
 * The reported symptom: `**\/Glob.ts` at a repository root answered "No match" for a file that was on disk,
 * while the identical pattern one level down returned it instantly. Two causes, and both are fixed here —
 * the walk spent its visit budget inside `node_modules` before reaching the file, and the result had no way
 * to SAY so, because it was a bare array and the one caller inferred its disclosure from the match count.
 *
 * An empty answer is exactly where that inference does the most damage: an agent is told the tree does not
 * hold the file, with no hint that the search stopped early, so the false conclusion is total rather than
 * partial. Every case below is about an empty or short answer carrying the reason it is short.
 */
describe( 'glob — a stopped walk is distinguishable from an exhausted one', () => {

	/** A tree with a noise directory that holds the only match, plus a real one, so pruning is observable.
	 *
	 *  THE `package.json` IS LOAD-BEARING ( DEFECT-2893 ). `dist` is one of the four generically-named directories
	 *  that mean machine output beside a project manifest and mean source anywhere else, so it is pruned only where
	 *  a manifest says this is a project root. Without the manifest this fixture would describe a tree nobody has,
	 *  and the prune it is asserting would not fire. */
	function planted(): string {
		const root = tmpDir()
		mkdirSync( join( root, 'src', 'core' ), { recursive: true } )
		mkdirSync( join( root, 'node_modules', 'dep' ), { recursive: true } )
		mkdirSync( join( root, 'dist' ), { recursive: true } )
		writeFileSync( join( root, 'package.json' ), '{}' )
		writeFileSync( join( root, 'src', 'core', 'Glob.ts' ), 'export const g = 1' )
		writeFileSync( join( root, 'node_modules', 'dep', 'Glob.ts' ), 'vendored' )
		writeFileSync( join( root, 'dist', 'Glob.ts' ), 'built' )
		return root
	}

	it( 'reports a FINISHED walk as finished, with nothing capped', () => {
		// The baseline the other cases are read against: `capped: false` has to keep meaning "this is all of them".
		const scan = new SdkFileAccess().glob( planted(), '**/Glob.ts' )

		expect( scan.cappedBy ).toBeNull()
		expect( scan.capped ).toBe( false )
		expect( scan.visited ).toBeGreaterThan( 0 )
	} )

	it( 'says `walk` when it ran out of visits, even though the list is EMPTY', () => {
		// THE DEFECT ITSELF. One visited entry is not enough to reach anything, so this returns nothing —
		// and the whole point is that it must not look like a tree with nothing in it.
		const scan = new SdkFileAccess().glob( planted(), '**/nothing-matches-this.xyz', { walkCap: 1 } )

		expect( scan.entries ).toHaveLength( 0 )
		expect( scan.cappedBy ).toBe( 'walk' )
		expect( scan.capped ).toBe( true )
	} )

	it( 'says `walk` on a NON-EMPTY list too — a short list is as misleading as an empty one', () => {
		const root = tmpDir()
		mkdirSync( join( root, 'a' ), { recursive: true } )
		for( const n of [ 'one', 'two', 'three', 'four', 'five', 'six' ] ) writeFileSync( join( root, 'a', `${ n }.ts` ), '' )

		const scan = new SdkFileAccess().glob( root, '**/*.ts', { walkCap: 3 } )

		expect( scan.cappedBy ).toBe( 'walk' )
		expect( scan.entries.length ).toBeLessThan( 6 )
	} )

	it( 'PRUNES noise directories, which is what let the root-level case fail at all', () => {
		// `grepText` already prunes these, and `Noise`'s own header says why: every walk is capped, so an
		// unpruned walk spends its cap inside `node_modules`. This walk was the one that never got the rule.
		const found = new SdkFileAccess().glob( planted(), '**/Glob.ts' ).entries.map( ( e ) => e.path.replace( /\\/g, '/' ) )

		expect( found.some( ( p ) => p.endsWith( 'src/core/Glob.ts' ) ) ).toBe( true )
		expect( found.some( ( p ) => p.includes( 'node_modules' ) ) ).toBe( false )
		expect( found.some( ( p ) => p.includes( '/dist/' ) ) ).toBe( false )
	} )

	it( 'HONOURS a pattern that names a pruned directory outright', () => {
		// Pruning must not become a new way to hide a file from somebody who asked for it by name — that would
		// be the same false absence this repair exists to remove, wearing different clothes.
		const found = new SdkFileAccess().glob( planted(), '**/node_modules/**/Glob.ts' ).entries

		expect( found ).toHaveLength( 1 )
		expect( found[ 0 ]!.path.replace( /\\/g, '/' ) ).toContain( 'node_modules/dep/Glob.ts' )
	} )

	it( 'lets a caller turn pruning off wholesale', () => {
		const found = new SdkFileAccess().glob( planted(), '**/Glob.ts', { skipNoise: false } ).entries

		expect( found ).toHaveLength( 3 )
	} )

	/**
	 * THE PRUNE IS NARROWED, AND IT REPORTS ITSELF ( DEFECT-2893 / BUG-229 / BUG-231 ).
	 *
	 * `build` sat on the prune list beside `node_modules`, so this repository's own `starmind/scripts/build` —
	 * tracked source holding the whole build pipeline — was dropped from every recursive walk in silence. The
	 * reported symptom: `grep` rooted at `scripts` answered "No match ... in 41 file( s )" for a string inside it,
	 * and this walk listed the `build` DIRECTORY and then none of its fifteen children while every sibling's
	 * children were listed.
	 *
	 * Two halves, and the second is the one that generalises: the four generic names are pruned only beside a
	 * project manifest, AND every prune is now named in the result, so a wrong one is visible rather than reading
	 * as absence. The heuristic can still be wrong; a silent prune cannot be caught at all.
	 */
	describe( 'glob — a generically-named directory is only output where a manifest says so', () => {

		/** `scripts/build` with no manifest above it — tracked source — beside a real `dist` at a project root. */
		function mixed(): string {
			const root = tmpDir()
			mkdirSync( join( root, 'scripts', 'build' ), { recursive: true } )
			mkdirSync( join( root, 'dist' ), { recursive: true } )
			writeFileSync( join( root, 'package.json' ), '{}' )
			writeFileSync( join( root, 'scripts', 'build', 'promote-mcp.ts' ), 'export const stampPlugin = 1' )
			writeFileSync( join( root, 'dist', 'promote-mcp.ts' ), 'built' )
			return root
		}

		it( 'walks `scripts/build`, which is the reported case', () => {
			const found = new SdkFileAccess().glob( mixed(), '**/*' ).entries.map( ( e ) => e.path.replace( /\\/g, '/' ) )

			// The children, not merely the directory — listing the folder and none of its contents is the symptom.
			expect( found.some( ( p ) => p.endsWith( 'scripts/build/promote-mcp.ts' ) ) ).toBe( true )
		} )

		it( 'still prunes a `dist` that sits beside a manifest', () => {
			// The narrowing must not become a licence to walk real build output: that is DEFECT-046's cost,
			// and Bryan ruled on 2026-10-22 that the pruning stays.
			const found = new SdkFileAccess().glob( mixed(), '**/*' ).entries.map( ( e ) => e.path.replace( /\\/g, '/' ) )

			expect( found.some( ( p ) => p.includes( '/dist/promote-mcp.ts' ) ) ).toBe( false )
		} )

		it( 'NAMES what it pruned, so a wrong prune cannot read as absence', () => {
			// The half that does not depend on the heuristic being right. A walk that skipped something and said
			// nothing is the whole severity of this defect; `pruned` is what makes the omission readable.
			const scan = new SdkFileAccess().glob( mixed(), '**/*' )

			expect( scan.prunedTotal ).toBe( 1 )
			expect( scan.pruned ).toEqual( [ 'dist' ] )
		} )

		it( 'reports NOTHING pruned when the walk was complete, so the claim means something', () => {
			// An empty `pruned` is the completeness claim. If it were filled on every answer it would say nothing.
			const root = tmpDir()
			mkdirSync( join( root, 'src' ), { recursive: true } )
			writeFileSync( join( root, 'src', 'a.ts' ), '' )

			const scan = new SdkFileAccess().glob( root, '**/*' )

			expect( scan.prunedTotal ).toBe( 0 )
			expect( scan.pruned ).toEqual( [] )
		} )

		it( 'does not count a directory the PATTERN asked for as pruned', () => {
			// It was walked, so saying it was skipped would be a false disclosure — the opposite error, and one
			// that trains a reader to ignore the sentence.
			const scan = new SdkFileAccess().glob( mixed(), '**/dist/**' )

			expect( scan.prunedTotal ).toBe( 0 )
		} )
	} )

	/**
	 * THE REPORTED REPRODUCTION, against the real repository tree ( DEFECT-046 ). The bug report's own words:
	 * `**\/Glob.ts` on the workspace root answered "No match", while the identical pattern rooted one level
	 * down returned the file instantly. This is that exact call.
	 *
	 * It walks real disk and the root is derived rather than written down — `cwd` is the sub-project, so its
	 * parent is the workspace. The file it looks for is this walker's own matcher, which cannot move without
	 * this file moving with it; if it ever does, fix the path rather than deleting the case, because this is
	 * the only test here that proves the symptom and not just the mechanism.
	 */
	it( 'finds a source file from the WORKSPACE ROOT, which is the call that reported this defect', () => {
		const workspace = resolve( process.cwd(), '..' )

		const scan  = new SdkFileAccess().glob( workspace, '**/Glob.ts' )
		const found = scan.entries.map( ( e ) => e.path.replace( /\\/g, '/' ) )

		expect( found.some( ( p ) => p.endsWith( 'kcd_sdk/src/core/Glob.ts' ) ) ).toBe( true )
		// And it got there without exhausting itself, which is the half that makes the answer trustworthy:
		// a found file plus a capped walk would still mean "there may be more I never reached".
		expect( scan.cappedBy ).toBeNull()
	} )
} )

/**
 * grepText — the same prune, the same narrowing, the same disclosure ( DEFECT-2893 / BUG-231 ).
 *
 * This is the walk the defect was REPORTED against: `grep` rooted at `starmind/scripts` answered
 * "No match for stampPlugin ... in 41 file( s )" while the same search one directory down, on
 * `scripts/build/promote-mcp.ts`, answered three matches. Nothing in that sentence was false except the
 * completeness it implied, and a count of 41 searched files is what made it read as thorough.
 *
 * Both tools share one prune list, so both get both halves: `build` is source unless a manifest says
 * otherwise, and whatever is pruned is named in the result.
 */
describe( 'grepText — a pruned directory is narrowed, and never silent', () => {

	/** The reported shape: tracked source under `scripts/build`, real output under a manifest's `dist`. */
	function mixed(): string {
		const root = tmpDir()
		mkdirSync( join( root, 'scripts', 'build' ), { recursive: true } )
		mkdirSync( join( root, 'dist' ), { recursive: true } )
		writeFileSync( join( root, 'package.json' ), '{}' )
		writeFileSync( join( root, 'scripts', 'build', 'promote-mcp.ts' ), 'export const stampPlugin = 1' )
		writeFileSync( join( root, 'dist', 'bundle.ts' ), 'const stampPlugin = 1' )
		return root
	}

	it( 'finds a string in `scripts/build` from the PARENT root, which is the reported call', async () => {
		const root = mixed()

		const scan = await new SdkFileAccess().grepText( join( root, 'scripts' ), 'stampPlugin' )

		expect( scan.rows.length ).toBeGreaterThan( 0 )
		expect( scan.rows[ 0 ]!.path.replace( /\\/g, '/' ) ).toContain( 'scripts/build/promote-mcp.ts' )
	} )

	it( 'still refuses to open a `dist` that sits beside a manifest', async () => {
		const scan = await new SdkFileAccess().grepText( mixed(), 'stampPlugin' )

		expect( scan.rows.some( ( r ) => r.path.replace( /\\/g, '/' ).includes( '/dist/' ) ) ).toBe( false )
	} )

	it( 'NAMES the pruned directory, so "no match in N files" can never imply a whole-tree search', async () => {
		// The half that holds whatever the heuristic gets wrong. A count of searched files reads as thorough,
		// and it was the sentence an agent acted on.
		const scan = await new SdkFileAccess().grepText( mixed(), 'nothing-is-here' )

		expect( scan.rows ).toHaveLength( 0 )
		expect( scan.prunedTotal ).toBe( 1 )
		expect( scan.pruned ).toEqual( [ 'dist' ] )
	} )

	it( 'reports nothing pruned when the walk was complete', async () => {
		const scan = await new SdkFileAccess().grepText( join( mixed(), 'scripts' ), 'stampPlugin' )

		expect( scan.prunedTotal ).toBe( 0 )
		expect( scan.pruned ).toEqual( [] )
	} )

	it( 'does NOT name a protected directory it refused, which the noise list is free to disclose', async () => {
		// The one asymmetry: the blacklist exists to conceal a path, so naming it would confirm it is there.
		// Noise conceals nothing, which is exactly why it can be reported.
		const root = tmpDir()
		mkdirSync( join( root, 'private' ), { recursive: true } )
		writeFileSync( join( root, 'private', 'keys.md' ), 'stampPlugin' )

		const scan = await new SdkFileAccess().grepText( root, 'stampPlugin', { deny: [ '**/private/**' ] } )

		expect( scan.rows ).toHaveLength( 0 )
		expect( scan.prunedTotal ).toBe( 0 )
	} )

	it( 'reports no prune for a FILE root, which enters no directory at all', async () => {
		const root = mixed()

		const scan = await new SdkFileAccess().grepText( join( root, 'scripts', 'build', 'promote-mcp.ts' ), 'stampPlugin' )

		expect( scan.rootIsFile ).toBe( true )
		expect( scan.prunedTotal ).toBe( 0 )
	} )
} )

/**
 * grepText — THE WALK'S OWN CLOCK ( DEFECT-2904 ).
 *
 * The reported symptom was an absence of output: `grep { path: "starmind/src", query: "Files.glob" }` died with
 * "MCP server sm_file tool grep sent no response or progress for 30s; aborting", and the identical call succeeded
 * on retry. Every ceiling in this walk bounded a PAYLOAD — rows, per-file rows, bytes, visited entries — and none
 * bounded TIME, so the only thing that ended a slow walk was a wall outside it: a caller's routed budget or the
 * transport's idle timeout. Both kill the call, so the one case that produced no partial list at all was the one
 * case with no ceiling inside the walk to name it.
 *
 * TIME IS FAKED, NOT WAITED FOR. `Date.now` is stubbed to jump, so the deadline fires at a chosen checkpoint and
 * the test is deterministic and instant. Sleeping twenty seconds to prove a branch would be the slowest test in
 * the repository, and a real clock would make which checkpoint fired a race.
 */
describe( 'grepText — a walk that runs out of time stops and says so', () => {

	afterEach( () => vi.restoreAllMocks() )

	/** One directory, several matching files, so the walk has somewhere to be interrupted part-way. */
	function many(): string {
		const root = tmpDir()
		for( const n of [ 'one', 'two', 'three', 'four', 'five', 'six' ] ) {
			writeFileSync( join( root, `${ n }.md` ), 'NEEDLE here\n' )
		}
		return root
	}

	/** `Date.now` jumping far past the deadline from its Nth call on. Call 1 is the walk computing its own
	 *  deadline, so `after: 1` trips the first checkpoint and a larger number lets real work happen first. */
	function clockJumpsAfter( calls: number ): void {
		let seen = 0
		vi.spyOn( Date, 'now' ).mockImplementation( () => {
			seen += 1
			return 1_000_000 + ( seen > calls ? 10_000_000 : 0 )
		} )
	}

	it( 'reports `cappedBy: time` rather than returning nothing at all', async () => {
		// THE DEFECT ITSELF, in the one assertion that matters: there IS a result, and it names the cause.
		// Before this the caller held an abort with no output and no reason.
		const root = many()
		clockJumpsAfter( 1 )

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE' )

		expect( scan.cappedBy ).toBe( 'time' )
		expect( scan.capped ).toBe( true )
		// Not a cancel: a cancel is nobody's ceiling and leaves `cappedBy` null, so the two must not merge.
		expect( scan.cancelled ).toBe( false )
	} )

	it( 'keeps the rows it had already collected — a partial answer, not a discarded one', async () => {
		// The whole value of an internal deadline over an external wall. A wall outside the walk throws the
		// work away; this hands it back and labels it.
		const root = many()
		clockJumpsAfter( 3 )

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE' )

		expect( scan.cappedBy ).toBe( 'time' )
		expect( scan.rows.length ).toBeGreaterThan( 0 )
		expect( scan.searched ).toBeGreaterThan( 0 )
		// And it stopped: a walk that got through all six was not interrupted and proves nothing here.
		expect( scan.searched ).toBeLessThan( 6 )
	} )

	it( 'leaves `cappedBy` null when the walk finished inside its deadline', async () => {
		// So `time` means something when it appears. The default is twenty seconds and this tree is six small
		// files, which makes this the one case here that uses the real clock — deliberately, since the
		// assertion is that the clock does NOT fire.
		const scan = await new SdkFileAccess().grepText( many(), 'NEEDLE' )

		expect( scan.cappedBy ).toBeNull()
		expect( scan.capped ).toBe( false )
		expect( scan.searched ).toBe( 6 )
	} )

	it( 'honours a deadline the CALLER sets, which is how a caller stays inside its own wall', async () => {
		// The parameter exists for exactly one reason: whoever holds a wall knows where the rung below it goes.
		const root  = many()
		let   given = 0
		vi.spyOn( Date, 'now' ).mockImplementation( () => {
			given += 1
			return 1_000_000 + ( given > 1 ? 3_000 : 0 )
		} )

		// Three seconds elapse at the first checkpoint: inside the default of twenty, outside a caller-set one.
		const tight = await new SdkFileAccess().grepText( root, 'NEEDLE', { deadlineMs: 1_000 } )

		expect( tight.cappedBy ).toBe( 'time' )
	} )

	it( 'turns the clock OFF at `deadlineMs: 0`, for a caller that has a wall of its own', async () => {
		const root = many()
		clockJumpsAfter( 1 )

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE', { deadlineMs: 0 } )

		// The jump is enormous and nothing stops: with no clock, elapsed time is not a fact the walk reads.
		expect( scan.cappedBy ).toBeNull()
		expect( scan.searched ).toBe( 6 )
	} )

	it( 'does not fold the time stop into the WALK-ENTRY cap, which takes a different remedy', async () => {
		// `walk` says the tree is too large and a deeper root fixes it; `time` says the walk was too slow, which
		// a narrower `glob` also fixes. One word for both would send a caller at the wrong one.
		const root = many()
		clockJumpsAfter( 1 )

		const scan = await new SdkFileAccess().grepText( root, 'NEEDLE' )

		expect( scan.cappedBy ).not.toBe( 'walk' )
		expect( scan.cappedBy ).toBe( 'time' )
	} )
} )



