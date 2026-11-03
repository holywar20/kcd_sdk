import { describe, it, expect } from 'vitest'
import { Command, RUNNABLE_KINDS, type CommandPart, type SerializedCommand } from '../Command'

/**
 * TWO RUNNABLE KINDS, ONE PARTS MACHINERY ( TASK-144, plan 77 phase 6 ).
 *
 * `Command.validation.test.ts` is the fence proving argv's behaviour did not move, and NOT ONE ASSERTION IN IT
 * WAS EDITED for this card. Everything new lives here. If a case below ever needs that file changed to pass,
 * something has been taken from commands to pay for queries and the trade should be refused.
 *
 * ── WHAT ACTUALLY FORKED, AND IT IS LESS THAN THE CARD EXPECTED ──
 * Plan 77 names two argv-only rules — the shell-metacharacter blacklist and `flag_like` — and says the first
 * is "actively wrong" for a SQL binding because it would refuse `O'Brien` for ever. That is sound reasoning
 * about a rule that NO LONGER EXISTS: the blacklist was removed from `Command.inspectPart` when the typed part
 * kinds landed, because it refused real Windows paths like `C:\Program Files (x86)`, and the fence file pins
 * the removal under the heading "the type the blanket rule made impossible". So an apostrophe is ALREADY
 * accepted on an argv text hole and there was nothing left to fork there.
 *
 * The apostrophe case below is written anyway and both directions are asserted, because the card is right that
 * a one-sided test hides either failure — it simply records the true answer on the argv side rather than the
 * expected one, and says so where somebody reading the plan will look. `flag_like` is the whole of the real
 * fork, and it gets the two-sided treatment the apostrophe was meant to get.
 */

const fixed = ( text: string ): CommandPart => ( { kind: 'literal', text } )

/** A text hole, the kind a value binding uses. 200 is an ordinary cap and not near the hard ceiling. */
const freeText = ( name = 'v', maxLength = 200 ): CommandPart =>
	( { kind: 'text', name, maxLength } )

/** One runnable of each kind over the SAME parts, which is what makes every comparison below honest: any
 *  difference in the answers is the kind and cannot be anything else.
 *
 *  THE SQL ONE CARRIES A CONNECTION HANDLE and the argv one cannot — that is the one asymmetry here, and it
 *  is forced rather than chosen ( TASK-145 ): a statement naming no database is `no_connection`, which is
 *  blocking, so a `sql` fixture without one is never `ready` and every readiness comparison below would be
 *  measuring the missing handle instead of the thing it meant to measure. */
function pair( parts: CommandPart[] ): { argv: Command; sql: Command } {
	return {
		argv: new Command( 'c', 'x', parts, null, 'allow', 'id-a', 'c', '⚡', '', true, 'argv' ),
		sql:  new Command( 'c', 'x', parts, null, 'allow', 'id-s', 'c', '⚡', '', true, 'sql', 'local-db' )
	}
}

const codes = ( c: Command, values: string[] ): string[] => c.inspect( values ).map( f => f.code )

// ── 1 · THE APOSTROPHE ─────────────────────────────────────────────────

describe( 'an apostrophe in a value', () => {

	it( 'is ACCEPTED as a sql binding — O\'Brien is a name, and a validator refusing it refuses real data', () => {
		const { sql } = pair( [ fixed( 'SELECT * FROM people WHERE name =' ), freeText( 'name' ) ] )

		// THE EXIT CONDITION THE CARD NAMES. Binding puts the value on a rail of its own, so there is no
		// syntax for a quote to close and nothing for an escape to protect against.
		expect( sql.inspect( [ 'O\'Brien' ] ) ).toEqual( [] )
	} )

	it( 'is ALSO accepted on an argv text hole, which is the plan\'s premise being out of date', () => {
		const { argv } = pair( [ fixed( 'git' ), freeText( 'message' ) ] )

		// READ THIS BEFORE "FIXING" IT. The card asks for this to be a REFUSAL, on the strength of a
		// metacharacter blacklist in `Command.inspectPart`. There is no such blacklist — it was removed when
		// the typed part kinds landed, because it refused `C:\Program Files (x86)` for its parentheses, and
		// `Command.validation.test.ts` pins that removal deliberately.
		//
		// So this assertion records the TRUE answer rather than the expected one, and it is pinned rather
		// than omitted: a future reader meeting plan 77's guidance will come looking for the fork here, and
		// an absent case would leave them to rediscover this by writing the failing test themselves. Adding
		// the blacklist back to satisfy the card would break the fence file, which is exactly the trade the
		// card forbids.
		expect( argv.inspect( [ 'O\'Brien' ] ) ).toEqual( [] )
	} )

	it( 'is refused by neither kind for the CHARACTER, and by both where the hole is wrong for it', () => {
		// The honest shared half: an apostrophe is not what makes a value bad. A hole that cannot hold the
		// value refuses it for its own reason, identically on both kinds.
		const { argv, sql } = pair( [ fixed( 'x' ), { kind: 'int', name: 'n', min: 0, max: 10 } ] )
		expect( codes( argv, [ 'O\'Brien' ] ) ).toEqual( [ 'not_an_integer' ] )
		expect( codes( sql,  [ 'O\'Brien' ] ) ).toEqual( [ 'not_an_integer' ] )
	} )
} )

// ── 2 · THE LEADING DASH — the real fork ───────────────────────────────

describe( 'a value beginning with a dash', () => {

	it( 'is a NEGATIVE NUMBER to sql and a FLAG to argv — accepted by one, refused by the other', () => {
		const { argv, sql } = pair( [ fixed( 'x' ), freeText( 'v' ) ] )

		// ONE ASSERTION, BOTH DIRECTIONS, and this is the fork that genuinely exists. Accepting it everywhere
		// deletes argv's only real injection guard; refusing it everywhere makes a balance, a delta and a
		// temperature unrepresentable in an authored query for ever. Either failure passes a one-sided test.
		expect( sql.inspect( [ '-5' ] ) ).toEqual( [] )
		expect( codes( argv, [ '-5' ] ) ).toEqual( [ 'flag_like' ] )

		// The flag shapes that are the actual threat, refused on argv and meaningless to a binding.
		expect( codes( argv, [ '--config=/etc/passwd' ] ) ).toEqual( [ 'flag_like' ] )
		expect( sql.inspect( [ '--config=/etc/passwd' ] ) ).toEqual( [] )
	} )

	it( 'is decided by the KIND\'S OWN ROW rather than by a branch somebody can simplify away', () => {
		// The rule is a declared row, so the test reads it from the same place the validator does. A branch
		// inside the validator would have nothing to assert over and would read as an exception.
		expect( RUNNABLE_KINDS.argv.flagLike ).toBe( true )
		expect( RUNNABLE_KINDS.sql.flagLike ).toBe( false )
	} )
} )

// ── 3 · THE SHARED RULES STAYED SHARED ─────────────────────────────────

describe( 'what neither kind may switch off', () => {

	it( 'refuses a control character for BOTH, because it is a transport fault in both worlds', () => {
		const { argv, sql } = pair( [ fixed( 'x' ), freeText( 'v' ) ] )

		// A newline truncates an argv element at the npm shims; a NUL truncates a string into a driver.
		for( const bad of [ 'a\nb', 'a\u0000b', 'a\tb' ] ) {
			expect( codes( argv, [ bad ] ), `argv ${ JSON.stringify( bad ) }` ).toContain( 'control_character' )
			expect( codes( sql,  [ bad ] ), `sql ${ JSON.stringify( bad ) }` ).toContain( 'control_character' )
		}
	} )

	it( 'refuses an over-length value for BOTH, at the hole\'s own cap and at the hard ceiling', () => {
		const { argv, sql } = pair( [ fixed( 'x' ), freeText( 'v', 10 ) ] )
		expect( codes( argv, [ 'x'.repeat( 11 ) ] ) ).toEqual( [ 'over_length' ] )
		expect( codes( sql,  [ 'x'.repeat( 11 ) ] ) ).toEqual( [ 'over_length' ] )

		const big = pair( [ fixed( 'x' ), freeText( 'v', 512 ) ] )
		expect( codes( big.argv, [ 'x'.repeat( 600 ) ] ) ).toEqual( [ 'too_long' ] )
		expect( codes( big.sql,  [ 'x'.repeat( 600 ) ] ) ).toEqual( [ 'too_long' ] )
	} )

	it( 'refuses a non-member choice for BOTH — membership is the whole of what a menu checks', () => {
		const { argv, sql } = pair( [
			fixed( 'x' ), { kind: 'enum', name: 'col', options: [ 'name', 'email' ] }
		] )
		expect( codes( argv, [ 'password' ] ) ).toEqual( [ 'not_an_option' ] )
		expect( codes( sql,  [ 'password' ] ) ).toEqual( [ 'not_an_option' ] )
		expect( argv.inspect( [ 'name' ] ) ).toEqual( [] )
		expect( sql.inspect( [ 'name' ] ) ).toEqual( [] )
	} )

	it( 'refuses a pattern failure and a missing value for BOTH', () => {
		const { argv, sql } = pair( [
			fixed( 'x' ), { kind: 'int', name: 'n', min: 1, max: 10 }
		] )
		// THE CODE IS THE TYPE'S, NOT THE DETAIL'S — an `int` reports every failure of its own under
		// `not_an_integer` and puts what was wrong in `detail`. Measured here rather than assumed; the first
		// version of this case expected `out_of_range`, which is in the fault union and which the `int` row
		// never actually emits. Both kinds answer identically, which is what this case is about.
		expect( codes( argv, [ '99' ] ) ).toEqual( [ 'not_an_integer' ] )
		expect( codes( sql,  [ '99' ] ) ).toEqual( [ 'not_an_integer' ] )
		expect( argv.inspect( [ '99' ] )[ 0 ].detail ).toBe( sql.inspect( [ '99' ] )[ 0 ].detail )
		expect( sql.inspect( [ '99' ] )[ 0 ].detail ).toContain( '1..10' )
		expect( codes( argv, [ '' ] ) ).toEqual( [ 'missing_value' ] )
		expect( codes( sql,  [ '' ] ) ).toEqual( [ 'missing_value' ] )
	} )
} )

// ── 4 · AN IDENTIFIER COMES FROM A MENU ────────────────────────────────

describe( 'a hole that names a table or a column', () => {

	const sqlWith = ( part: CommandPart ): Command =>
		new Command( 'q', 'x', [ fixed( 'SELECT * FROM' ), part ], null, 'allow', 'i', 'q', '⚡', '', true, 'sql', 'local-db' )

	it( 'is REFUSED when authored as a free hole, with a message naming the reason', () => {
		const c = sqlWith( { kind: 'text', name: 'table', maxLength: 60, identifier: true } )

		expect( c.getErrors() ).toContain( Command.IDENTIFIER_NOT_A_CHOICE )
		expect( c.ready ).toBe( false )

		// THE MESSAGE HAS TO SAY WHY, because the author's instinct is that a cap and a pattern make a free
		// hole safe — and for a VALUE they do. The reason this one is different is that no engine binds an
		// identifier at all, so the hole would be concatenated into the statement text.
		const message = c.fetchCode( Command.IDENTIFIER_NOT_A_CHOICE ).message
        expect( message ).toMatch( /binds an identifier/i )
		expect( message ).toMatch( /concatenation/i )
		expect( message ).toMatch( /choice/i )
	} )

	it( 'is ACCEPTED as a closed choice, which is the only shape that can be safe', () => {
		const c = sqlWith( { kind: 'enum', name: 'table', options: [ 'orders', 'people' ], identifier: true } )

		expect( c.getErrors() ).not.toContain( Command.IDENTIFIER_NOT_A_CHOICE )
		expect( c.ready ).toBe( true )
		// And it is still checked for membership and nothing else, exactly as any other menu is.
		expect( c.inspect( [ 'orders' ] ) ).toEqual( [] )
		expect( codes( c, [ 'payroll' ] ) ).toEqual( [ 'not_an_option' ] )
	} )

	it( 'is refused as an int or a path hole too — every free kind, not just text', () => {
		for( const part of [
			{ kind: 'int',  name: 't', min: 0, max: 9, identifier: true },
			{ kind: 'file_path', name: 't', access: 'read', identifier: true }
		] as CommandPart[] ) {
			expect( sqlWith( part ).getErrors(), part.kind ).toContain( Command.IDENTIFIER_NOT_A_CHOICE )
		}
	} )

	it( 'survives a round trip, so the declaration is not lost on save', () => {
		const c = sqlWith( { kind: 'enum', name: 'table', options: [ 'orders' ], identifier: true } )
		const back = Command.fromSerialized( c.serialize() )
		expect( back.parts[ 1 ] ).toMatchObject( { kind: 'enum', identifier: true } )
	} )

	it( 'writes NO key when it is not set, so no existing part gains a field', () => {
		const c = sqlWith( { kind: 'enum', name: 'table', options: [ 'orders' ] } )
		expect( 'identifier' in ( c.serialize().parts[ 1 ] as object ) ).toBe( false )
	} )
} )

// ── 5 · THE FIRST PART IS THE AUTHOR'S, FOR A QUERY TOO ────────────────

describe( 'a sql runnable whose statement does not begin with fixed text', () => {

	it( 'is REFUSED by the same rule that refuses a fillable program', () => {
		const c = new Command( 'q', 'x', [
			{ kind: 'text', name: 'everything', maxLength: 400 }
		], null, 'allow', 'i', 'q', '⚡', '', true, 'sql' )

		// THE SAME CODE, because it is the same rule: the opening of the thing is the author's. A query whose
		// first part is fillable is free SQL with extra steps, and it is exactly as bad as a command whose
		// program is a hole.
		expect( c.getErrors() ).toContain( Command.NO_FIXED_PART )
		expect( c.ready ).toBe( false )
	} )

	it( 'says so in words a query\'s author can act on, rather than words about a program', () => {
		const sql  = new Command( 'q', 'x', [ { kind: 'text', name: 'v', maxLength: 10 } ], null, 'allow', 'i', 'q', '⚡', '', true, 'sql' )
		const argv = new Command( 'c', 'x', [ { kind: 'text', name: 'v', maxLength: 10 } ] )

		// ONE CODE, TWO WORDINGS. "The agent would choose what runs" tells a query's author nothing — there
		// is no program to choose — so the sentence names the verb and the tables instead.
		const sqlMessage = sql.fetchCode( Command.NO_FIXED_PART ).message
		expect( sqlMessage ).toMatch( /statement/i )
		expect( sqlMessage ).toMatch( /free SQL/i )
		expect( argv.fetchCode( Command.NO_FIXED_PART ).message ).toMatch( /program/i )
		expect( argv.fetchCode( Command.NO_FIXED_PART ).message ).not.toMatch( /SQL/i )
	} )

	it( 'accepts one that opens with the verb and the tables', () => {
		const c = new Command( 'q', 'x', [
			fixed( 'SELECT name FROM people WHERE id =' ),
			{ kind: 'int', name: 'id', min: 1, max: 999999 }
		], null, 'allow', 'i', 'q', '⚡', '', true, 'sql', 'local-db' )

		expect( c.ready ).toBe( true )
		expect( c.inspect( [ '42' ] ) ).toEqual( [] )
	} )
} )

// ── 6 · EVERY EXISTING COMMAND IS UNTOUCHED ────────────────────────────

describe( 'a record authored before this field existed', () => {

	/** A roster row exactly as one is stored today — no `kind` anywhere on it. */
	const stored: SerializedCommand = {
		name:    'typecheck',
		intent:  'Test Test Test',
		parts:   [ { kind: 'literal', text: 'npm run typecheck' } ],
		id:      'kept-id',
		label:   'typecheck',
		icon:    '⚡',
		folder:  '',
		enabled: true
	}

	it( 'reads as `argv` with no migration and no rewrite', () => {
		const c = Command.fromSerialized( stored )
		expect( c.kind ).toBe( 'argv' )
		expect( c.ready ).toBe( true )
	} )

	it( 'ROUND-TRIPS TO THE IDENTICAL BYTES — no roster gains a key', () => {
		// THE ASSERTION BEHIND "untouched". If `serialize` wrote `kind: 'argv'`, every roster in every project
		// would be rewritten the first time anything saved one, which is a migration by another name.
		const back = Command.fromSerialized( stored ).serialize()
		expect( 'kind' in back ).toBe( false )
		expect( JSON.stringify( back ) ).toBe( JSON.stringify( stored ) )
	} )

	it( 'keeps argv\'s flag guard, which the fork must not have cost it', () => {
		const c = Command.fromSerialized( {
			...stored,
			parts: [ { kind: 'literal', text: 'npm' }, { kind: 'text', name: 'v', maxLength: 50 } ]
		} )
		expect( codes( c, [ '-rf' ] ) ).toEqual( [ 'flag_like' ] )
	} )

	it( 'defaults to argv when constructed with no kind at all', () => {
		// Every existing construction site in the app passes no kind, so this is what all of them mean.
		expect( new Command( 'c', 'x', [ fixed( 'node' ) ] ).kind ).toBe( 'argv' )
	} )

	it( 'reads a kind nobody declared as `argv` rather than as a kind nothing can run', () => {
		const c = Command.fromSerialized( { ...stored, kind: 'bash' as unknown as 'argv' } )
		expect( c.kind ).toBe( 'argv' )
	} )

	it( 'writes `kind` for a sql record, so the fork survives storage', () => {
		const c = new Command( 'q', 'x', [ fixed( 'SELECT 1' ) ], null, 'allow', 'i', 'q', '⚡', '', true, 'sql' )
		expect( c.serialize().kind ).toBe( 'sql' )
		expect( Command.fromSerialized( c.serialize() ).kind ).toBe( 'sql' )
	} )

	/**
	 * THE AUTHORED WORKING DIRECTORY ( TASK-200 ) — the same storage contract as `kind` and `connection`
	 * above, which is why it is asserted here beside them rather than in a file of its own.
	 *
	 * The field answers "where does this command usually run", which before it could only ever be the
	 * project root: the person's door accepts no directory from its caller by ruling, so a button had
	 * nothing to carry one in. Nothing here judges the path — this class holds no filesystem and no reach,
	 * and the runner's own door is the only thing that admits one.
	 */
	it( 'ROUND-TRIPS the authored directory, so it is not lost on save', () => {
		const c = new Command(
			'typecheck', 'x', [ fixed( 'npm run typecheck' ) ],
			null, 'allow', 'i', 'typecheck', '⚡', '', true, 'argv', '', 'C:\\starmind_root\\starmind'
		)
		expect( c.serialize().directory ).toBe( 'C:\\starmind_root\\starmind' )
		expect( Command.fromSerialized( c.serialize() ).directory ).toBe( 'C:\\starmind_root\\starmind' )
	} )

	it( 'writes NO `directory` key when it is not set, so no existing roster gains one', () => {
		// The same assertion `kind` has above, and it is the whole of what "every existing command
		// untouched" means at the storage layer: a roster rewritten on first save is a migration.
		const back = Command.fromSerialized( stored ).serialize()
		expect( 'directory' in back ).toBe( false )
		expect( JSON.stringify( back ) ).toBe( JSON.stringify( stored ) )
	} )

	it( 'reads a stored directory that is not a string as ABSENT, which is the project root', () => {
		// Absent is a real answer here and the old behaviour, so a malformed one fails toward it rather
		// than becoming a path nothing resolves. The runner refuses a bad one it was actually given.
		const c = Command.fromSerialized( { ...stored, directory: 42 as unknown as string } )
		expect( c.directory ).toBe( '' )
	} )

	it( 'keeps the directory out of the command line, which is the point of it being a field', () => {
		const c = new Command(
			'typecheck', 'x', [ fixed( 'npm run typecheck' ) ],
			null, 'allow', 'i', 'typecheck', '⚡', '', true, 'argv', '', 'C:\\starmind_root\\starmind'
		)
		// A directory folded into argv would be a fourth word in the command a person approved.
		expect( c.argv( [] ) ).toEqual( [ 'npm', 'run', 'typecheck' ] )
	} )
} )

// ── 7 · WHAT THE AGENT IS HANDED ───────────────────────────────────────

describe( 'the manifest', () => {

	it( 'calls a query a query rather than something that runs', () => {
		const sql = new Command( 'people', 'Find a person', [
			fixed( 'SELECT name FROM people WHERE name =' ), freeText( 'name' )
		], null, 'allow', 'i', 'people', '⚡', '', true, 'sql' )

		expect( sql.manifest() ).toContain( 'Query:' )
		expect( sql.manifest() ).not.toContain( 'Runs:' )
		// The holes are described by their type exactly as a command's are — one machinery, one manifest.
		expect( sql.manifest() ).toContain( 'name — free text, at most 200 characters' )
	} )

	it( 'still says Runs for a command line', () => {
		expect( new Command( 'c', 'x', [ fixed( 'node' ) ] ).manifest() ).toContain( 'Runs:' )
	} )
} )
