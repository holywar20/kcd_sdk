import { describe, it, expect } from 'vitest'
import { Command, commandWords, type CommandPart } from '../Command'

/**
 * Command — what makes one AUTHORED rather than a shell. The program is the author's, never the caller's.
 *
 * Two kinds of part: `literal` (the author's fixed text, split on whitespace, never validated) and `file_path`
 * (a hole the agent fills: exactly ONE argv element, validated as a path). There is no free-text type, because
 * a blacklist of shell metacharacters is a claim that every dangerous spelling was thought of.
 *
 * PURE. No disk, no spawn, no roster.
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
			{ kind: 'file_path', name: 'tool', access: 'read' },
			fixed( '--version' )
		] );

		expect( c.getErrors() ).toContain( Command.NO_FIXED_PART );
		expect( c.ready ).toBe( false );
	} );

	it( 'REFUSES a first literal that is EMPTY, which would let a hole become argv[0]', () => {
		// A literal that splits to zero words adds no argv element, so a blank first literal is not a fixed program.
		const empty = new Command( 'probe', 'x', [ fixed( '' ), { kind: 'file_path', name: 'tool', access: 'read' } ] );
		const blank = new Command( 'probe', 'x', [ fixed( '   ' ), { kind: 'file_path', name: 'tool', access: 'read' } ] );

		expect( empty.getErrors() ).toContain( Command.NO_FIXED_PART );
		expect( blank.getErrors() ).toContain( Command.NO_FIXED_PART );
	} );

	it( 'still refuses a command with NO fixed part anywhere — the case the old rule did catch', () => {
		// The correction is strictly stronger, so nothing it used to catch may have stopped being caught.
		const c = new Command( 'probe', 'x', [ { kind: 'file_path', name: 'everything', access: 'read' } ] );

		expect( c.getErrors() ).toContain( Command.NO_FIXED_PART );
	} );

	it( 'ACCEPTS a fixed program followed by holes, which is the ordinary shape', () => {
		const c = new Command( 'check', 'Run after an edit.', [
			fixed( 'node --check' ),
			{ kind: 'file_path', name: 'file', access: 'read' }
		] );

		expect( c.getErrors() ).not.toContain( Command.NO_FIXED_PART );
		expect( c.ready ).toBe( true );
	} );

	it( 'says nothing about a command with no parts at all — that is `no_command`', () => {
		// Two faults must stay distinct: an empty command is unwritten; a hole as the program is written wrongly.
		// Conflating them would send an author looking for a slot that is not there.
		const c = new Command( 'probe', 'x', [] );

		expect( c.getErrors() ).toContain( Command.NO_COMMAND );
		expect( c.getErrors() ).not.toContain( Command.NO_FIXED_PART );
	} );

	it( 'is READY with a typed hole and no hint anywhere, which it could never be before', () => {
		// A hole's type is its description: a blank hint once left every parameterised command permanently unready.
		const c = new Command( 'open', 'Open a file.', [ fixed( 'code' ), { kind: 'file_path', name: 'file', access: 'read' } ] );

		expect( c.ready ).toBe( true );
		expect( c.manifest() ).toContain( 'file — a file path' );
	} );
} );

describe( 'a literal splits, and an agent\'s value never does', () => {

	it( 'SPLITS a literal on whitespace, which is what makes `npm run typecheck` authorable', () => {
		// A literal splits on whitespace, so `npm run typecheck` is three argv words, not one program with spaces in its name.
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
		// A filled value must never split: a path slot that split would let an agent append arguments (`--config evil`).
		// It stays one element, and `shell: false` is what makes that sufficient.
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'file', access: 'read' } ] );

		expect( c.argv( [ String.raw`C:\My Docs\a b c.txt` ] ) )
			.toEqual( [ 'node', String.raw`C:\My Docs\a b c.txt` ] );
	} );

	it( 'does not let a quote in a filled value open a quoted run', () => {
		// A value is never tokenized, so the tokenizer's rules cannot be reached from the agent's side at all.
		// The quotes here are stripped by the path type's normalizer, which is a different mechanism.
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'file', access: 'read' } ] );

		expect( c.argv( [ String.raw`"C:\a b.txt"` ] ) ).toEqual( [ 'node', String.raw`C:\a b.txt` ] );
	} );
} );

describe( 'the name has one spelling', () => {

	it( 'LOWER-CASES AND TRIMS, whatever was typed', () => {
		expect( new Command( '  TypeCheck  ', 'x', [ fixed( 'npm' ) ] ).name ).toBe( 'typecheck' );
		expect( Command.normalizeName( ' LINT ' ) ).toBe( 'lint' );
	} );

	it( 'canonicalizes on the way BACK from storage too', () => {
		// `fromSerialized` routes through the constructor, so rosters written before this rule read back canonical.
		// The rule lives in the model, not in whichever surface authored the command.
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
		// The editor shows this so an author can see one literal became several arguments. It must split exactly as
		// argv does, or the check passes while the command is wrong.
		const c = new Command( 'probe', 'x', [ fixed( 'npm run typecheck' ), fixed( '--silent' ) ] );

		expect( c.argvShape().map( ( a ) => a.text ) ).toEqual( c.argv( [] ) );
		expect( c.argvShape().every( ( a ) => !a.hole ) ).toBe( true );
	} );

	it( 'marks a hole rather than inventing a value for it', () => {
		const c = new Command( 'probe', 'x', [ fixed( 'node --check' ), { kind: 'file_path', name: 'file', access: 'read' } ] );

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
		{ kind: 'file_path', name: 'file', access: 'read' }
	] );

	it( 'ACCEPTS a real Windows path with brackets in it', () => {
		// The blanket shell-character rule refused real Windows paths such as `Program Files (x86)` for their parentheses.
		// Nothing is unsafe about them: parts are spawned with no shell, so a bracket is an ordinary letter in one argument.
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
		// `|` is not legal in a filename, so the narrower rule that replaced the blanket one still refuses it.
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
			{ kind: 'file_path', name: 'a', access: 'read' },
			{ kind: 'file_path', name: 'b', access: 'read' }
		] );

		// The gate emits a single verdict, so an agent told one fault per round trip flails once per fault.
		expect( c.inspect( [ '-rf', 'a|b' ] ).map( ( f ) => f.code ) ).toEqual( [ 'flag_like', 'not_a_file_path' ] );
	} );

	it( 'treats an OPTIONAL hole as satisfied by nothing, and a required one as not', () => {
		const optional = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f', access: 'read', optional: true } ] );
		const required = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f', access: 'read' } ] );

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
			{ kind: 'file_path', name: 'file', access: 'read' }
		] );

		expect( c.ready ).toBe( true );
		expect( c.argv( [ 'src/index.js' ] ) ).toEqual( [ 'node', '--check', 'src/index.js' ] );
	} );

	it( 'RUNS THE NORMALIZED VALUE, not the one that was sent', () => {
		// Normalization and argv must see the same string; a checked value that differs from the run value never faced the check.
		const c = new Command( 'probe', 'x', [ fixed( 'code' ), { kind: 'file_path', name: 'file', access: 'read' } ] );

		expect( c.argv( [ String.raw`"C:\My Docs\a.txt"` ] ) ).toEqual( [ 'code', String.raw`C:\My Docs\a.txt` ] );
	} );

	it( 'DROPS an omitted optional rather than passing an empty argument', () => {
		// An empty string in an argv is a real argument, and a program that receives one behaves differently
		// from one that receives nothing.
		const c = new Command( 'probe', 'x', [
			fixed( 'node' ),
			{ kind: 'file_path', name: 'f', access: 'read', optional: true },
			fixed( 'end' )
		] );

		expect( c.argv( [ '' ] ) ).toEqual( [ 'node', 'end' ] );
	} );

	it( 'THROWS when reached with an uninspected fault, rather than building a line nobody vetted', () => {
		// An assertion, not a gate: getting here with a bad value means the checkpoint was bypassed, and the
		// right behaviour is to fail loudly instead of assembling a command line.
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f', access: 'read' } ] );

		expect( () => c.argv( [ 'a|b' ] ) ).toThrow( /uninspected/i );
	} );
} );

/**
 * INTENT IS OPTIONAL — "Agents don't need context to know when to type check." An intent-less command is
 * advisory, and the manifest must never print a warning string in the intent's place.
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
		// The slot in an agent's tool description reserved for a person's sentence; a defect report there reads as guidance.
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
		// Guessing a retired kind would silently change what a privileged command runs, so it must block and say so.
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

/**
 * A path hole declares its access level on the part, and nothing defaults: the declaration cannot be forgotten.
 * A stored part that predates the field must come back visibly broken, not quietly widened.
 */
describe( 'a path hole\'s access level', () => {

	it( 'ROUND-TRIPS through storage, level intact, including on an optional hole', () => {
		const json = {
			name:   'emit',
			intent: 'Write a report.',
			parts:  [
				{ kind: 'literal' as const, text: 'node tool.js' },
				{ kind: 'file_path' as const, name: 'out', access: 'write' as const },
				{ kind: 'folder_path' as const, name: 'scratch', access: 'delete' as const, optional: true as const }
			]
		};

		expect( Command.fromSerialized( json ).serialize() ).toEqual( json );
		expect( Command.fromSerialized( json ).ready ).toBe( true );
	} );

	it( 'RETIRES a stored path hole that carries no level, rather than reading it back as `read`', () => {
		// Defaulting would let a roster authored before the field keep running at the shallowest rung. `retired` blocks it instead.
		const c = Command.fromSerialized( {
			name:   'legacy',
			intent: 'Authored before the level existed.',
			parts:  [
				{ kind: 'literal', text: 'node --check' },
				{ kind: 'file_path', name: 'file' } as unknown as CommandPart
			]
		} );

		expect( c.getErrors() ).toContain( Command.RETIRED_PART );
		expect( c.ready ).toBe( false );
		// The kind it was named survives in the strip, so the fix is obvious at the keyboard.
		expect( c.describe() ).toContain( 'file_path' );
	} );

	it( 'REFUSES a nonsense level the same way as a missing one', () => {
		// A level that is not one of the three is not a narrower grant, it is no declaration at all.
		const c = Command.fromSerialized( {
			name:   'legacy',
			intent: 'x',
			parts:  [
				{ kind: 'literal', text: 'node' },
				{ kind: 'file_path', name: 'file', access: 'readwrite' } as unknown as CommandPart
			]
		} );

		expect( c.getErrors() ).toContain( Command.RETIRED_PART );
		expect( c.ready ).toBe( false );
	} );

	it( 'BLOCKS a command built in memory with a level missing — the backstop behind the compiler', () => {
		// `access` is required by the type; this blocks data that reached a `Command` without passing either.
		const c = new Command( 'probe', 'x', [
			fixed( 'node' ),
			{ kind: 'file_path', name: 'file' } as unknown as CommandPart
		] );

		expect( c.getErrors() ).toContain( Command.NO_ACCESS );
		expect( c.fetchCode( Command.NO_ACCESS ).blocking ).toBe( true );
		expect( c.fetchCode( Command.NO_ACCESS ).field ).toBe( 'parts' );
		expect( c.ready ).toBe( false );
	} );

	it( 'raises `no_access` ONCE however many holes are unannotated', () => {
		// A code names a CLASS of fault; the surface drawing the holes is the one that knows which of them.
		const c = new Command( 'probe', 'x', [
			fixed( 'node' ),
			{ kind: 'file_path', name: 'a' } as unknown as CommandPart,
			{ kind: 'file_path', name: 'b' } as unknown as CommandPart
		] );

		expect( c.getErrors().filter( ( code ) => code === Command.NO_ACCESS ) ).toHaveLength( 1 );
	} );

	it( 'says nothing about an annotated hole', () => {
		const c = new Command( 'probe', 'x', [ fixed( 'node' ), { kind: 'file_path', name: 'f', access: 'write' } ] );

		expect( c.getErrors() ).not.toContain( Command.NO_ACCESS );
		expect( c.ready ).toBe( true );
	} );
} );
