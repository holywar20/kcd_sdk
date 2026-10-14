import {
	partType, isPathAccess, isPathKind, isPathPart, PART_TYPES,
	type CommandPart, type FillablePart, type CommandFaultCode
} from './CommandTypes';

export type {
	FillKind, PathKind, ValueKind, PartKind, PartType, PathAccess, PathAccessInfo,
	CommandPart, FillablePart, FillablePathPart, CommandFaultCode
} from './CommandTypes';
export {
	PART_TYPES, FILL_KINDS, PATH_KINDS, PATH_ACCESS, PATH_ACCESS_LEVELS,
	RES_SCHEME, partType, isPathAccess, isPathKind, isPathPart
} from './CommandTypes';

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
	| 'no_access'
	| 'bad_bound'
	| 'no_options'
	| 'bad_cap'
	| 'bad_prefix'
	| 'bad_timeout';

/** One row of the directory. `field` is how a consumer maps a fault it did not detect onto the control showing it. */
export interface CommandCodeInfo {
	code:     CommandCode;
	/** WHICH PART OF THE OBJECT IS AT FAULT — what a surface keys its display off. */
	field:    'name' | 'intent' | 'parts' | 'timeout';
	/** What a person reads. Authored here, once, so four surfaces cannot word the same fault four ways. */
	message:  string;
	/** Stops it being handed to an agent. A non-blocking code is a remark. */
	blocking: boolean;
}

/**
 * HOW LONG A COMMAND MAY RUN, as an author declares it. Seconds, because that is what a person reads and writes.
 *
 * ── FIFTEEN MINUTES, AND IT IS A CHOSEN CEILING RATHER THAN AN INHERITED ONE ── ( Bryan, 2026-10-14 )
 * "Imports can take a long time. Lets be generous." A headless Godot `--import` over a cold project walks every
 * asset in it, and on a real game that is minutes rather than seconds. A ceiling sized to a TypeScript typecheck
 * would make the engine commands this vocabulary exists for report a timeout exactly when they mattered most.
 *
 * ── THE ONE ORDERING THAT MUST NEVER FLIP ──
 * The command tool buys a routed budget derived from this number ( `command_run.budgetMs` ), and that budget must
 * sit ABOVE the runner's own kill. Under it, the client hangs up first and the agent is told its TOOL timed out
 * instead of being told what the command said with the partial output on it — DEFECT-082, which ran for weeks on a
 * 10s wall under a 60s kill. `CommandKeystone.test.ts` pins that direction and only that direction.
 *
 * ── NOTHING CAPS IT FROM ABOVE, WHICH IS THE CORRECTION ──
 * This was 150s on the belief that the budget had to stay under `DEFAULT_TOOL_TIMEOUT_MS` ( 180s ), the house
 * liveness ceiling. That constant is the ceiling for a server that NAMES NONE: `ServerManifest.timeoutMs` and a
 * keystone's `budgetMs` both override it, which is the mechanism `sm_file.grep` and `sm_testing` already use, and
 * above it nothing expires at all — a turn ends when it finishes, when a person stops it, or when the child dies.
 * So the old comment's "bounded by something further out that nobody chose" named a wall that does not exist.
 *
 * ── WHAT IT COSTS, AND THE COST WAS RULED ON RATHER THAN ABSORBED ── ( Bryan, 2026-10-14 )
 * A budget is published PER SERVER, and `Keystones.budgetFor` takes the LARGEST any member declared. `command_run`
 * is the only `sm_core` keystone that declares one, so this number is also the liveness wall for `flag`,
 * `project_status`, `remember` and `recall`. Each of those returns immediately or not at all, so what it buys is
 * that a genuinely WEDGED one burns fifteen minutes instead of three — `flag` being the honourable exit and so the
 * member worth the thought. That is the DEFECT-924 hazard the keystone suite warns about, and it was put to Bryan
 * with the alternative ( move the command tool into a group of its own ) beside it: "Accept the sm_core coupling —
 * flag can wait 15 min."
 *
 * SO THE SPLIT IS NOT OWED, it was declined. If it ever does bite, that is the move — not shrinking this back,
 * which would trade a capability somebody asked for against a hazard nobody has seen.
 */
export const TIMEOUT_MIN_S = 1;
export const TIMEOUT_MAX_S = 900;

/**
 * WHETHER A COMMAND PROMPTS, as the author declares it.
 *
 * ── IT IS A DEFAULT AND NOT A GATE ──
 * The `command` permission row fans per command name and a person's answer is stamped on the passport, which is
 * where the real decision lives and always has. This says what that row answers for a name NOBODY HAS STAMPED. It
 * exists because the alternative is that every new command starts at `allow` and somebody has to remember to go and
 * tighten the dangerous ones — running a test suite should be unattended and writing commit history should not, and
 * which of those a command is, is a fact the author knows at the moment they write it.
 *
 * `off` is deliberately not offerable here: a command the author does not want run is a command they do not author.
 */
export type CommandPolicy = 'allow' | 'ask';

/**
 * A COMMAND: a command line a person authored, exposed to an agent as a tool. A shell is unauditable, so a
 * command is fixed parts plus typed holes, reviewed once by a person and gated like any other tool.
 *
 * It sanitizes itself and never gates itself: the verdict is the passport's, one gate with one reason code.
 * Inspection is strict because a false finding costs an author a different type, while a false clean bill
 * costs arbitrary execution.
 *
 * The name is the gate, so there is no gate field — the passport fans per command name, and `policy` here seeds
 * what that row answers rather than deciding anything. Nor an output format: a command states a template, and what
 * happens to the bytes belongs to the keystone. `on` is absent for the same reason as in `Keystone`: tool modes own
 * whether an agent holds it.
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
	/** Wall-clock seconds before the child is killed. Absent means the house default. */
	timeout?:  number;
	/** What the permission row answers for this name when nobody has stamped it. Absent means `allow`. */
	policy?:   CommandPolicy;
}

/** Characters that end the call whatever a part's type says, because they break the argv itself. Newline
 *  is not theoretical: the npm/npx shims truncate an argument at the first one, silently. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** No argument may pass itself off as a flag. This is the injection that survives having no shell at all:
 *  `-rf`, `--config=…`, `--exec`. An author who genuinely wants a flag writes it as a literal part, or glues it
 *  to a hole with that hole's `prefix` — either way the dash is the author's text and never the model's. */
const FLAGLIKE = /^-/;

/** A cap, because an unbounded argument is a way to make something else fall over. The HARD ceiling: a `text`
 *  hole declares its own cap, which this bounds from above. */
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
 *  `Command.fromSerialized`. Derived from the type registry rather than hand-listed: a kind added there and
 *  forgotten here would load back as `retired` and block every command using it. */
const KNOWN_KINDS: readonly string[] = [ 'literal', 'retired', ...Object.keys( PART_TYPES ) ];

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
		readonly parts: readonly CommandPart[] = [],
		/**
		 * Wall-clock seconds before the child is killed, or null for the house default. A declared timeout is the
		 * author's statement about what a reasonable run of THIS command looks like; a headless engine run can hang,
		 * and a hung command stalls the lane that called it until somebody notices.
		 */
		readonly timeout: number | null = null,
		/** What the permission row answers for this name when nobody has stamped it — see `CommandPolicy`. */
		readonly policy: CommandPolicy = 'allow'
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
	static readonly BAD_BOUND:      CommandCode = 'bad_bound';
	static readonly NO_OPTIONS:     CommandCode = 'no_options';
	static readonly BAD_CAP:        CommandCode = 'bad_cap';
	static readonly BAD_PREFIX:     CommandCode = 'bad_prefix';
	static readonly BAD_TIMEOUT:    CommandCode = 'bad_timeout';

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
		},
		/* A bound nobody validates is documentation, so an int hole without a usable one blocks rather than
		 * silently admitting every number an agent can type. */
		bad_bound: {
			code: 'bad_bound', field: 'parts', blocking: true,
			message: 'A number hole has no usable range. Give a lowest and a highest whole number, lowest first, and not below zero — a negative value is refused as flag-like before any range is consulted, so a negative bound is a hole nothing can fill.'
		},
		no_options: {
			code: 'no_options', field: 'parts', blocking: true,
			message: 'A choice hole lists no options, or lists the same one twice. The whole value of this type is that the agent picks something you wrote, so an empty list is a hole nothing can satisfy.'
		},
		bad_cap: {
			code: 'bad_cap', field: 'parts', blocking: true,
			message: `A free-text hole has no usable length cap. Give a whole number from 1 to ${ MAX_LEN }. Keep it as low as the command really needs — the cap is the only bound on this type.`
		},
		/* A prefix is glued to the value inside ONE argv element, so whitespace in it would claim a split that
		 * never happens — the author would read two arguments and the program would receive one. */
		bad_prefix: {
			code: 'bad_prefix', field: 'parts', blocking: true,
			message: 'A hole\'s prefix contains a space or a quote. A prefix is joined to the value inside a single argument, so it cannot split — write it as fixed text instead if you meant two arguments.'
		},
		bad_timeout: {
			code: 'bad_timeout', field: 'timeout', blocking: true,
			message: `The time limit is not a usable number of seconds. Give a whole number from ${ TIMEOUT_MIN_S } to ${ TIMEOUT_MAX_S }, or leave it off for the house default. A command needing longer than that has outgrown the deck — the agent holds its turn open for the whole run.`
		}
	};

	/**
	 * Basic validation: the faults this object can see about itself, as codes. Deliberately basic; a narrower
	 * surface check reports under the same code. A code names a class of fault, so it is raised once.
	 */
	getErrors(): CommandCode[] {
		const found: CommandCode[] = [];
		const names = new Set<string>();
		const raise = ( code: CommandCode ): void => { if( !found.includes( code ) ) found.push( code ); };

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

		// A declared limit is checked here rather than clamped at the spawn: clamping would run the command under a
		// limit the author never wrote, and the surface showing their number would be showing a lie.
		if( this.timeout !== null && !_wholeWithin( this.timeout, TIMEOUT_MIN_S, TIMEOUT_MAX_S ) ) {
			found.push( Command.BAD_TIMEOUT );
		}

		for( const p of this.fillable ) {
			if( names.has( p.name ) ) raise( Command.DUPLICATE_SLOT );
			names.add( p.name );

			// ONE OF EACH, as above — the surface drawing the holes is the one that knows which of them.
			// ONLY A PATH KIND declares a rung: a value kind reaches no disk, and demanding one of it would make the
			// required field meaningless everywhere it genuinely is required.
			if( isPathPart( p ) && !isPathAccess( p.access ) ) raise( Command.NO_ACCESS );

			if( p.kind === 'int' && !( _wholeWithin( p.min, 0, Number.MAX_SAFE_INTEGER )
				&& _wholeWithin( p.max, 0, Number.MAX_SAFE_INTEGER ) && p.min <= p.max ) ) {
				raise( Command.BAD_BOUND );
			}
			if( p.kind === 'enum' && !_usableOptions( p.options ) ) raise( Command.NO_OPTIONS );
			if( p.kind === 'text' && !_wholeWithin( p.maxLength, 1, MAX_LEN ) ) raise( Command.BAD_CAP );

			if( p.prefix !== undefined && !_usablePrefix( p.prefix ) ) raise( Command.BAD_PREFIX );
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

	/** The seconds this command is given, declared or house. One expression, so the surface drawing the number and
	 *  the runner enforcing it cannot disagree about what an absent `timeout` means. */
	secondsWith( houseDefault: number ): number {
		return this.timeout ?? houseDefault;
	}

	/** The command as a person reads it — one line, fixed text plain, holes marked with their TYPE. One
	 *  place, so no surface re-composes this and gets the spacing different somewhere else. */
	describe(): string {
		return this.parts.map( ( p ) => {
			if( p.kind === 'literal' ) return p.text;
			if( p.kind === 'retired' ) return `⚠ retired( ${ p.was } )`;
			// The prefix is drawn glued on, because that is how it runs — a space here would misreport the split.
			return `${ p.prefix ?? '' }{ ${ p.name }: ${ p.kind }${ p.optional ? ' | —' : '' } }`;
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
			// One element, prefix included — the whole point of a prefix is that it does not become a second argument.
			else                          out.push( { text: `${ part.prefix ?? '' }${ part.name }`, hole: true } );
		}
		return out;
	}

	/**
	 * The block an agent is handed: this command's whole tool description. The judgement is a person's (intent,
	 * and each hole's type); the call shape is generated from parts, so no parameter can be described that does
	 * not exist. A hole's description comes from its type AND ITS OWN BOUND, never a free hint — a manifest that
	 * said "a whole number" where the hole accepts 1..600 would be training an agent to be refused. Rendered
	 * verbatim in the editor.
	 */
	manifest(): string {
		const slots = this.fillable.map( ( p ) => {
			const type = partType( p.kind );
			return `  ${ p.name } — ${ type ? type.describe( p ) : p.kind }${ p.optional ? '   ( may be omitted )' : '' }`;
		} );

		/* No intent means no line: a warning here would reach a model as the command's guidance. */
		const intent = this.intent.trim();

		/* A DECLARED limit is stated and the house default is not. The number is only worth an agent's attention
		 * when the author chose it — otherwise every command in the manifest would carry the same line. */
		const limit = this.timeout !== null
			? [ `Killed if it runs longer than ${ this.timeout }s, reported as a timeout rather than as a failure.` ]
			: [];

		/* A command that prompts is stated, because it changes what the agent should EXPECT: the call may stop and
		 * wait on a person rather than returning. One that does not prompt says nothing — silence is the norm. */
		const prompts = this.policy === 'ask'
			? [ 'ASKS FIRST — a person is prompted before this runs, so the call may wait or come back declined.' ]
			: [];

		return [
			`${ this.name.trim() || '⚠ unnamed' }`,
			...( intent ? [ intent ] : [] ),
			``,
			`Runs: ${ this.describe() }`,
			slots.length ? `Arguments, in order:` : `Takes no arguments.`,
			...slots,
			...( limit.length || prompts.length ? [ '' ] : [] ),
			...limit,
			...prompts
		].join( '\n' );
	}

	/**
	 * The values as they will run, each through its slot's type. This is the only normalization point: judging
	 * one string and running another is validate-then-mutate, and that is how a check gets passed by a value it never saw.
	 *
	 * THE PREFIX IS NOT PART OF THIS. These are the AGENT's values, and they are what gets judged; the prefix is
	 * the author's and is joined on in `argv`. Normalizing a prefixed string would mean the leading-dash check met
	 * the author's dash instead of the model's value, and refused every prefixed hole.
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

		if( !v ) return part.optional ? null : { code: 'missing_value', part: part.name, detail: type ? type.describe( part ) : '' };

		// The HARD ceiling, above whatever a `text` hole declares for itself. A type narrows this and cannot widen it.
		if( v.length > MAX_LEN ) return { code: 'too_long',          part: part.name, detail: `${ v.length } of ${ MAX_LEN }` };
		if( CONTROL.test( v ) )  return { code: 'control_character', part: part.name, detail: '' };
		if( FLAGLIKE.test( v ) ) return { code: 'flag_like',         part: part.name, detail: '-' };

		if( type ) {
			const detail = type.validate( v, part );
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
			// ONE ELEMENT, prefix and value together. An omitted optional hole contributes nothing at all — not an
			// empty string and not a bare prefix, which would reach the program as a flag with no argument.
			if( value ) out.push( `${ part.prefix ?? '' }${ value }` );
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

			// Written only when set: an `undefined` key breaks equality against a round-tripped row. Each kind's own
			// declaration is written unconditionally, and `fromSerialized` refuses a stored part that lacks it.
			const tail = {
				...( p.optional ? { optional: true as const } : {} ),
				...( p.prefix  ? { prefix: p.prefix } : {} )
			};
			if( p.kind === 'int' )  return { kind: 'int',  name: p.name, min: p.min, max: p.max, ...tail };
			if( p.kind === 'enum' ) return { kind: 'enum', name: p.name, options: [ ...p.options ], ...tail };
			if( p.kind === 'text' ) return { kind: 'text', name: p.name, maxLength: p.maxLength, ...tail };
			return { kind: p.kind, name: p.name, access: p.access, ...tail };
		} );
		return {
			name:   this.name,
			intent: this.intent,
			parts,
			...( this.timeout !== null  ? { timeout: this.timeout } : {} ),
			...( this.policy === 'ask'  ? { policy: 'ask' as const } : {} )
		};
	}

	/**
	 * Rebuild from storage or the wire. A part of a kind that no longer exists is kept visibly broken as `retired`:
	 * guessing would silently change what a privileged command runs. A path hole with no `access` is the same case;
	 * defaulting it to `read` would be guessing at a security declaration.
	 *
	 * A BROKEN DECLARATION ON A VALUE HOLE IS LEFT INTACT rather than degraded to `retired`, which is the opposite
	 * choice to `access` and deliberate. A missing bound is not a security declaration — nothing is granted by it
	 * either way — and `getErrors` already blocks the command and names the actual fault, which is what an author
	 * has to read in order to fix it. Degrading would replace that with "a kind that no longer exists", which is
	 * false and tells them nothing.
	 */
	static fromSerialized( json: SerializedCommand ): Command {
		const parts = ( json.parts ?? [] ).map( ( p ): CommandPart => {
			const kind = ( p as { kind?: string } ).kind ?? '';
			if( !KNOWN_KINDS.includes( kind ) ) return { kind: 'retired', was: kind || 'unnamed' };

			// A PATH kind without a rung is not a part this can rebuild: there is no safe level to assume, and
			// assuming one would be inventing the security declaration the author omitted.
			if( isPathKind( kind ) && !isPathAccess( ( p as { access?: unknown } ).access ) ) {
				return { kind: 'retired', was: kind };
			}
			return p;
		} );
		// A stored timeout is carried through as-is and judged by `getErrors`: coercing a bad one to the default
		// would run the command under a limit nobody authored, and silently.
		const timeout = typeof json.timeout === 'number' ? json.timeout : null;
		const policy  = json.policy === 'ask' ? 'ask' : 'allow';
		return new Command( json.name, json.intent ?? '', parts, timeout, policy );
	}
}

/** A whole number inside a closed range, answered for data that may be anything. */
function _wholeWithin( value: unknown, min: number, max: number ): boolean {
	return typeof value === 'number' && Number.isSafeInteger( value ) && value >= min && value <= max;
}

/** A choice list an agent could actually satisfy: at least one option, each non-empty, and no duplicates — a
 *  duplicated option would describe one choice twice in the manifest, which is the `duplicate_slot` fault one
 *  level down. */
function _usableOptions( options: unknown ): boolean {
	if( !Array.isArray( options ) || !options.length ) return false;
	const seen = new Set<string>();
	for( const o of options ) {
		if( typeof o !== 'string' || !o.trim() ) return false;
		if( seen.has( o ) ) return false;
		seen.add( o );
	}
	return true;
}

/** A prefix that will survive being one argv element: no whitespace, no quotes, and not empty if present. */
function _usablePrefix( prefix: unknown ): boolean {
	return typeof prefix === 'string' && !!prefix && !/[\s"']/.test( prefix );
}
