import { partType, isPathAccess, type FillKind, type PathAccess } from './CommandTypes';

export type { FillKind, PartKind, PartType, PathAccess, PathAccessInfo } from './CommandTypes';
export { PART_TYPES, FILL_KINDS, PATH_ACCESS, PATH_ACCESS_LEVELS, partType, isPathAccess } from './CommandTypes';

/**
 * ONE PART OF A COMMAND LINE. A command is an ARRAY because an argv handed to `spawn` with no shell makes
 * `;` `&&` `|` and `$( )` ordinary letters: chaining is UNREPRESENTABLE, and the guards are defence in depth.
 * A part is a `literal` (fixed text an agent never reaches), a TYPE (a hole the agent fills, validated by its
 * `PART_TYPES` row) or `retired` (blocks the command until re-authored). Every hole declares `access`, never
 * defaulted. The first part is always a literal, so an agent never chooses the program.
 */
export type CommandPart =
	| { kind: 'literal'; text: string }
	| { kind: FillKind;  name: string; access: PathAccess; optional?: boolean }
	| { kind: 'retired'; was: string };

/** A part an agent fills — every kind that carries a `name`. Named so `fillable` can hand back something
 *  already narrowed rather than making each caller re-establish it. */
export type FillablePart = Extract<CommandPart, { name: string }>;

/**
 * Inspection reports facts and never refuses: the verdict is the passport's, so an agent meets one gate and
 * one reason code. A fault is a code, a slot name and raw data, never a sentence.
 */
export type CommandFaultCode =
	| 'missing_value'      // a required slot got nothing
	| 'too_many_values'    // more values than the command has slots
	| 'too_long'           // over the length cap
	| 'control_character'  // a line break, a NUL, anything in the C0 range
	| 'flag_like'          // begins with "-" and would pass itself off as a flag
	| 'not_a_file_path'    // a file slot given something that is not a file path
	| 'not_a_folder_path'; // a directory slot given something that is not a directory path

export interface CommandFault {
	code:   CommandFaultCode;
	/** The slot's name, or empty when the fault is about the call rather than one slot. */
	part:   string;
	/** The offending data — the character found, the segment refused. Never a sentence. */
	detail: string;
}

/**
 * The closed set of ways a command is incomplete, as constants: a consumer names a fault by constant, so a
 * reworded message cannot silently disconnect a surface. Not `CommandFaultCode`, which is about values sent.
 */
export type CommandCode =
	| 'no_name'
	| 'no_intent'
	| 'no_command'
	| 'no_fixed_part'
	| 'duplicate_slot'
	| 'retired_part'
	| 'no_access';

/** One row of the directory. `field` is how a consumer maps a fault it did not detect onto the control showing it. */
export interface CommandCodeInfo {
	code:     CommandCode;
	/** WHICH PART OF THE OBJECT IS AT FAULT — what a surface keys its display off. */
	field:    'name' | 'intent' | 'parts';
	/** What a person reads. Authored here, once, so four surfaces cannot word the same fault four ways. */
	message:  string;
	/** Stops it being handed to an agent. A non-blocking code is a remark. */
	blocking: boolean;
}

/**
 * A COMMAND: a command line a person authored, exposed to an agent as a tool. A shell is unauditable, so a
 * command is fixed parts plus typed holes, reviewed once by a person and gated like any other tool.
 *
 * It sanitizes itself and never gates itself: the verdict is the passport's, one gate with one reason code.
 * Inspection is strict because a false finding costs an author a different type, while a false clean bill
 * costs arbitrary execution.
 *
 * The name is the gate, so there is no gate field: the passport fans per command name. Nor an output format:
 * a command states a template, and what happens to the bytes belongs to the keystone. `on` is absent for the
 * same reason as in `Keystone`: tool modes own whether an agent holds it.
 *
 * Substitution lives here and nowhere else: a call site filling parts inline is how a parameterised command
 * decays back into an arbitrary shell.
 *
 * Fat-object rule, as in `Keystone`: this is the display model, tool definition and execution recipe at once.
 */
export interface SerializedCommand {
	name:      string;
	intent?:   string;
	parts:     CommandPart[];
}

/** Characters that end the call whatever a part's type says, because they break the argv itself. Newline
 *  is not theoretical: the npm/npx shims truncate an argument at the first one, silently. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** No argument may pass itself off as a flag. This is the injection that survives having no shell at all:
 *  `-rf`, `--config=…`, `--exec`. An author who genuinely wants a flag writes it as a literal part. */
const FLAGLIKE = /^-/;

/** A cap, because an unbounded argument is a way to make something else fall over. */
const MAX_LEN = 512;

/**
 * SPLIT ONE LITERAL INTO ARGV ELEMENTS. A literal splits on whitespace; an agent's value NEVER splits.
 * Splitting the author's own fixed text reads it the way they typed it. Never splitting a value is what stops
 * a `file_path` smuggling a second argument: a path with spaces stays exactly one element, always.
 *
 * Quotes hold a run together, since a fixed argument can contain a space. That is a small parser, admissible
 * only because it reads the AUTHOR's text; nothing here touches a value that came from a model.
 *
 * Owed: the editor does not draw the split, so a mis-parse is invisible at the keyboard.
 */
export function commandWords( text: string ): string[] {
	const out: string[] = [];
	let cur   = '';
	let quote: '"' | '\'' | null = null;
	// Tracks a quoted run having been opened, so `""` yields one EMPTY element rather than none. An
	// explicitly empty argument is a real thing to want, and it is not the same as no argument.
	let quoted = false;

	for( const ch of text ) {
		if( quote ) {
			if( ch === quote ) quote = null;
			else               cur += ch;
			continue;
		}
		if( ch === '"' || ch === '\'' ) {
			quote  = ch;
			quoted = true;
			continue;
		}
		if( /\s/.test( ch ) ) {
			if( cur || quoted ) { out.push( cur ); cur = ''; quoted = false; }
			continue;
		}
		cur += ch;
	}
	if( cur || quoted ) out.push( cur );
	return out;
}

/** The kinds a stored part may legally claim. Anything else is a part from a retired kind — see
 *  `Command.fromSerialized`. */
const KNOWN_KINDS: readonly string[] = [ 'literal', 'file_path', 'folder_path', 'retired' ];

export class Command {

	/**
	 * The tool name an agent sees, lower case. Canonicalized here, once: case-folding some name lookups and not
	 * others would run a command under a policy written for a differently-spelled one.
	 */
	readonly name: string

	constructor(
		name: string,
		/**
		 * When to reach for this, authored by a person: the one sentence an agent reads before calling it. Authored,
		 * never derived, because an empty intent is visibly missing where a generated one reads as a decision.
		 * Optional, because requiring it turned a runnable command into a draft. The manifest prints nothing for it.
		 */
		readonly intent: string = '',
		/**
		 * The command line as parts, never a string. The array a person approves is the one an agent calls.
		 * A literal splits on whitespace into argv elements; a filled part is always exactly one, whatever it holds.
		 */
		readonly parts: readonly CommandPart[] = []
	) {
		this.name = Command.normalizeName( name );
	}

	/**
	 * The one spelling of a command's name, trimmed and lower-cased. Surfaces may preview it; nothing needs it
	 * to compare, since every `Command` already holds a canonical name.
	 */
	static normalizeName( raw: string ): string {
		return raw.trim().toLowerCase();
	}

	// ── THE CODES ─────────────────────────────────────────────────────────────────────────────────────
	// Named constants rather than bare strings AT THE CONSUMER'S END. A component writes
	// `Command.NO_INTENT`, never `'no_intent'`, and renaming a fault stays a rename.

	static readonly NO_NAME:        CommandCode = 'no_name';
	static readonly NO_INTENT:      CommandCode = 'no_intent';
	static readonly NO_COMMAND:     CommandCode = 'no_command';
	static readonly NO_FIXED_PART:  CommandCode = 'no_fixed_part';
	static readonly DUPLICATE_SLOT: CommandCode = 'duplicate_slot';
	static readonly RETIRED_PART:   CommandCode = 'retired_part';
	static readonly NO_ACCESS:      CommandCode = 'no_access';

	/** THE DIRECTORY. One row per code, and the only place any of this is worded. */
	static readonly CODES: Readonly<Record<CommandCode, CommandCodeInfo>> = {
		no_name: {
			code: 'no_name', field: 'name', blocking: true,
			message: 'No name. An agent calls this by name and has nothing to call.'
		},
		/* Advisory, not blocking: pinning self-evident commands as drafts made them unreachable, and an empty
		 * intent is still worth a remark. */
		no_intent: {
			code: 'no_intent', field: 'intent', blocking: false,
			message: 'No intent authored. Not required — but if WHEN to reach for this is not obvious from the line above, this is the only place to say so.'
		},
		no_command: {
			code: 'no_command', field: 'parts', blocking: true,
			message: 'No command line.'
		},
		no_fixed_part: {
			code: 'no_fixed_part', field: 'parts', blocking: true,
			message: 'The program is not fixed text — the agent would choose what runs. The FIRST part has to be fixed, which is what makes this a command rather than a shell.'
		},
		duplicate_slot: {
			code: 'duplicate_slot', field: 'parts', blocking: true,
			message: 'Two holes share a name. Arguments arrive positionally, so the manifest would describe one hole twice.'
		},
		retired_part: {
			code: 'retired_part', field: 'parts', blocking: true,
			message: 'A part of this command was authored as a kind that no longer exists. It cannot run — replace it with fixed text or a typed hole.'
		},
		/*
		 * A path hole must not default its access: a forgotten annotation would become a silent grant. The
		 * compiler requires `access`, `fromSerialized` degrades a stored part that lacks it, and this is the backstop.
		 */
		no_access: {
			code: 'no_access', field: 'parts', blocking: true,
			message: 'A path hole does not say what the command DOES with the path. Pick read, write or remove — the reach check is made at that level, and there is deliberately no default.'
		}
	};

	/**
	 * Basic validation: the faults this object can see about itself, as codes. Deliberately basic; a narrower
	 * surface check reports under the same code. A code names a class of fault, so it is raised once.
	 */
	getErrors(): CommandCode[] {
		const found: CommandCode[] = [];
		const names = new Set<string>();

		if( !this.name.trim() )   found.push( Command.NO_NAME );
		if( !this.intent.trim() ) found.push( Command.NO_INTENT );
		if( !this.parts.length )  found.push( Command.NO_COMMAND );

		/*
		 * The FIRST part must be fixed text, not merely some part: a hole in argv[0] lets the agent choose the program.
		 */
		/*
		 * The first part must also split to at least one word: an empty literal would hand argv[0] to the agent.
		 */
		const first = this.parts[ 0 ];
		if( this.parts.length && ( first?.kind !== 'literal' || !commandWords( first.text ).length ) ) {
			found.push( Command.NO_FIXED_PART );
		}

		if( this.parts.some( ( p ) => p.kind === 'retired' ) ) found.push( Command.RETIRED_PART );

		for( const p of this.fillable ) {
			if( names.has( p.name ) && !found.includes( Command.DUPLICATE_SLOT ) ) found.push( Command.DUPLICATE_SLOT );
			names.add( p.name );

			// ONE OF EACH, as above — the surface drawing the holes is the one that knows which of them.
			if( !isPathAccess( p.access ) && !found.includes( Command.NO_ACCESS ) ) found.push( Command.NO_ACCESS );
		}
		return found;
	}

	/** THE DIRECTORY LOOKUP. On the instance because that is where a consumer already has the command, and
	 *  making it reach for the class to read a row it got from the instance is ceremony for nothing. */
	fetchCode( code: CommandCode ): CommandCodeInfo {
		return Command.CODES[ code ];
	}

	/** Authored through — nothing blocking. Says nothing about whether an agent HOLDS it; that is the
	 *  passport's answer, arrived at somewhere else entirely. */
	get ready(): boolean {
		return !this.getErrors().some( ( c ) => this.fetchCode( c ).blocking );
	}

	/** The parts an agent supplies, in order: the order is the contract, since a call passes positionally.
	 *  Narrowed here so no caller re-proves that a list holds no literals. */
	get fillable(): readonly FillablePart[] {
		return this.parts.filter( ( p ): p is FillablePart => p.kind !== 'literal' && p.kind !== 'retired' );
	}

	/** The command as a person reads it — one line, fixed text plain, holes marked with their TYPE. One
	 *  place, so no surface re-composes this and gets the spacing different somewhere else. */
	describe(): string {
		return this.parts.map( ( p ) => {
			if( p.kind === 'literal' ) return p.text;
			if( p.kind === 'retired' ) return `⚠ retired( ${ p.was } )`;
			return `{ ${ p.name }: ${ p.kind }${ p.optional ? ' | —' : '' } }`;
		} ).join( ' ' );
	}

	/**
	 * The argv as far as it can be known before a call: one entry per argument, holes marked. `describe()`
	 * prints a literal verbatim, which hides the quoting split, so surfaces draw it from here.
	 */
	argvShape(): { text: string; hole: boolean }[] {
		const out: { text: string; hole: boolean }[] = [];
		for( const part of this.parts ) {
			if( part.kind === 'literal' ) {
				for( const word of commandWords( part.text ) ) out.push( { text: word, hole: false } );
				continue;
			}
			// Marked as a hole so a surface draws it as one, and named so it lines up with the manifest.
			if( part.kind === 'retired' ) out.push( { text: `⚠ ${ part.was }`, hole: true } );
			else                          out.push( { text: part.name, hole: true } );
		}
		return out;
	}

	/**
	 * The block an agent is handed: this command's whole tool description. The judgement is a person's (intent,
	 * and each hole's type); the call shape is generated from parts, so no parameter can be described that does
	 * not exist. A hole's description comes from its type, never a free hint. Rendered verbatim in the editor.
	 */
	manifest(): string {
		const slots = this.fillable.map( ( p ) => {
			const type = partType( p.kind );
			return `  ${ p.name } — ${ type?.describe ?? p.kind }${ p.optional ? '   ( may be omitted )' : '' }`;
		} );

		/* No intent means no line: a warning here would reach a model as the command's guidance. */
		const intent = this.intent.trim();

		return [
			`${ this.name.trim() || '⚠ unnamed' }`,
			...( intent ? [ intent ] : [] ),
			``,
			`Runs: ${ this.describe() }`,
			slots.length ? `Arguments, in order:` : `Takes no arguments.`,
			...slots
		].join( '\n' );
	}

	/**
	 * The values as they will run, each through its slot's type. This is the only normalization point: judging
	 * one string and running another is validate-then-mutate, and that is how a check gets passed by a value it never saw.
	 */
	filled( values: readonly string[] ): string[] {
		return this.fillable.map( ( part, i ) => {
			const raw  = values[ i ] ?? '';
			const type = partType( part.kind );
			return type ? type.normalize( raw ) : raw;
		} );
	}

	/**
	 * Every fault, not the first: one verdict per call, and an agent told one bad character at a time would
	 * round-trip once per character. An empty array means the values are clean, not that the call may proceed.
	 */
	inspect( values: readonly string[] ): CommandFault[] {
		const faults: CommandFault[] = [];
		const slots  = this.fillable;

		if( values.length > slots.length ) {
			faults.push( { code: 'too_many_values', part: '', detail: `${ values.length } sent, ${ slots.length } expected` } );
		}
		slots.forEach( ( part, i ) => {
			const fault = this.inspectPart( part, values[ i ] ?? '' );
			if( fault ) faults.push( fault );
		} );
		return faults;
	}

	/**
	 * One slot, one value. Public so an authoring surface cannot drift from the rules that run. It normalizes
	 * first, so it judges the string that would run, which means normalize must be idempotent. A type may narrow
	 * the check; nothing may widen past the control, length and flag checks.
	 */
	inspectPart( part: CommandPart, value: string ): CommandFault | null {
		if( part.kind === 'literal' || part.kind === 'retired' ) return null;

		const type = partType( part.kind );
		const v    = type ? type.normalize( value ) : value.trim();

		if( !v ) return part.optional ? null : { code: 'missing_value', part: part.name, detail: type?.describe ?? '' };

		if( v.length > MAX_LEN ) return { code: 'too_long',          part: part.name, detail: `${ v.length } of ${ MAX_LEN }` };
		if( CONTROL.test( v ) )  return { code: 'control_character', part: part.name, detail: '' };
		if( FLAGLIKE.test( v ) ) return { code: 'flag_like',         part: part.name, detail: '-' };

		if( type ) {
			const detail = type.validate( v );
			if( detail !== null ) return { code: type.fault, part: part.name, detail };
		}
		return null;
	}

	/**
	 * The argv, built from an agent's positional values. It throws on a fault: reaching here faulty means the
	 * checkpoint was bypassed, so it fails loud. The refusal path is the verdict, not this throw.
	 */
	argv( values: readonly string[] ): string[] {
		const faults = this.inspect( values );
		if( faults.length ) {
			throw new Error( `WARNING — argv() reached with ${ faults.length } uninspected fault(s) on "${ this.name }": `
				+ faults.map( ( f ) => `${ f.part || 'call' }/${ f.code }` ).join( ', ' )
				+ '. The checkpoint was bypassed; nothing was run.' );
		}

		// NORMALIZED, through the one door. What is inspected above and what is pushed below are the same
		// strings — see `filled`.
		const ready = this.filled( values );
		const out: string[] = [];
		let i = 0;
		for( const part of this.parts ) {
			if( part.kind === 'literal' ) {
				// SPLIT — the author's fixed text becomes as many argv elements as they wrote.
				out.push( ...commandWords( part.text ) );
				continue;
			}
			// Unreachable in practice: a retired part is blocking, so the command never reaches an agent. Skipped
			// without consuming a value, because `fillable` did not count it either.
			if( part.kind === 'retired' ) continue;

			const value = ready[ i++ ] ?? '';
			if( value ) out.push( value );
		}
		return out;
	}

	/**
	 * The wire form, plain data all the way down. Parts are rebuilt rather than spread, because a spread copies
	 * element references, and a reactive proxy in an IPC payload is refused by structured clone.
	 */
	serialize(): SerializedCommand {
		const parts = this.parts.map( ( p ): CommandPart => {
			if( p.kind === 'literal' ) return { kind: 'literal', text: p.text };
			if( p.kind === 'retired' ) return { kind: 'retired', was: p.was };
			// `optional` only when set: an `undefined` key breaks equality against a round-tripped row. `access` is
			// always written, and `fromSerialized` refuses a stored part that lacks it.
			return p.optional
				? { kind: p.kind, name: p.name, access: p.access, optional: true }
				: { kind: p.kind, name: p.name, access: p.access };
		} );
		return { name: this.name, intent: this.intent, parts };
	}

	/**
	 * Rebuild from storage or the wire. A part of a kind that no longer exists is kept visibly broken as `retired`:
	 * guessing would silently change what a privileged command runs. A path hole with no `access` is the same case;
	 * defaulting it to `read` would be guessing at a security declaration.
	 */
	static fromSerialized( json: SerializedCommand ): Command {
		const parts = ( json.parts ?? [] ).map( ( p ): CommandPart => {
			const kind = ( p as { kind?: string } ).kind ?? '';
			if( !KNOWN_KINDS.includes( kind ) ) return { kind: 'retired', was: kind || 'unnamed' };

			// A fillable kind is a path kind, and a path kind without a level is not a part this can rebuild.
			if( kind !== 'literal' && kind !== 'retired' && !isPathAccess( ( p as { access?: unknown } ).access ) ) {
				return { kind: 'retired', was: kind };
			}
			return p;
		} );
		return new Command( json.name, json.intent ?? '', parts );
	}
}
