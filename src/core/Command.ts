/**
 * ONE PART OF A COMMAND LINE — and the reason a command is an ARRAY rather than a string.
 *
 * A template with slots is still a string, so something has to parse it, and a parser is where the bugs
 * live. An array of parts is an argv: it is handed to `spawn` with NO SHELL, so `;` `&&` `|` backtick and
 * `$( )` are not dangerous characters that must be caught — they are ordinary letters inside one argument,
 * because nothing on the path ever interprets them. Chaining is not forbidden, it is UNREPRESENTABLE, and
 * a path with spaces needs no quoting because it was never adjacent to anything to be confused with.
 *
 * That is the whole trade: structural impossibility instead of correct escaping. The guard below is then
 * defence in depth rather than the mechanism, which is the right way round — a mechanism that depends on
 * catching every bad character is one missed character from being no mechanism at all.
 *
 *   literal   fixed text the author wrote. The binary, its subcommands, flags that must not vary. Never
 *             appears in the agent's schema; an agent cannot reach it, change it or remove it.
 *   input     the agent authors this one. Guarded on the way in — see `Command.guard`.
 *   choice    the agent picks from a menu the author wrote. `optional` allows picking nothing, which is
 *             how a flag that may be left off is expressed.
 */
export type CommandPart =
	| { kind: 'literal'; text: string }
	| { kind: 'input';   name: string; hint: string; pattern?: string }
	| { kind: 'choice';  name: string; options: readonly string[]; optional?: boolean };

/** A part an agent fills — the two kinds that carry a `name`, which is every kind but `literal`. Named so
 *  `fillable` can hand back something already narrowed rather than making each caller re-establish it. */
export type FillablePart = Exclude<CommandPart, { kind: 'literal' }>;

/**
 * WHAT INSPECTION FOUND — a fact about a value, never a decision about a call.
 *
 * A command does NOT refuse. It sanitizes itself ( the parts array makes escaping unrepresentable ) and it
 * reports what it found; whether the call happens is the passport's answer, arrived at the same way it is
 * arrived at for every other thing an agent asks for. A command that could veto on its own configuration
 * would be a second gate with its own vocabulary, and an agent would face two refusals that look nothing
 * alike for reasons it cannot tell apart. One gate, one verdict, one reason code.
 *
 * SO THERE IS NO PROSE HERE. `code` is for the machine, `detail` is the offending data, and the sentence an
 * agent reads is authored beside every other refusal in the system, next to the policy ladder that words
 * them. A fault crossing a process boundary as data is the point: main words it, and a surface can key on
 * the code without parsing English.
 */
export type CommandFaultCode =
	| 'missing_value'      // a required slot got nothing
	| 'too_many_values'    // more values than the command has slots
	| 'too_long'           // over the length cap
	| 'control_character'  // a line break, a NUL, anything in the C0 range
	| 'flag_like'          // begins with "-" and would pass itself off as a flag
	| 'shell_character'    // a quote or shell metacharacter
	| 'not_an_option'      // a choice slot given something outside its set
	| 'pattern_mismatch';  // failed the part's own declared pattern

export interface CommandFault {
	code:   CommandFaultCode;
	/** The slot's name, or empty when the fault is about the call rather than one slot. */
	part:   string;
	/** The offending data — the character found, the options allowed. Never a sentence. */
	detail: string;
}

/**
 * WHAT CAN BE WRONG WITH A COMMAND — the closed set, and the reason it is a set of CONSTANTS.
 *
 * A CODE IS A JOINT, NOT A MESSAGE ( Bryan, 2026-08-22 ). Validation does not belong to one surface: the
 * editor wants to light a field red, the deck wants to mark a row a draft, a registry wants to refuse to
 * expose one, and each of those is a DIFFERENT display decision about the same fault. So each consumer
 * writes the check it needs — that is what it is there for — and what keeps them all talking about the same
 * fault is the constant they name it with. `Command.NO_INTENT` is find-and-replaceable across every
 * component that ever reacted to it; a string literal typed into a template is not, and the day the wording
 * changes one surface goes quietly dark.
 *
 * SO THE MESSAGE IS NOT THE IDENTITY. The identity is the code. The sentence, the field it belongs to and
 * whether it blocks all hang off it in the directory below, where they can be edited without touching a
 * single consumer.
 *
 * NOT `CommandFaultCode`. A fault is about values an AGENT sent; a code here is about work a PERSON has not
 * done. Two different questions with two different audiences, and merging them would hand every surface one
 * list it has to sort back apart.
 */
export type CommandCode =
	| 'no_name'
	| 'no_intent'
	| 'no_command'
	| 'no_fixed_part'
	| 'undescribed_input'
	| 'empty_menu'
	| 'duplicate_slot';

/**
 * ONE ROW OF THE DIRECTORY. `field` is the load-bearing one: it is how a consumer maps a fault it did not
 * itself detect onto the control that shows it, without a switch statement per surface that has to be
 * extended every time a code is added.
 */
export interface CommandCodeInfo {
	code:     CommandCode;
	/** WHICH PART OF THE OBJECT IS AT FAULT — what a surface keys its display off. */
	field:    'name' | 'intent' | 'parts';
	/** What a person reads. Authored here, once, so four surfaces cannot word the same fault four ways. */
	message:  string;
	/** Stops it being handed to an agent. A non-blocking code is a remark; every one below blocks, and the
	 *  flag exists so the first advisory code does not force this to become two lists. */
	blocking: boolean;
}

/**
 * A COMMAND — a command line a person authored, exposed to an agent as a tool.
 *
 * ── DECLARED RATHER THAN TYPED, AND THAT IS THE WHOLE IDEA ──
 * A shell is unsafe because it is UNAUDITABLE: one string can be anything, so there is no honest gate to
 * put in front of it and no review that means anything. A command inverts exactly that — fixed parts,
 * named fillable ones, a stated output format — so it can be reviewed ONCE by a person and gated forever
 * after like any other tool. This is the shape that makes shell-adjacent capability governable, rather
 * than the shape that gives up and ships a terminal.
 *
 * THIS IS A PRIVILEGED PIPE INTO A COMMAND LINE and is treated as one. The parts array removes the class of
 * bug rather than defending against it, and `inspect` is ruthless about the rest — one character it dislikes
 * is a fault, because the cost of a false finding is an author widening one pattern and the cost of a false
 * clean bill is arbitrary execution.
 *
 * ── IT SANITIZES ITSELF. IT DOES NOT GATE ITSELF ── ( Bryan, 2026-08-21 )
 * Inspection is internal and needs no passport: it is mechanical, it is about the values and not about the
 * agent, and it would give the same answer for anyone. THE VERDICT IS NOT ITS BUSINESS. A command that
 * refused on its own configuration would be a second security path beside the passport, with its own
 * refusal shape and its own reason vocabulary, and every new governed thing would grow another one. A turn
 * arrives packaged, the orchestrator checks the passport against the request — whatever the request may be,
 * and an agent can ask for infinitely many things — and one yes-or-no with one reason code comes back. A
 * command is not an exception to that; it is the case that most tempts you to make one.
 *
 * ── SAME FAT-OBJECT RULE AS `Keystone` ──
 * This object is the display model, the tool definition and the execution recipe at once. `parts` draws the
 * chip strip a person reads, generates the manifest line an agent is handed, and IS the argv. Splitting
 * those into three types would put a registry between them whose only job is to reassemble them, and would
 * give three places for one command to be described differently.
 *
 * `on` is absent for the same reason it is absent there: whether an agent holds this is that agent's tool
 * modes, which already own the fact.
 *
 * ── NO GATE FIELD EITHER ── ( Bryan, 2026-08-22 )
 * There was a `gate` here naming which permission row governed the command, and its own note predicted this
 * retirement. Every command now gets its own passport entry, one for one: the permission table carries a
 * single `command` row that fans PER SUBJECT, and the subject is the command's name. So a command IS its own
 * gate and does not need to name one — the name it already has does the work, and a field pointing at a row
 * would be a second answer to a question that now has one.
 *
 * ── NO OUTPUT FORMAT ── ( Bryan, 2026-08-22 )
 * There was a `format: 'text' | 'json'` here and it is gone. A command's job is to state a TEMPLATE that
 * satisfies the contract with an agent — what runs, when to reach for it, which holes it may fill. What
 * happens to the bytes coming back is a different job at a different boundary, and a keystone is where it
 * will land. A command that also declared its output shape would be the first of a series: an encoding, a
 * timeout, a retry, a parser — each individually reasonable, and collectively a second execution engine
 * grown inside a description.
 *
 * ── SUBSTITUTION LIVES HERE, SAID BEFORE SOMEBODY PUTS IT SOMEWHERE ELSE ──
 * Filling the parts from an agent's arguments is THIS class's job and no caller's. A call site doing it
 * inline is precisely how a parameterised command decays back into an arbitrary shell.
 */
export interface SerializedCommand {
	name:      string;
	intent?:   string;
	parts:     CommandPart[];
}

/** Characters that end the call whatever a part declares, because they break the argv itself rather than
 *  merely looking dangerous: NUL, newline, carriage return, tab and the rest of the C0 range. Newline is
 *  not theoretical — the npm/npx shims truncate an argument at the first one, silently. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** Shell metacharacters. INERT, because nothing here ever reaches a shell — refused anyway. They cost an
 *  author nothing to avoid, and the day somebody adds a `shell: true` in a hurry this list is the thing
 *  that was already standing there. */
const SHELLISH = /['"`;&|<>$()]/;

/** No argument may pass itself off as a flag. This is the injection that survives having no shell at all:
 *  `-rf`, `--config=…`, `--exec`. An author who genuinely wants a flag writes it as a literal part. */
const FLAGLIKE = /^-/;

/** A cap, because an unbounded argument is a way to make something else fall over. */
const MAX_LEN = 512;

export class Command {

	constructor(
		/** The tool name an agent sees. */
		readonly name: string,
		/**
		 * WHEN TO REACH FOR THIS — authored by a person, and the only sentence an agent reads before deciding
		 * to call it. Not "what it does": the command line already says that, and an agent can read it. This is
		 * the judgement a person has and a model does not — that `check_types` is the thing to run after an
		 * edit and before claiming the edit worked.
		 *
		 * AUTHORED, NEVER DERIVED ( Bryan, 2026-08-22 ). Everything else about a command can be produced from
		 * its parts. This cannot, and a generated stand-in would be worse than an empty one: an empty intent is
		 * visibly missing, and a plausible sentence assembled from the binary's name reads as though somebody
		 * decided it. So a command without one is a draft — see `Command.NO_INTENT`.
		 */
		readonly intent: string = '',
		/**
		 * THE COMMAND LINE, in order, as parts. Never a string: see `CommandPart`.
		 *
		 * Held verbatim so a reviewer reads exactly what will run — the same array the surface draws and the
		 * agent's manifest line is generated from, so a person approving a command and an agent calling it
		 * cannot be looking at two different things.
		 */
		readonly parts: readonly CommandPart[] = []
	) {}

	// ── THE CODES ─────────────────────────────────────────────────────────────────────────────────────
	// Named constants rather than bare strings AT THE CONSUMER'S END. A component writes
	// `Command.NO_INTENT`, never `'no_intent'`, and renaming a fault stays a rename.

	static readonly NO_NAME:           CommandCode = 'no_name';
	static readonly NO_INTENT:         CommandCode = 'no_intent';
	static readonly NO_COMMAND:        CommandCode = 'no_command';
	static readonly NO_FIXED_PART:     CommandCode = 'no_fixed_part';
	static readonly UNDESCRIBED_INPUT: CommandCode = 'undescribed_input';
	static readonly EMPTY_MENU:        CommandCode = 'empty_menu';
	static readonly DUPLICATE_SLOT:    CommandCode = 'duplicate_slot';

	/** THE DIRECTORY. One row per code, and the only place any of this is worded. */
	static readonly CODES: Readonly<Record<CommandCode, CommandCodeInfo>> = {
		no_name: {
			code: 'no_name', field: 'name', blocking: true,
			message: 'No name. An agent calls this by name and has nothing to call.'
		},
		no_intent: {
			code: 'no_intent', field: 'intent', blocking: true,
			message: 'No intent. Nobody has written when an agent should reach for this.'
		},
		no_command: {
			code: 'no_command', field: 'parts', blocking: true,
			message: 'No command line.'
		},
		no_fixed_part: {
			code: 'no_fixed_part', field: 'parts', blocking: true,
			message: 'Every part is fillable — the agent would choose the program itself. At least one fixed part is what makes this a command rather than a shell.'
		},
		undescribed_input: {
			code: 'undescribed_input', field: 'parts', blocking: true,
			message: 'An input slot has no hint. The agent is not told what belongs there.'
		},
		empty_menu: {
			code: 'empty_menu', field: 'parts', blocking: true,
			message: 'A menu slot has nothing on it.'
		},
		duplicate_slot: {
			code: 'duplicate_slot', field: 'parts', blocking: true,
			message: 'Two slots share a name. Arguments arrive positionally, so the manifest would describe one hole twice.'
		}
	};

	/**
	 * BASIC VALIDATION — the faults this object can see about itself, as codes.
	 *
	 * DELIBERATELY BASIC. It catches what is true of any command regardless of who is looking at it, and
	 * stops there. A surface with a narrower question — this chip, right now, as somebody types — writes its
	 * own check and reports it under the same code. That is the arrangement: the object owns the VOCABULARY,
	 * every consumer owns its own DETECTION, and neither has to know what the other checks.
	 *
	 * ONE OF EACH. A code names a CLASS of fault, so three undescribed slots raise it once — the surface
	 * drawing those slots is the one that knows which three, and it is already looking at them.
	 */
	getErrors(): CommandCode[] {
		const found: CommandCode[] = [];
		const names = new Set<string>();

		if( !this.name.trim() )   found.push( Command.NO_NAME );
		if( !this.intent.trim() ) found.push( Command.NO_INTENT );
		if( !this.parts.length )  found.push( Command.NO_COMMAND );

		if( this.parts.length && !this.parts.some( ( p ) => p.kind === 'literal' ) ) {
			found.push( Command.NO_FIXED_PART );
		}
		for( const p of this.fillable ) {
			if( names.has( p.name ) && !found.includes( Command.DUPLICATE_SLOT ) ) found.push( Command.DUPLICATE_SLOT );
			names.add( p.name );

			if( p.kind === 'input'  && !p.hint.trim()    && !found.includes( Command.UNDESCRIBED_INPUT ) ) found.push( Command.UNDESCRIBED_INPUT );
			if( p.kind === 'choice' && !p.options.length && !found.includes( Command.EMPTY_MENU )        ) found.push( Command.EMPTY_MENU );
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

	/** The parts an agent supplies a value for, in order. THE ORDER IS THE CONTRACT — a call passes an array
	 *  positionally ( `{ command: [ … ] }` ), so this is also the manifest's parameter list.
	 *
	 *  NARROWED, by predicate. Every caller wants a slot's `name`, and a caller re-proving that a list of
	 *  non-literals holds no literals is the type doing nothing useful twice. */
	get fillable(): readonly FillablePart[] {
		return this.parts.filter( ( p ): p is FillablePart => p.kind !== 'literal' );
	}

	/** The command as a person reads it — one line, fixed text plain, fillable parts marked. One place, so
	 *  no surface re-composes this and gets the spacing different somewhere else. */
	describe(): string {
		return this.parts.map( ( p ) => {
			if( p.kind === 'literal' ) return p.text;
			if( p.kind === 'input' )   return `«${ p.name }»`;
			return `[ ${ p.options.join( ' | ' ) }${ p.optional ? ' | —' : '' } ]`;
		} ).join( ' ' );
	}

	/**
	 * THE BLOCK THE AGENT IS HANDED — this command's entire tool description, and the only thing about it a
	 * model ever sees.
	 *
	 * TWO AUTHORS, AND THE SPLIT IS THE POINT. The judgement is a person's: `intent`, and the hint on every
	 * hole. The CALL SHAPE is generated from `parts`, because a human typing the argument list beside an array
	 * that already states it is a human maintaining a second copy — and the copy is what drifts. So a person
	 * cannot describe a parameter that does not exist, and cannot forget to describe one that does.
	 *
	 * Rendered verbatim in the editor while it is being written. A person authoring this is looking at the
	 * exact text the agent gets, gaps and all — no preview mode, no "roughly like this". The gaps are marked
	 * rather than filled in, and `getErrors()` is what decides whether the thing ever ships.
	 */
	manifest(): string {
		const slots = this.fillable.map( ( p ) => p.kind === 'choice'
			? `  ${ p.name } — one of: ${ p.options.join( ', ' ) }${ p.optional ? '   ( may be omitted )' : '' }`
			: `  ${ p.name } — ${ p.hint.trim() || '⚠ undescribed' }` );

		return [
			`${ this.name.trim() || '⚠ unnamed' }`,
			`${ this.intent.trim() || '⚠ no intent authored — this command is a draft' }`,
			``,
			`Runs: ${ this.describe() }`,
			slots.length ? `Arguments, in order:` : `Takes no arguments.`,
			...slots
		].join( '\n' );
	}

	/**
	 * WHAT IS WRONG WITH THESE VALUES — every fault, not the first.
	 *
	 * ALL OF THEM, deliberately. The gate emits ONE verdict, so an agent told about one bad character at a
	 * time would round-trip once per character while a person watches it flail. Finding everything costs
	 * nothing and turns three refusals into one.
	 *
	 * An empty array means nothing is wrong with the values. It does NOT mean the call may proceed — that
	 * sentence has one author and it is not this class.
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
	 * ONE SLOT, ONE VALUE. Public because an authoring surface wants exactly this as somebody types, and a
	 * second copy of these rules living in a component is how the field a person tests against and the check
	 * that actually runs start disagreeing.
	 *
	 * Ordered so the most specific fault is the one reported. A part may narrow further with its own
	 * `pattern`; nothing may widen past the control and flag checks, which are the two that bite even with
	 * no shell anywhere on the path.
	 */
	inspectPart( part: CommandPart, value: string ): CommandFault | null {
		if( part.kind === 'literal' ) return null;

		if( part.kind === 'choice' ) {
			const allowed = part.options.join( ', ' );
			if( !value ) return part.optional ? null : { code: 'missing_value', part: part.name, detail: allowed };
			if( !part.options.includes( value ) ) return { code: 'not_an_option', part: part.name, detail: allowed };
			return null;
		}

		if( !value )                 return { code: 'missing_value',     part: part.name, detail: part.hint };
		if( value.length > MAX_LEN ) return { code: 'too_long',          part: part.name, detail: `${ value.length } of ${ MAX_LEN }` };
		if( CONTROL.test( value ) )  return { code: 'control_character', part: part.name, detail: '' };
		if( FLAGLIKE.test( value ) ) return { code: 'flag_like',         part: part.name, detail: '-' };

		const shellish = value.match( SHELLISH );
		if( shellish ) return { code: 'shell_character', part: part.name, detail: shellish[ 0 ] };

		if( part.pattern && !new RegExp( part.pattern ).test( value ) ) {
			return { code: 'pattern_mismatch', part: part.name, detail: part.pattern };
		}
		return null;
	}

	/**
	 * THE ARGV, built from an agent's positional values.
	 *
	 * IT THROWS ON A FAULT, AND THAT IS AN ASSERTION RATHER THAN A GATE. Reaching here with a faulty value
	 * means the call was never inspected, which means something bypassed the checkpoint — so it fails loud
	 * instead of building a command line nobody vetted. The throw is not the refusal path; the refusal path
	 * is a verdict, and by the time anything calls this the verdict was already yes.
	 */
	argv( values: readonly string[] ): string[] {
		const faults = this.inspect( values );
		if( faults.length ) {
			throw new Error( `WARNING — argv() reached with ${ faults.length } uninspected fault(s) on "${ this.name }": `
				+ faults.map( ( f ) => `${ f.part || 'call' }/${ f.code }` ).join( ', ' )
				+ '. The checkpoint was bypassed; nothing was run.' );
		}

		const out: string[] = [];
		let i = 0;
		for( const part of this.parts ) {
			if( part.kind === 'literal' ) {
				out.push( part.text );
				continue;
			}
			const value = values[ i++ ] ?? '';
			if( value ) out.push( value );
		}
		return out;
	}

	serialize(): SerializedCommand {
		return { name: this.name, intent: this.intent, parts: [ ...this.parts ] };
	}

	static fromSerialized( json: SerializedCommand ): Command {
		return new Command( json.name, json.intent ?? '', json.parts ?? [] );
	}
}
