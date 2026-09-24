import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SdkFileAccess, SEARCH_MATCH_CAP, SEARCH_YIELD_EVERY, type SearchToken } from '../SdkFileAccess'

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
 * A FILE IS A ROOT. The walk used to be the only shape: `readdirSync` on a file throws ENOTDIR, the
 * throw was swallowed as an unreadable directory, and the scan came back with zero candidates — which
 * every caller above reads as "this root holds nothing searchable" and reports as a bad path.
 * `rootIsFile` is what lets them tell the two apart.
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
		// Queued BEFORE the search call — setImmediate callbacks fire in registration order, so this
		// flips the token before the walk's OWN first yield point ( SEARCH_YIELD_EVERY entries in )
		// checks it. Deterministic: the walk always processes exactly one batch, never more.
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
// The argv builder and the CSV parser (EsCsv, tested separately in EsCsv.test.ts) are both pure —
// no process spawn, no fs — specifically so the logic that matters most (arg shape, quoted-CSV
// parsing) is testable without depending on a real es.exe or a live Everything instance. What's
// left to verify HERE is the spawn/fallback wiring itself, which a real (failing) spawn attempt
// exercises perfectly well without needing a working fake binary.

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
