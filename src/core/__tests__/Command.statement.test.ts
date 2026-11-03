import { describe, it, expect } from 'vitest'
import { Command, SQL_FILL_KINDS, fillKindsFor, type CommandPart } from '../Command'

/**
 * A SQL TEMPLATE'S CONNECTION, ITS COMPILED STATEMENT, AND THE TWO RAILS ( TASK-145, plan 77 phase 6 ).
 *
 * `Command.runnableKind.test.ts` is the previous step's file and `Command.validation.test.ts` is the argv
 * fence; NEITHER HAS AN ASSERTION EDITED HERE. The only change made to the first was a FIXTURE — its `sql`
 * commands now carry a connection handle, because a statement naming no database is blocking and a fixture
 * without one would have measured the missing handle rather than the thing each case meant to measure.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ──
 * `statement()` is where the two rails diverge for real. A value hole leaves the statement text entirely and
 * arrives as a binding; an identifier hole is SPLICED INTO the text, which is string concatenation and is
 * admissible only because two refusals have already run — `getErrors` refuses an identifier that is not a
 * closed choice, and `inspect` refuses a value that is not a member of that choice. Those two refusals are
 * load-bearing in a way no comment can enforce, so each is asserted here from the outside.
 */

const fixed = ( text: string ): CommandPart => ( { kind: 'literal', text } )

/** A statement naming its connection, which is the only shape that is ever `ready`. */
function query( parts: CommandPart[], connection = 'local-db' ): Command {
	return new Command( 'q', 'why', parts, null, 'allow', 'id-q', 'Q', '⚡', '', true, 'sql', connection )
}

// ── 1 · A TEMPLATE BOUND TO NO DATABASE IS MEANINGLESS ─────────────────

describe( 'a sql template\'s connection', () => {

	it( 'is REQUIRED, and a statement naming none is blocked rather than defaulted', () => {
		const c = query( [ fixed( 'SELECT 1' ) ], '' )

		expect( c.getErrors() ).toContain( Command.NO_CONNECTION )
		expect( c.ready ).toBe( false )
		// THE FAULT LANDS ON ITS OWN CONTROL, not on `parts`. A surface keys the red ring off this field, and
		// pointing a missing connection at the statement would paint the one thing that is not wrong.
		expect( c.fetchCode( Command.NO_CONNECTION ).field ).toBe( 'connection' )
	} )

	it( 'is never asked of a command line — an argv record carries none and must stay ready', () => {
		const c = new Command( 'typecheck', 'why', [ fixed( 'npm run typecheck' ) ] )

		expect( c.connection ).toBe( '' )
		expect( c.getErrors() ).not.toContain( Command.NO_CONNECTION )
		expect( c.ready ).toBe( true )
	} )

	it( 'is written to storage ONLY when set, so no existing roster gains a key', () => {
		const argv = new Command( 'typecheck', 'why', [ fixed( 'npm run typecheck' ) ] )
		expect( 'connection' in argv.serialize() ).toBe( false )

		expect( query( [ fixed( 'SELECT 1' ) ] ).serialize().connection ).toBe( 'local-db' )
	} )

	it( 'survives a round trip, and a malformed stored value reads as absent rather than as a handle', () => {
		const back = Command.fromSerialized( query( [ fixed( 'SELECT 1' ) ] ).serialize() )
		expect( back.connection ).toBe( 'local-db' )
		expect( back.kind ).toBe( 'sql' )

		// NOT COERCED. `String( 7 )` would be a handle that resolves to nothing, and the resulting refusal
		// would name a connection the author never typed.
		const junk = Command.fromSerialized( {
			name: 'q', parts: [ fixed( 'SELECT 1' ) ], kind: 'sql', connection: 7 as unknown as string
		} )
		expect( junk.connection ).toBe( '' )
		expect( junk.getErrors() ).toContain( Command.NO_CONNECTION )
	} )

	it( 'is stated in the manifest an agent reads, because it is a handle and leaks nothing', () => {
		const text = query( [ fixed( 'SELECT 1' ) ] ).manifest()
		expect( text ).toContain( 'local-db' )
		// And a command line says nothing of the kind.
		expect( new Command( 'c', 'w', [ fixed( 'npm' ) ] ).manifest() ).not.toMatch( /connection/i )
	} )
} )

// ── 2 · THE TWO RAILS ──────────────────────────────────────────────────

describe( 'statement()', () => {

	const template = (): Command => query( [
		fixed( 'SELECT name FROM ' ),
		{ kind: 'enum', name: 'tbl', options: [ 'people', 'orders' ], identifier: true },
		fixed( ' WHERE name = ' ),
		{ kind: 'text', name: 'who', maxLength: 60 }
	] )

	it( 'puts a VALUE on the binding rail and an IDENTIFIER into the text — the whole design, in one call', () => {
		const { sql, bindings } = template().statement( [ 'orders', 'O\'Brien' ] )

		// The chosen table name IS in the statement; the chosen value is NOT, anywhere.
		expect( sql ).toBe( 'SELECT name FROM orders WHERE name = :who' )
		expect( sql ).not.toContain( 'O\'Brien' )
		expect( bindings ).toEqual( { who: 'O\'Brien' } )
	} )

	it( 'emits `:name`, never a dialect — `$1` and `?` belong to the executor, which knows the engine', () => {
		const { sql } = template().statement( [ 'people', 'x' ] )
		expect( sql ).not.toMatch( /\$\d/ )
		expect( sql ).not.toContain( '?' )
	} )

	it( 'CONCATENATES the author\'s parts and inserts no spacing of its own', () => {
		// No space anywhere in the authored text: the author's spacing is the statement's spacing, and a
		// joiner here would silently rewrite real SQL.
		const c = query( [ fixed( 'SELECT' ), fixed( ' 1' ) ] )
		expect( c.statement( [] ).sql ).toBe( 'SELECT 1' )
	} )

	it( 'THROWS on an identifier that is not a member of the author\'s list — the refusal the splice rests on', () => {
		// `payroll` is a perfectly ordinary word and is not on the menu, so it never reaches the text.
		expect( () => template().statement( [ 'payroll', 'x' ] ) ).toThrow( /not_an_option/ )
	} )

	it( 'THROWS on an argv runnable, and argv() throws on a sql one — no path from either to the other', () => {
		const line = new Command( 'c', 'w', [ fixed( 'npm run typecheck' ) ] )

		// STRUCTURAL, not conventional. Nothing can run a statement through `spawn`, because the only thing
		// that builds an argument vector refuses to build one for a query.
		expect( () => line.statement( [] ) ).toThrow( /statement\(\) reached on an argv runnable/ )
		expect( () => template().argv( [ 'people', 'x' ] ) ).toThrow( /argv\(\) reached on a sql runnable/ )
	} )
} )

// ── 3 · THE SHAPE A SURFACE DRAWS ──────────────────────────────────────

describe( 'statementShape()', () => {

	it( 'reports an identifier hole as a THIRD state, distinct from a value hole and from fixed text', () => {
		const shape = query( [
			fixed( 'SELECT * FROM ' ),
			{ kind: 'enum', name: 'tbl', options: [ 'people' ], identifier: true },
			fixed( ' LIMIT ' ),
			{ kind: 'int', name: 'n', min: 1, max: 100 }
		] ).statementShape()

		expect( shape ).toEqual( [
			{ text: 'SELECT * FROM ', hole: false, identifier: false },
			{ text: 'tbl',            hole: true,  identifier: true  },
			{ text: ' LIMIT ',        hole: false, identifier: false },
			{ text: ':n',             hole: true,  identifier: false }
		] )
	} )

	it( 'does NOT split a fixed part into words, which is the one way it differs from argvShape', () => {
		// `commandWords` exists because a literal handed to `spawn` becomes as many arguments as it has
		// words. A statement is one string, and drawing five tokens here would state a fact that is false
		// of the thing being authored.
		const parts = [ fixed( 'SELECT type FROM sqlite_master' ) ]
		expect( query( parts ).statementShape() ).toHaveLength( 1 )
		expect( new Command( 'c', 'w', parts ).argvShape() ).toHaveLength( 4 )
	} )
} )

// ── 4 · WHICH HOLE TYPES A STATEMENT MAY DECLARE ───────────────────────

describe( 'the hole types offered for each kind', () => {

	it( 'offers a statement NO path kind, because a query reaches no filesystem', () => {
		expect( SQL_FILL_KINDS ).toEqual( [ 'enum', 'int', 'text' ] )
		for( const k of SQL_FILL_KINDS ) expect( k ).not.toMatch( /path/ )
	} )

	it( 'leaves a command line\'s own list alone — commands did not pay for queries', () => {
		expect( fillKindsFor( 'argv' ) ).toEqual( [ 'file_path', 'folder_path', 'res_path', 'enum', 'int', 'text' ] )
		expect( fillKindsFor( 'sql' ) ).toBe( SQL_FILL_KINDS )
	} )
} )
