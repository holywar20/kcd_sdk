import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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
