import { describe, it, expect } from 'vitest'
import { Command, commandWords, type CommandPart } from '../Command'

/**
 * Command — what makes one AUTHORED rather than a shell, asserted at the unit.
 *
 * WHY THIS FILE EXISTS. `Command` is the security boundary of the whole authored-command capability — the
 * class that decides what an agent can run and what it may fill in — and it had no test of its own. Its
 * behaviour was covered only indirectly, through `CommandService.run`, which reaches it after a roster
 * lookup and a readiness check. That is the wrong distance for a rule like "the program is not the agent's
 * to choose": a predicate can be wrong there and still produce a plausible outcome one layer up.
 *
 * It was wrong, and that is how this file came to be written. `no_fixed_part` tested `some( literal )` while
 * its message said "the agent would choose the program itself", so `«tool» --version` passed validation and
 * handed argv[0] to its caller. Nothing failed, because nothing asked.
 *
 * ── THE MODEL IT NOW PINS ── ( Bryan, 2026-09-27 )
 * Two kinds of part, and one asymmetry between them that everything else rests on:
 *
 *   literal     the author's fixed text. SPLITS on whitespace, so `npm run typecheck` is one part and three
 *               arguments. Never validated — a person typed it, which is the whole trust model.
 *   file_path   a hole the agent fills. Exactly ONE argv element however many spaces it contains, and
 *               validated by what a path may be.
 *
 * There is deliberately no free-text type. There was one — the old `in` kind, any string behind a blacklist
 * of shell metacharacters — and it is gone because a blacklist is a claim that every dangerous spelling was
 * thought of. An agent-authored value is admissible only where "correct" has a definition somebody can write
 * down, and a path has one.
 *
 * PURE. No disk, no spawn, no roster — `argv()` builds an array and `inspect()` reads strings. What happens
 * to that array is `CommandService`'s subject and is tested there against real children.
 */

/** A literal part, which is most of what these cases are made of. */
function fixed( text: string ): CommandPart {
	return { kind: 'literal', text };
}

describe( 'the program is the AUTHOR\'S, never the caller\'s', () => {

	it( 'REFUSES a command whose first part is a hole', () => {
		// The case the old predicate let through: a fixed part exists, so `some( literal )` was satisfied —
		// and the thing it was fixing was the FLAG, not the program.
		const c = new Command( 'probe', 'x', [
			{ kind: 'file_path', name: 'tool' },
			fixed( '--version' )
		] );

		expect( c.getErrors() ).toContain( Command.NO_FIXED_PART );
		expect( c.ready ).toBe( false );
	} );

	it( 'REFUSES a first literal that is EMPTY, which would let a hole become argv[0]', () => {
		/*
		 * THE HOLE THE LITERAL SPLIT OPENED, closed in the same change.
		 *
		 * Once a literal splits on whitespace it can contribute ZERO argv elements. So being a literal stopped
		 * being sufficient: `[ { literal: '' }, { file_path } ]` is a first part that IS fixed text and still
		 * builds an argv whose first element came from the agent — the exact thing `no_fixed_part` exists to
		 * prevent, reachable through a blank field.
		 */
		const empty = new Command( 'probe', 'x', [ fixed( '' ), { kind: 'file_path', name: 'tool' } ] );
		const blank = new Command( 'probe', 'x', [ fixed( '   ' ), { kind: 'file_path', name: 'tool' } ] );

		expect( empty.getErrors() ).toContain( Command.NO_FIXED_PART );
		expect( blank.getErrors() ).toContain( Command.NO_FIXED_PART );
	} );

	it( 'still refuses a command with NO fixed part anywhere — the case the old rule did catch', () => {
		// The correction is strictly stronger, so nothing it used to catch may have stopped being caught.
		const c = new Command( 'probe', 'x', [ { kind: 'file_path', name: 'everything' } ] );

		expect( c.getErrors() ).toContain( Command.NO_FIXED_PART );
	} );

	it( 'ACCEPTS a fixed program followed by holes, which is the ordinary shape', () => {
		const c = new Command( 'check', 'Run after an edit.', [
			fixed( 'node --check' ),
			{ kind: 'file_path', name: 'file' }
		] );

		expect( c.getErrors() ).not.toContain( Command.NO_FIXED_PART );
		expect( c.ready ).toBe( true );
	} );

	it( 'says nothing about a command with no parts at all — that is `no_command`', () => {
		// Two faults about one field must stay distinct: an empty command is unwritten, and a command whose
		// program is a hole is written wrongly. Reporting the first as the second would send an author
		// looking for a slot that is not there.
		const c = new Command( 'probe', 'x', [] );

		expect( c.getErrors() ).toContain( Command.NO_COMMAND );
		expect( c.getErrors() ).not.toContain( Command.NO_FIXED_PART );
	} );

	it( 'is READY with a typed hole and no hint anywhere, which it could never be before', () => {
		/*
		 * THE DEFECT THE TYPE SYSTEM CLOSED, pinned so it cannot come back.
		 *
		 * `undescribed_input` was a BLOCKING code raised by any input slot whose `hint` was empty — and no
		 * surface in the app ever had a control for `hint`. `CommandStrip` created slots with `hint: ''` and
		 * only ever rendered the value in a tooltip. So every command with a hole was permanently unready,
		 * `commandsInPlay` filtered it out, and no agent was ever offered a parameterised command at all.
		 *
		 * The type is what a hint was for, and a type cannot be left blank.
		 */
		const c = new Command( 'open', 'Open a file.', [ fixed( 'code' ), { kind: 'file_path', name: 'file' } ] );

		expect( c.ready ).toBe( true );
		expect( c.manifest() ).toContain( 'file — a file path' );
	} );
} );

describe( 'a literal splits, and an agent\'s value never does', () => {

	it( 'SPLITS a literal on whitespace, which is what makes `npm run typecheck` authorable', () => {
		/*
		 * THE BUG THIS FIXES, in one line. A literal used to be one argv element, so a person typing the
		 * command line they know into one field produced argv[0] = "npm run typecheck" — and the resolver went
		 * looking for a program with spaces in its name and reported "not on this machine's PATH". A true
		 * sentence about a question nobody asked.
		 */
		const c = new Command( 'typecheck', 'Run after an edit.', [ fixed( 'npm run typecheck' ) ] );

		expect( c.argv( [] ) ).toEqual( [ 'npm', 'run', 'typecheck' ] );
		expect( c.ready ).toBe( true );
	} );

	it( 'collapses runs of whitespace rather than emitting empty arguments', () => {
		expect( commandWords( '  npm   run \t typecheck  ' ) ).toEqual( [ 'npm', 'run', 'typecheck' ] );
	} );

	it( 'HOLDS A QUOTED RUN TOGETHER, for the fixed argument that has a space in it', () => {
		// `C:\Program Files\…` is the commonest argv[0] on Windows. Without quoting, splitting would make the
		// program unexpressible — which is the one real cost of the split and the reason for the tokenizer.
		const c = new Command( 'probe', 'x', [ fixed( String.raw`"C:\Program Files\node\node.exe" --version` ) ] );

		expect( c.argv( [] ) ).toEqual( [ String.raw`C:\Program Files\node\node.exe`, '--version' ] );
	} );

	it( 'joins a quoted run to the token it touches', () => {
		expect( commandWords( '--msg="a b" next' ) ).toEqual( [ '--msg=a b', 'next' ] );
	} );

	it( 'keeps an explicitly EMPTY quoted argument, which is not the same as no argument', () => {
		// A program that receives '' behaves differently from one that receives nothing, so an author who
		// wrote `""` meant it.
		expect( commandWords( 'tool "" end' ) ).toEqual( [ 'tool', '', 'end' ] );
	} );

	it( 'NEVER splits a filled value, however many spaces it has — the security half of the asymmetry', () => {
		/*
		 * THE PROPERTY THE WHOLE SPLIT RESTS ON. If an agent's value split the way a literal does, a hole
		 * authored to hold a filename would be a way to append arguments — `--config evil` through a path
		 * slot. It stays ONE element whatever it contains, and `shell: false` is what makes that sufficient.
		 */
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'file' } ] );

		expect( c.argv( [ String.raw`C:\My Docs\a b c.txt` ] ) )
			.toEqual( [ 'node', String.raw`C:\My Docs\a b c.txt` ] );
	} );

	it( 'does not let a quote in a filled value open a quoted run', () => {
		// A value is never tokenized, so the tokenizer's rules cannot be reached from the agent's side at all.
		// The quotes here are stripped by the path type's normalizer, which is a different mechanism.
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'file' } ] );

		expect( c.argv( [ String.raw`"C:\a b.txt"` ] ) ).toEqual( [ 'node', String.raw`C:\a b.txt` ] );
	} );
} );

describe( 'the name has one spelling', () => {

	it( 'LOWER-CASES AND TRIMS, whatever was typed', () => {
		expect( new Command( '  TypeCheck  ', 'x', [ fixed( 'npm' ) ] ).name ).toBe( 'typecheck' );
		expect( Command.normalizeName( ' LINT ' ) ).toBe( 'lint' );
	} );

	it( 'canonicalizes on the way BACK from storage too', () => {
		// `fromSerialized` routes through the constructor, so a roster written before this rule reads back
		// canonical with no migration — which is the whole reason the rule lives in the model rather than in
		// whichever surface happened to author the command.
		const c = Command.fromSerialized( { name: 'MixedCase', intent: 'x', parts: [ { kind: 'literal', text: 'npm' } ] } );

		expect( c.name ).toBe( 'mixedcase' );
		expect( c.serialize().name ).toBe( 'mixedcase' );
	} );

	it( 'still reports a name of nothing but spaces as missing', () => {
		// Trimming must not turn an empty name into a saved one. `no_name` is what the editor's section flags.
		expect( new Command( '   ', 'x', [ fixed( 'npm' ) ] ).getErrors() ).toContain( Command.NO_NAME );
	} );
} );

describe( 'argvShape — what the author is shown', () => {

	it( 'AGREES WITH argv on a command that has no holes', () => {
		/*
		 * THE PROPERTY THAT MAKES IT WORTH DRAWING. The editor shows this so an author can SEE that one literal
		 * became several arguments — `node -e process.stdout.write( 1 )` is five, not one. A view that split
		 * differently from the thing that runs would be worse than no view: it would be a check that passes
		 * while the command is wrong. Same `commandWords`, asserted rather than assumed.
		 */
		const c = new Command( 'probe', 'x', [ fixed( 'npm run typecheck' ), fixed( '--silent' ) ] );

		expect( c.argvShape().map( ( a ) => a.text ) ).toEqual( c.argv( [] ) );
		expect( c.argvShape().every( ( a ) => !a.hole ) ).toBe( true );
	} );

	it( 'marks a hole rather than inventing a value for it', () => {
		const c = new Command( 'probe', 'x', [ fixed( 'node --check' ), { kind: 'file_path', name: 'file' } ] );

		expect( c.argvShape() ).toEqual( [
			{ text: 'node',    hole: false },
			{ text: '--check', hole: false },
			{ text: 'file',    hole: true  }
		] );
	} );

	it( 'shows a quoted literal as the ONE argument it will be', () => {
		// The case the whole view exists for, from the other direction: quoting is invisible in the strip, and
		// this is where an author confirms it did what they meant.
		const c = new Command( 'probe', 'x', [ fixed( String.raw`"C:\Program Files\node\node.exe" --version` ) ] );

		expect( c.argvShape().map( ( a ) => a.text ) )
			.toEqual( [ String.raw`C:\Program Files\node\node.exe`, '--version' ] );
	} );
} );

describe( 'file_path — the type the blanket rule made impossible', () => {

	const withPath = new Command( 'probe', 'x', [
		fixed( 'node' ),
		{ kind: 'file_path', name: 'file' }
	] );

	it( 'ACCEPTS a real Windows path with brackets in it', () => {
		/*
		 * THE WHOLE REASON TYPES EXIST. `C:\Program Files (x86)\…` is the single commonest path on a Windows
		 * machine and the blanket shell-character rule refused it for its parentheses. Nothing was ever unsafe
		 * about it: parts are an argv handed to `spawn` with no shell, so a bracket is an ordinary letter
		 * inside one argument.
		 */
		expect( withPath.inspect( [ String.raw`C:\Program Files (x86)\node\node.exe` ] ) ).toEqual( [] );
	} );

	it( 'accepts the other characters a filename may legally carry', () => {
		for( const path of [
			String.raw`C:\reports\report (final).pdf`,
			String.raw`C:\tmp\100%_draft.txt`,
			String.raw`C:\tmp\a&b\c$d.txt`,
			String.raw`C:\tmp\caret^name.txt`,
			'relative/path/to/file.ts',
			String.raw`\\server\share\file.txt`
		] ) {
			expect( withPath.inspect( [ path ] ), path ).toEqual( [] );
		}
	} );

	it( 'STRIPS ONE LAYER OF QUOTES, because that is how a path with a space is written everywhere', () => {
		// A model hands a path back the way it has seen one written, and a quoted path is the right answer in
		// a normal spelling. Refusing it teaches an agent nothing it can act on.
		expect( withPath.inspect( [ String.raw`"C:\My Docs\a.txt"` ] ) ).toEqual( [] );
		expect( withPath.filled( [ String.raw`"C:\My Docs\a.txt"` ] ) ).toEqual( [ String.raw`C:\My Docs\a.txt` ] );
	} );

	it( 'COLLAPSES doubled separators, because that is how a path arrives through JSON', () => {
		expect( withPath.filled( [ String.raw`C:\\Users\\bryan\\f.txt` ] ) ).toEqual( [ String.raw`C:\Users\bryan\f.txt` ] );
	} );

	it( 'KEEPS a UNC prefix, which really is two backslashes and not a doubled one', () => {
		// Collapsing it would turn `\\server\share` into `\server\share` — a different and non-existent place.
		expect( withPath.filled( [ String.raw`\\server\share\f.txt` ] ) ).toEqual( [ String.raw`\\server\share\f.txt` ] );
	} );

	it( 'refuses a wildcard, which is a set of paths rather than a path', () => {
		expect( withPath.inspect( [ '*.ts' ] ).map( ( f ) => f.code ) ).toEqual( [ 'not_a_file_path' ] );
	} );

	it( 'refuses the characters Windows itself forbids in a filename', () => {
		for( const path of [ 'a|b', 'a<b', 'a>b', 'a?b' ] ) {
			expect( withPath.inspect( [ path ] ).map( ( f ) => f.code ), path ).toContain( 'not_a_file_path' );
		}
	} );

	it( 'refuses a shell pipeline handed to a path slot, because it is not a path', () => {
		// The old blanket rule caught this as `shell_character`. It is still caught, by the narrower rule that
		// replaced it — `|` is not legal in a filename — which is the point: the narrower rule did not weaken
		// the defence for anything an agent would actually try.
		expect( withPath.inspect( [ 'a.txt | whoami' ] ).map( ( f ) => f.code ) ).toEqual( [ 'not_a_file_path' ] );
	} );

	it( 'refuses a colon anywhere but a drive', () => {
		expect( withPath.inspect( [ String.raw`C:\ok\file.txt` ] ) ).toEqual( [] );
		expect( withPath.inspect( [ 'a:b' ] ).map( ( f ) => f.code ) ).toEqual( [ 'not_a_file_path' ] );
	} );

	it( 'refuses a `..` SEGMENT, and allows the two characters inside a name', () => {
		// By segment, never by substring: a file honestly named `..bashrc` climbs nowhere, and only a whole
		// segment does. This stops a path climbing out of where it starts; it does NOT decide where it may
		// start, which is a further rule this type does not yet carry.
		expect( withPath.inspect( [ String.raw`..\..\etc\passwd` ] ).map( ( f ) => f.code ) ).toEqual( [ 'not_a_file_path' ] );
		expect( withPath.inspect( [ String.raw`C:\home\..bashrc` ] ) ).toEqual( [] );
		expect( withPath.inspect( [ 'a..b.txt' ] ) ).toEqual( [] );
	} );

	it( 'still refuses a flag-like path and a control character — a type narrows, it never widens', () => {
		expect( withPath.inspect( [ '-rf' ] ).map( ( f ) => f.code ) ).toEqual( [ 'flag_like' ] );
		expect( withPath.inspect( [ 'a\nb' ] ).map( ( f ) => f.code ) ).toContain( 'control_character' );
	} );

	it( 'reports EVERY fault at once rather than the first', () => {
		const c = new Command( 'probe', 'x', [
			fixed( 'node' ),
			{ kind: 'file_path', name: 'a' },
			{ kind: 'file_path', name: 'b' }
		] );

		// The gate emits a single verdict, so an agent told one fault per round trip flails once per fault.
		expect( c.inspect( [ '-rf', 'a|b' ] ).map( ( f ) => f.code ) ).toEqual( [ 'flag_like', 'not_a_file_path' ] );
	} );

	it( 'treats an OPTIONAL hole as satisfied by nothing, and a required one as not', () => {
		const optional = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f', optional: true } ] );
		const required = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f' } ] );

		expect( optional.inspect( [ '' ] ) ).toEqual( [] );
		expect( required.inspect( [ '' ] ).map( ( f ) => f.code ) ).toEqual( [ 'missing_value' ] );
	} );
} );

describe( 'argv', () => {

	it( 'THE VERTICAL SLICE — a fixed program, a fixed flag, and one typed argument', () => {
		// `node --check <file>` is the slice that proves the machinery end to end without depending on a shim
		// being unwrapped: `node` is a real executable, the literal carries two arguments, and the agent fills
		// exactly one hole.
		const c = new Command( 'check_file', 'Syntax-check a JS file.', [
			fixed( 'node --check' ),
			{ kind: 'file_path', name: 'file' }
		] );

		expect( c.ready ).toBe( true );
		expect( c.argv( [ 'src/index.js' ] ) ).toEqual( [ 'node', '--check', 'src/index.js' ] );
	} );

	it( 'RUNS THE NORMALIZED VALUE, not the one that was sent', () => {
		/*
		 * THE VALIDATE-THEN-MUTATE HOLE, closed and pinned.
		 *
		 * Normalization and validation must see the same string, and so must argv. If `inspect` judged a raw
		 * value while `argv` pushed a cleaned one — or the reverse — the string that was checked would not be
		 * the string that runs, which is how a check gets passed by a value that never faced it. One door:
		 * `Command.filled`.
		 */
		const c = new Command( 'probe', 'x', [ fixed( 'code' ), { kind: 'file_path', name: 'file' } ] );

		expect( c.argv( [ String.raw`"C:\My Docs\a.txt"` ] ) ).toEqual( [ 'code', String.raw`C:\My Docs\a.txt` ] );
	} );

	it( 'DROPS an omitted optional rather than passing an empty argument', () => {
		// An empty string in an argv is a real argument, and a program that receives one behaves differently
		// from one that receives nothing.
		const c = new Command( 'probe', 'x', [
			fixed( 'node' ),
			{ kind: 'file_path', name: 'f', optional: true },
			fixed( 'end' )
		] );

		expect( c.argv( [ '' ] ) ).toEqual( [ 'node', 'end' ] );
	} );

	it( 'THROWS when reached with an uninspected fault, rather than building a line nobody vetted', () => {
		// An assertion, not a gate: getting here with a bad value means the checkpoint was bypassed, and the
		// right behaviour is to fail loudly instead of assembling a command line.
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f' } ] );

		expect( () => c.argv( [ 'a|b' ] ) ).toThrow( /uninspected/i );
	} );
} );

/**
 * INTENT IS OPTIONAL ( Bryan, 2026-09-28 ) — "Agents don't need context to know when to type check."
 *
 * Two halves, and the second is the one that bites. Making the fault advisory is easy; the manifest was
 * printing a WARNING STRING in the intent's place, which was harmless only while an intent-less command
 * was filtered out before any model saw it. It is not filtered out any more.
 */
describe( 'a command with no intent', () => {

	const bare = (): Command => new Command( 'typecheck', '', [ { kind: 'literal', text: 'npm run typecheck' } ] );

	it( 'is REMARKED ON but not pinned — the fault is raised, and it does not block', () => {
		const c = bare();

		expect( c.getErrors() ).toContain( Command.NO_INTENT );
		expect( c.fetchCode( Command.NO_INTENT ).blocking ).toBe( false );
		// `ready` is what the manifest filters on and what `CommandService.run` refuses on.
		expect( c.ready ).toBe( true );
	} );

	it( 'NEVER PUTS A WARNING WHERE A PERSON\'S JUDGEMENT GOES', () => {
		// The one slot in an agent's tool description reserved for a person's sentence. A defect report
		// delivered into it reads as guidance, which is the whole reason this case exists.
		const text = bare().manifest();

		expect( text ).not.toContain( '⚠' );
		expect( text ).not.toMatch( /draft/i );
		expect( text ).not.toMatch( /intent/i );
		// Silence, not a neutral stand-in: the name, then straight to what it runs.
		expect( text.split( '\n' )[ 0 ] ).toBe( 'typecheck' );
		expect( text ).toContain( 'Runs: npm run typecheck' );
	} );

	it( 'still prints an authored intent, in the same place', () => {
		const c = new Command( 'typecheck', 'Run after an edit.', [ { kind: 'literal', text: 'npm run typecheck' } ] );

		expect( c.manifest().split( '\n' ).slice( 0, 2 ) ).toEqual( [ 'typecheck', 'Run after an edit.' ] );
		expect( c.getErrors() ).not.toContain( Command.NO_INTENT );
	} );
} );

describe( 'a part authored as a kind that no longer exists', () => {

	it( 'LOADS, BLOCKS, AND SAYS SO rather than crashing or guessing', () => {
		/*
		 * `choice` — the old `pick` kind — and `input` — the old free text — were both retired. A roster
		 * written before that may hold either. Three ways to handle it: crash, guess, or say so.
		 *
		 * Guessing is the dangerous one. Turning a menu into whichever option happened to be first would
		 * silently change what a PRIVILEGED command runs, and the new line would never have been reviewed by
		 * the person whose approval the whole design rests on.
		 */
		const c = Command.fromSerialized( {
			name:   'legacy',
			intent: 'Something authored before the type system.',
			parts:  [
				{ kind: 'literal', text: 'node' },
				// A shape the union no longer has — which is the entire point of the case.
				{ kind: 'choice', name: 'mode', options: [ 'a', 'b' ] } as unknown as CommandPart
			]
		} );

		expect( c.getErrors() ).toContain( Command.RETIRED_PART );
		expect( c.ready ).toBe( false );
		// It names what it WAS, so a person knows what to put back.
		expect( c.describe() ).toContain( 'choice' );
	} );

	it( 'retires the old FREE TEXT kind too, rather than quietly widening it into a path', () => {
		// `input` accepted any string behind a blacklist. Reading one back as a `file_path` would narrow it
		// silently — a stored command would start refusing values it used to accept, with no record of why.
		const c = Command.fromSerialized( {
			name:   'legacy',
			intent: 'x',
			parts:  [
				{ kind: 'literal', text: 'node' },
				{ kind: 'input', name: 'word', hint: 'anything' } as unknown as CommandPart
			]
		} );

		expect( c.getErrors() ).toContain( Command.RETIRED_PART );
		expect( c.describe() ).toContain( 'input' );
	} );

	it( 'leaves an ordinary command untouched on the way through', () => {
		const json = {
			name:   'typecheck',
			intent: 'Run after an edit.',
			parts:  [ { kind: 'literal' as const, text: 'npm run typecheck' } ]
		};

		expect( Command.fromSerialized( json ).serialize() ).toEqual( json );
		expect( Command.fromSerialized( json ).ready ).toBe( true );
	} );
} );
