import { partType, type FillKind } from './CommandTypes';

export type { FillKind, PartKind, PartType } from './CommandTypes';
export { PART_TYPES, FILL_KINDS, partType } from './CommandTypes';

/**
 * ONE PART OF A COMMAND LINE — and the reason a command is an ARRAY rather than a string.
 *
 * A template with slots is still a string, so something has to parse it, and a parser is where the bugs
 * live. An array of parts is an argv: it is handed to `spawn` with NO SHELL, so `;` `&&` `|` backtick and
 * `$( )` are not dangerous characters that must be caught — they are ordinary letters inside one argument,
 * because nothing on the path ever interprets them. Chaining is not forbidden, it is UNREPRESENTABLE, and
 * a path with spaces needs no quoting because it was never adjacent to anything to be confused with.
 *
 * That is the whole trade: structural impossibility instead of correct escaping. The guards are then
 * defence in depth rather than the mechanism, which is the right way round — a mechanism that depends on
 * catching every bad character is one missed character from being no mechanism at all.
 *
 * ── TWO STRUCTURAL KINDS, AND A VOCABULARY OF TYPES INSIDE ONE OF THEM ── ( Bryan, 2026-09-27 )
 * There were three kinds and they were named `fix`, `in` and `pick` on the authoring surface. Nobody could
 * tell from that what any of them did, and worse, `in` applied ONE blanket character rule to every value —
 * so a file path, the commonest thing anybody wants a hole to hold, was refused for containing `(`.
 *
 *   literal   fixed text the author wrote. The binary, its subcommands, flags that must not vary. Never
 *             appears in the agent's schema; an agent cannot reach it, change it or remove it.
 *   a TYPE    a hole the agent fills, named by WHAT IT HOLDS — `text`, `file_path` — with the validation
 *             for it owned by that type's row in `PART_TYPES`, not by a shared ladder.
 *   retired   a part carried forward from a kind that no longer exists. Not authorable, never run; it
 *             blocks the command so a person re-authors it. See `fromSerialized`.
 *
 * The structural half of the distinction is what the security property rests on and it has NOT moved: the
 * first part must be a literal, so an agent never chooses the program. A type only ever decides what may go
 * in a hole a person already decided to leave.
 */
export type CommandPart =
	| { kind: 'literal'; text: string }
	| { kind: FillKind;  name: string; optional?: boolean }
	| { kind: 'retired'; was: string };

/** A part an agent fills — every kind that carries a `name`. Named so `fillable` can hand back something
 *  already narrowed rather than making each caller re-establish it. */
export type FillablePart = Extract<CommandPart, { name: string }>;

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
 *
 * `undescribed_input` AND `empty_menu` ARE GONE ( Bryan, 2026-09-27 ). The first was unclearable — a hole's
 * `hint` had no control on any surface, so every command with a hole was a permanent draft that no agent was
 * ever offered. Naming the TYPE is what a hint was for, and the type is now on the part itself. The second
 * went with the menu kind it described.
 */
export type CommandCode =
	| 'no_name'
	| 'no_intent'
	| 'no_command'
	| 'no_fixed_part'
	| 'duplicate_slot'
	| 'retired_part';

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
	/** Stops it being handed to an agent. A non-blocking code is a remark — `no_intent` is the first and so
	 *  far only one ( Bryan, 2026-09-28 ), which is what the flag was put here in anticipation of. */
	blocking: boolean;
}

/**
 * A COMMAND — a command line a person authored, exposed to an agent as a tool.
 *
 * ── DECLARED RATHER THAN TYPED, AND THAT IS THE WHOLE IDEA ──
 * A shell is unsafe because it is UNAUDITABLE: one string can be anything, so there is no honest gate to
 * put in front of it and no review that means anything. A command inverts exactly that — fixed parts,
 * typed fillable ones, reviewed once by a person and gated forever after like any other tool. This is the
 * shape that makes shell-adjacent capability governable, rather than the shape that gives up and ships a
 * terminal.
 *
 * THIS IS A PRIVILEGED PIPE INTO A COMMAND LINE and is treated as one. The parts array removes the class of
 * bug rather than defending against it, and inspection is ruthless about the rest — one character a type
 * dislikes is a fault, because the cost of a false finding is an author picking a different type and the
 * cost of a false clean bill is arbitrary execution.
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

/** Characters that end the call whatever a part's type says, because they break the argv itself rather than
 *  merely looking dangerous: NUL, newline, carriage return, tab and the rest of the C0 range. Newline is
 *  not theoretical — the npm/npx shims truncate an argument at the first one, silently. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** No argument may pass itself off as a flag. This is the injection that survives having no shell at all:
 *  `-rf`, `--config=…`, `--exec`. An author who genuinely wants a flag writes it as a literal part. */
const FLAGLIKE = /^-/;

/** A cap, because an unbounded argument is a way to make something else fall over. */
const MAX_LEN = 512;

/**
 * SPLIT ONE LITERAL INTO ARGV ELEMENTS — and the asymmetry that makes it safe.
 *
 * ── THE RULE, IN ONE SENTENCE ──
 * A literal splits on whitespace. An agent's value NEVER splits.
 *
 * That asymmetry is the whole security story of this function. Splitting the author's own fixed text is
 * reading it the way they wrote it: they typed `npm run typecheck` because that is the command line they
 * know, and three argv elements is what they meant. Never splitting an agent's value is what stops a
 * `file_path` from smuggling a second argument — a path with spaces in it stays exactly one element, always,
 * so `--config x` cannot arrive through a hole that was authored to hold a filename.
 *
 * ── WHY IT EXISTS ──
 * Before this, a literal WAS one argv element, so a person authoring `npm run typecheck` in one field
 * produced `argv[0] = "npm run typecheck"` and `BinaryResolver` went looking for a program with spaces in
 * its name. The message read "not on this machine's PATH", which was true and told nobody anything: a person
 * types a command line, and being told their command line is not a program is not a sentence they can act
 * on.
 *
 * ── QUOTES, AND WHY THIS IS NOT THE PARSING WE REFUSE ──
 * A fixed argument may legitimately contain a space — `C:\Program Files\node\node.exe` is the commonest
 * argv[0] on Windows — so double or single quotes hold a run together. That IS a small parser, and the
 * reason it is admissible where parsing an agent's input is not: this reads the AUTHOR's own text, and the
 * author is the person the whole design trusts. Nothing here ever touches a value that came from a model.
 *
 * STILL OWED: the editor does not yet DRAW the split. `describe()` prints a literal's text verbatim, so a
 * person authoring `node -e process.stdout.write( 1 )` sees it as one line and cannot see that it became six
 * arguments. Showing the resolved argv beside the strip is what makes a mis-parse visible at the keyboard,
 * and until it lands the quoting rule is something an author has to know rather than something they can see.
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
	 * THE TOOL NAME AN AGENT SEES — always lower case, canonicalized by the constructor.
	 *
	 * ── WHY THE MODEL FORCES IT RATHER THAN A SURFACE VALIDATING IT ── ( Bryan, 2026-09-27 )
	 * A command is matched by name in several places and stamped by name in one more: the roster looks one up,
	 * the manifest prints it, and the permission table fans a policy per command using the name as the gate's
	 * SUBJECT. Case-folding some of those comparisons and not others is how a command runs under a policy set
	 * for a differently-spelled version of itself, so the ambiguity is removed at the source instead — there
	 * is only ever one spelling to compare.
	 *
	 * Canonicalized HERE, in the constructor, because `fromSerialized` routes through it: a roster written
	 * before this rule reads back canonical without a migration, and every surface that rebuilds a Command
	 * from the wire gets the same answer as the one that authored it.
	 */
	readonly name: string

	constructor(
		name: string,
		/**
		 * WHEN TO REACH FOR THIS — authored by a person, and the only sentence an agent reads before deciding
		 * to call it. Not "what it does": the command line already says that, and an agent can read it. This is
		 * the judgement a person has and a model does not — that `check_types` is the thing to run after an
		 * edit and before claiming the edit worked.
		 *
		 * AUTHORED, NEVER DERIVED ( Bryan, 2026-08-22 ). Everything else about a command can be produced from
		 * its parts. This cannot, and a generated stand-in would be worse than an empty one: an empty intent is
		 * visibly missing, and a plausible sentence assembled from the binary's name reads as though somebody
		 * decided it. That rule is untouched by everything below — the choice is between a person's sentence
		 * and NO sentence, and it is never between a person's sentence and a machine's.
		 *
		 * OPTIONAL ( Bryan, 2026-09-28 ). "Agents don't need context to know when to type check." Requiring
		 * this made a command with no intent a DRAFT, which is a blocking state: the manifest filtered it out
		 * and `CommandService.run` refused it as `unfinished_draft`. So the commonest command anybody authors
		 * — one binary, one subcommand, no holes, nothing to explain — could not be used at all until a
		 * sentence was invented for it, and an invented sentence is the thing the paragraph above refuses.
		 *
		 * `Command.NO_INTENT` SURVIVES AS AN ADVISORY rather than being deleted. The nudge is still worth
		 * making for the command where the judgement genuinely is not obvious; what changed is that it no
		 * longer pins the command. And the manifest prints NOTHING where an empty intent would go — see
		 * `manifest()`, where a warning string was once handed to a model as though it were guidance.
		 */
		readonly intent: string = '',
		/**
		 * THE COMMAND LINE, in order, as parts. Never a string: see `CommandPart`.
		 *
		 * Held verbatim so a reviewer reads exactly what will run — the same array the surface draws and the
		 * agent's manifest line is generated from, so a person approving a command and an agent calling it
		 * cannot be looking at two different things.
		 *
		 * ONE PART IS NOT ONE ARGV ELEMENT ( Bryan, 2026-09-27 ). A literal splits on whitespace, so
		 * `npm run typecheck` is one part and three arguments. A FILLED part is always exactly one element,
		 * whatever it contains. `argv()` is where that happens and `commandWords` is why.
		 */
		readonly parts: readonly CommandPart[] = []
	) {
		this.name = Command.normalizeName( name );
	}

	/**
	 * THE ONE SPELLING OF A COMMAND'S NAME — trimmed and lower-cased.
	 *
	 * A SINGLE AUTHOR for the rule, so the roster, the manifest, the gate's subject and any surface that
	 * displays one cannot disagree about what a command is called. An authoring surface may call this to show
	 * a person what their name will become; nothing needs to call it to COMPARE, because every `Command`
	 * already holds a canonical name.
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

	/** THE DIRECTORY. One row per code, and the only place any of this is worded. */
	static readonly CODES: Readonly<Record<CommandCode, CommandCodeInfo>> = {
		no_name: {
			code: 'no_name', field: 'name', blocking: true,
			message: 'No name. An agent calls this by name and has nothing to call.'
		},
		/*
		 * ADVISORY, NOT BLOCKING ( Bryan, 2026-09-28 ). "Agents don't need context to know when to type
		 * check." A command whose line is self-evident is a usable command, and pinning it as a draft made
		 * the commonest thing anybody authors — one binary, one subcommand, no holes — unreachable until
		 * somebody wrote a sentence nobody needed.
		 *
		 * KEPT RATHER THAN DELETED, because the nudge is still worth making. A command whose judgement is
		 * NOT self-evident is the case intent exists for, and a surface that says nothing about the empty
		 * field stops asking the question entirely. Non-blocking is exactly the shape for that: the editor
		 * still remarks on it, `ready` does not care, the manifest offers the command, and nothing refuses
		 * to run it.
		 */
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
	 * ONE OF EACH. A code names a CLASS of fault, so three retired parts raise it once — the surface drawing
	 * those parts is the one that knows which three, and it is already looking at them.
	 */
	getErrors(): CommandCode[] {
		const found: CommandCode[] = [];
		const names = new Set<string>();

		if( !this.name.trim() )   found.push( Command.NO_NAME );
		if( !this.intent.trim() ) found.push( Command.NO_INTENT );
		if( !this.parts.length )  found.push( Command.NO_COMMAND );

		/*
		 * THE FIRST PART, not merely SOME part — corrected 2026-09-27.
		 *
		 * This tested `some( literal )` while its own message said "the agent would choose the program
		 * itself", and those are not the same rule. `«tool» --version` carries a fixed part and passed,
		 * which handed argv[0] — THE PROGRAM — to whichever agent called it. That is the one thing this
		 * whole design rests on not being possible: everything an agent can run is chosen at a person's
		 * keyboard, and a command whose binary is a hole is a shell with extra steps.
		 *
		 * Strictly stronger than what it replaces: a command with no literal anywhere has no literal
		 * first either, so every case the old predicate caught is still caught.
		 */
		/*
		 * AND IT MUST CONTRIBUTE A WORD — added 2026-09-27, with the literal split.
		 *
		 * Once a literal splits on whitespace it can contribute ZERO argv elements: `{ literal: '' }`, or one
		 * holding only spaces. A command whose first part was an empty literal followed by a hole would build
		 * an argv whose FIRST element came from the agent — reopening, through a blank field, the exact hole
		 * `no_fixed_part` exists to close. Being a literal is no longer sufficient; it has to actually say
		 * something.
		 */
		const first = this.parts[ 0 ];
		if( this.parts.length && ( first?.kind !== 'literal' || !commandWords( first.text ).length ) ) {
			found.push( Command.NO_FIXED_PART );
		}

		if( this.parts.some( ( p ) => p.kind === 'retired' ) ) found.push( Command.RETIRED_PART );

		for( const p of this.fillable ) {
			if( names.has( p.name ) && !found.includes( Command.DUPLICATE_SLOT ) ) found.push( Command.DUPLICATE_SLOT );
			names.add( p.name );
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
	 *  positionally, so this is also the manifest's parameter list.
	 *
	 *  NARROWED, by predicate. Every caller wants a slot's `name`, and a caller re-proving that a list of
	 *  non-literals holds no literals is the type doing nothing useful twice. */
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
	 * THE ARGV, AS FAR AS IT CAN BE KNOWN BEFORE A CALL — one entry per argument, holes marked.
	 *
	 * WHY A SURFACE NEEDS THIS. `describe()` prints a literal verbatim, so `node -e process.stdout.write( 1 )`
	 * reads as one line and is silently five arguments. An author cannot see the whitespace split from the
	 * strip, which makes the quoting rule something they have to KNOW rather than something they can check —
	 * and the failure it produces arrives much later, from a program complaining about arguments nobody meant
	 * to send.
	 *
	 * So this is `argv()` minus the values: the same `commandWords` split over the same literals, with each
	 * hole standing in for what an agent will supply. One implementation, because a surface computing its own
	 * would be a second opinion about the thing the author is checking.
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
	 * THE BLOCK THE AGENT IS HANDED — this command's entire tool description, and the only thing about it a
	 * model ever sees.
	 *
	 * TWO AUTHORS, AND THE SPLIT IS THE POINT. The judgement is a person's: `intent`, and the choice of type
	 * on every hole. The CALL SHAPE is generated from `parts`, because a human typing the argument list beside
	 * an array that already states it is a human maintaining a second copy — and the copy is what drifts. So a
	 * person cannot describe a parameter that does not exist, and cannot forget to describe one that does.
	 *
	 * A HOLE'S DESCRIPTION COMES FROM ITS TYPE ( Bryan, 2026-09-27 ), not from a hand-written hint. The hint
	 * was the one field no surface ever gave a person a control for, so it was always empty and the command
	 * was always a draft. Picking `file_path` says everything a sentence was going to say, and cannot be
	 * left blank.
	 *
	 * Rendered verbatim in the editor while it is being written. A person authoring this is looking at the
	 * exact text the agent gets, gaps and all — no preview mode, no "roughly like this".
	 */
	manifest(): string {
		const slots = this.fillable.map( ( p ) => {
			const type = partType( p.kind );
			return `  ${ p.name } — ${ type?.describe ?? p.kind }${ p.optional ? '   ( may be omitted )' : '' }`;
		} );

		/*
		 * NO INTENT MEANS NO LINE — not a line saying there is no intent ( Bryan, 2026-09-28 ).
		 *
		 * This printed `⚠ no intent authored — this command is a draft` in the intent's place, which was
		 * harmless only for as long as an intent-less command was filtered out before any model saw it. It
		 * is not filtered out any more, so that string would be delivered INTO an agent's tool description
		 * in the one slot reserved for a person's judgement — a defect report read as guidance.
		 *
		 * Nor a neutral stand-in like "no guidance authored", which is the tempting compromise and is worse
		 * than silence: it spends a line telling a model about the authoring process rather than about the
		 * command. The point of the ruling is that some commands need no explanation, and the manifest
		 * should LOOK like that.
		 */
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
	 * THE VALUES AS THEY WILL ACTUALLY RUN — each one put through its slot's type, in ONE place.
	 *
	 * THE ONLY NORMALIZATION POINT, and that is a security property rather than tidiness. If validation read
	 * a raw value while argv received a cleaned one, the string that was judged and the string that runs would
	 * be different — validate-then-mutate, which is how a check gets passed by a value that never faced it.
	 * `inspect` and `argv` both come through here.
	 */
	filled( values: readonly string[] ): string[] {
		return this.fillable.map( ( part, i ) => {
			const raw  = values[ i ] ?? '';
			const type = partType( part.kind );
			return type ? type.normalize( raw ) : raw;
		} );
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
	 * NORMALIZES FIRST, so this answers about the string that would RUN rather than the one that was typed —
	 * which is what makes it safe for a surface to call with a raw value and get the real answer. The type's
	 * `normalize` is idempotent, so `inspect` calling this and `filled` normalizing again agree.
	 *
	 * Ordered so the most specific fault is the one reported. A type may narrow; nothing may widen past the
	 * control, length and flag checks, which are the three that bite even with no shell anywhere on the path.
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
	 * THE WIRE FORM — and it is PLAIN DATA all the way down, rebuilt rather than spread ( 2026-09-28 ).
	 *
	 * This spread `this.parts` into a new array, which copies the element REFERENCES. A renderer that had
	 * let a `Command` be deep-proxied by Vue therefore handed a fresh array of reactive Proxies into an IPC
	 * payload, where structured clone refuses them — and the caller's save vanished with no error anybody
	 * saw. That happened, cost a defect, and the comment warning about it sat one layer away from the
	 * mistake in a component that was already obeying it.
	 *
	 * So the invariant is enforced where the wire form is MADE rather than asked of every surface that
	 * builds one. Each part is rebuilt as a literal, so whatever wrapper a caller's framework put around it
	 * is left behind here and cannot cross.
	 */
	serialize(): SerializedCommand {
		const parts = this.parts.map( ( p ): CommandPart => {
			if( p.kind === 'literal' ) return { kind: 'literal', text: p.text };
			if( p.kind === 'retired' ) return { kind: 'retired', was: p.was };
			// `optional` only when it is actually set — a key carrying `undefined` is a key, and it would
			// turn an equality check between a stored row and a round-tripped one into a puzzle.
			return p.optional ? { kind: p.kind, name: p.name, optional: true } : { kind: p.kind, name: p.name };
		} );
		return { name: this.name, intent: this.intent, parts };
	}

	/**
	 * REBUILD FROM STORAGE OR THE WIRE.
	 *
	 * A PART OF A KIND THAT NO LONGER EXISTS IS KEPT, VISIBLY BROKEN ( Bryan, 2026-09-27 ). The `choice` kind
	 * was retired with the three-kind vocabulary, and a roster written before that may hold one. The three
	 * ways to handle that are to crash, to guess, or to say so, and only the last is honest: guessing would
	 * silently change what a privileged command runs — turning a menu into whichever option happened to be
	 * first is a different command line than the one somebody reviewed.
	 *
	 * So it becomes a `retired` part, which blocks the command. Nothing runs, nothing is offered to an agent,
	 * the roster still loads, and the surface shows a person exactly which part to replace.
	 */
	static fromSerialized( json: SerializedCommand ): Command {
		const parts = ( json.parts ?? [] ).map( ( p ): CommandPart => {
			const kind = ( p as { kind?: string } ).kind ?? '';
			if( KNOWN_KINDS.includes( kind ) ) return p;
			return { kind: 'retired', was: kind || 'unnamed' };
		} );
		return new Command( json.name, json.intent ?? '', parts );
	}
}
