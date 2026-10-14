/**
 * The argument types: what a hole in a command line may hold, and the logic that decides it. Each type owns its
 * logic and words, so a type cannot exist without its check. `normalize` runs before `validate`, and its output is
 * what runs. A type narrows and never widens the control, length and leading-dash checks in `Command.inspectPart`.
 *
 * ── WHERE THE SAFETY ACTUALLY COMES FROM ── ( stated here because this file looks like the answer and is not )
 * It comes from `Command.argv` being handed to `spawn` with `shell: false`: every element is ONE argument, and
 * there is no interpreter for `;` `&&` `|` or `$( )` to reach. These checks are DEFENCE IN DEPTH over that
 * property, never a substitute for it. That is the whole reason a `text` type is admissible at all — a free-text
 * blacklist is the bet a shell makes, that every dangerous spelling was thought of, and it is a bet this design
 * does not need to take. If any code path ever builds a single command STRING and hands it to a shell, nothing in
 * this file is worth anything.
 */

/**
 * A hole an agent fills. The union rather than a bare string is the point: adding a type is a word here plus a row
 * in `PART_TYPES`, and the compiler finds every place that must learn it.
 *
 * SPLIT IN TWO because the halves carry different declarations. A PATH kind is judged at a filesystem rung and so
 * must declare `access`; a VALUE kind reaches no disk and has nothing to declare a rung for. One union with an
 * optional `access` would make a forgotten annotation on a path hole indistinguishable from a value hole, which is
 * exactly the silent grant `no_access` exists to prevent.
 */
export type PathKind  = 'file_path' | 'folder_path' | 'res_path';
export type ValueKind = 'int' | 'enum' | 'text';
export type FillKind  = PathKind | ValueKind;

/** Every kind a part may be: the author's own fixed text, a typed hole, or a part carried forward from a
 *  retired kind. `retired` is not authorable — see `Command.fromSerialized`. */
export type PartKind = 'literal' | FillKind | 'retired';

/** Is this a kind judged at a filesystem rung? The one question that decides whether `access` is required, asked
 *  by a function rather than spelled inline, because a rule written at N sites holds at some of them. */
export function isPathKind( kind: string ): kind is PathKind {
	return kind === 'file_path' || kind === 'folder_path' || kind === 'res_path';
}

/**
 * What the program does with the path a hole holds, declared by the author beside the hole. The type says a value
 * is shaped like a path, not what the binary does with it, so inferring this from the command line was declined:
 * deciding that `>` means write is a parser with wrong edges. Required with no default, since a default of `read`
 * would make a forgotten annotation a silent grant. This is the author's intent; nothing verifies the binary agrees.
 */
export type PathAccess = 'read' | 'write' | 'delete';

/** One access level, whole, as `PartType` is. Named `…Info` and not `AccessLevel`: the SDK already exports
 *  `AccessLevel` and `ACCESS_LEVELS` through this barrel, and a same-named pair is an ambiguous star re-export
 *  that TypeScript drops entirely. */
export interface PathAccessInfo {
	level: PathAccess;
	/** What an author picks it by. */
	label: string;
	/** What the author is told this declaration means — and that it is believed. */
	note: string;
}

export const PATH_ACCESS: Readonly<Record<PathAccess, PathAccessInfo>> = {

	read: {
		level: 'read',
		label: 'reads it',
		note:  'The program only READS this path. Judged at the read rung — the right level for a typecheck, a lint or a test run.'
	},

	write: {
		level: 'write',
		label: 'writes it',
		note:  'The program WRITES to this path. Judged at the write rung, so the hole is unusable unless the agent can already write there.'
	},

	delete: {
		level: 'delete',
		label: 'removes it',
		note:  'The program REMOVES this path. Judged at the delete rung, which no grant can ever reach — only configured access.'
	}
};

/** The rows, in the order an author is offered them — shallowest first, so the commonest answer is the
 *  first one read rather than the one a tired author scrolls past. */
export const PATH_ACCESS_LEVELS: readonly PathAccess[] = [ 'read', 'write', 'delete' ];

/** Is this an access level at all? The runtime half of the required field, for data that reached here
 *  from storage or the wire without passing a compiler. */
export function isPathAccess( value: unknown ): value is PathAccess {
	return value === 'read' || value === 'write' || value === 'delete';
}

/**
 * ONE PART OF A COMMAND LINE. A command is an ARRAY because an argv handed to `spawn` with no shell makes `;` `&&`
 * `|` and `$( )` ordinary letters: chaining is UNREPRESENTABLE, and the guards are defence in depth.
 *
 * A part is a `literal` (fixed text an agent never reaches), a TYPE (a hole the agent fills, validated by its
 * `PART_TYPES` row) or `retired` (blocks the command until re-authored). A PATH hole declares `access`, never
 * defaulted; a VALUE hole declares its own bound instead. The first part is always a literal, so an agent never
 * chooses the program.
 *
 * ── `prefix`: THE AUTHOR'S TEXT GLUED TO THE VALUE, IN ONE ARGV ELEMENT ──
 * A literal part splits on whitespace, so `-gdir=` beside a hole becomes TWO arguments and a CLI expecting
 * `-gdir=res://test` receives an empty flag followed by a stray path. `prefix` is the author's fixed text joined to
 * the value with no separator, producing exactly one element. It is author text and an agent cannot reach it, so it
 * is not judged; the VALUE half is judged exactly as it would be without one, which is why the leading-dash check
 * stays intact — the dash belongs to the prefix, never to anything a model wrote.
 */
/** What every path hole carries, shared by the three members below so the shape is written once. Not exported: a
 *  consumer wants `FillablePathPart`, which is a part and carries its `kind`. */
interface PathHole {
	name: string;
	access: PathAccess;
	optional?: boolean;
	prefix?: string;
}

export type CommandPart =
	| { kind: 'literal'; text: string }
	/*
	 * THE THREE PATH MEMBERS ARE WRITTEN OUT, not folded into one `{ kind: PathKind; … }`.
	 *
	 * They were, and it does not narrow: TypeScript discriminates a union on a LITERAL tag, and a member tagged with
	 * a union of three literals is not one — so `part.kind === 'text'` left the path member in scope and reading
	 * `part.maxLength` would not compile anywhere. Three one-line members, one shared shape, and every reader gets
	 * narrowing from the ordinary `===` it would reach for anyway.
	 */
	| ( PathHole & { kind: 'file_path' } )
	| ( PathHole & { kind: 'folder_path' } )
	| ( PathHole & { kind: 'res_path' } )
	/** A bounded integer. `min` and `max` are required and `min` may not be negative: a negative value would be
	 *  refused as flag-like before any range check could admit it, so a negative bound is a hole nothing can fill. */
	| { kind: 'int'; name: string; min: number; max: number; optional?: boolean; prefix?: string }
	/** A closed choice. The highest-value type here: a flag authored as an enum is a pick from a list the author
	 *  wrote, rather than a string somebody has to reason about. */
	| { kind: 'enum'; name: string; options: readonly string[]; optional?: boolean; prefix?: string }
	/** Arbitrary content, capped. The ONLY type that admits it, and admissible only under the argv property above.
	 *  Not sanitised beyond the cap and the shared control-character check — sanitising free text is the trap. */
	| { kind: 'text'; name: string; maxLength: number; optional?: boolean; prefix?: string }
	| { kind: 'retired'; was: string };

/** A part an agent fills — every kind that carries a `name`. Named so `fillable` can hand back something
 *  already narrowed rather than making each caller re-establish it. */
export type FillablePart = Extract<CommandPart, { name: string }>;

/** A path hole, narrowed — what the reach check iterates, and the only shape that carries `access`. */
export type FillablePathPart = Extract<CommandPart, { kind: PathKind }>;

/**
 * Is this PART judged at a filesystem rung — the guard, as opposed to `isPathKind`, which answers about a bare
 * string. Both exist because they answer different questions and only this one narrows: TypeScript narrows a union
 * from a comparison on its discriminant, and a predicate over `part.kind` is not that — so `isPathKind( p.kind )`
 * leaves `p` the whole union and `p.access` does not compile. Every reader holding a part wants this one.
 */
export function isPathPart( part: CommandPart ): part is FillablePathPart {
	return isPathKind( part.kind );
}

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
	| 'not_a_folder_path'  // a directory slot given something that is not a directory path
	| 'not_a_res_path'     // a Godot slot given something that is not a res:// virtual path
	| 'not_an_integer'     // an int slot given something that is not a whole number
	| 'out_of_range'       // an int slot given a number outside its declared bounds
	| 'not_an_option'      // an enum slot given something that is not one of its literals
	| 'over_length';       // a text slot over ITS OWN declared cap, which is narrower than the global one

/**
 * One type, whole. `describe` is the sentence an agent reads in the manifest, so a hole needs no hand-written
 * hint: the type already says what belongs there.
 *
 * ── BOTH `describe` AND `validate` READ THE PART ── ( and that is why they are functions )
 * A bound belongs to the HOLE, not to the type: `1..600` and `1..200` are both `int`, and a type-level sentence
 * could only describe the kind while the manifest has to state the actual bound an agent must satisfy. The same
 * applies to the check — a bound nobody validates is documentation.
 */
export interface PartType {
	kind: FillKind;
	/** What an author picks it by. Plain words: the old labels were `in` and `pick`. */
	label: string;
	/** Whether this kind is judged at a filesystem rung, and therefore declares `access`. */
	path: boolean;
	/** What the author is told, in the surface, about what this accepts. */
	note: string;
	/** What the AGENT is told this hole wants, including the hole's OWN bound. Generated into the manifest line. */
	describe( part: FillablePart ): string;
	/**
	 * Clean a value before it is judged or run. Total and idempotent: it must not reject, since rejecting
	 * is `validate`'s job.
	 */
	normalize( raw: string ): string;
	/**
	 * What is wrong with this NORMALIZED value, as the offending detail, or null when nothing is. The
	 * fault CODE belongs to the type ( `fault` ), so a surface keys on a constant rather than on prose.
	 */
	validate( value: string, part: FillablePart ): string | null;
	/** The code a failed `validate` is reported under. */
	fault: CommandFaultCode;
}

/** Characters Windows forbids in a filename. Narrower than a shell blacklist on purpose: `(`, `$`, `%`, `^`
 *  and `&` are legal in real paths. */
const ILLEGAL_IN_PATH = /["*?<>|]/;

/** A drive at the head of a path, which is the ONE place a colon is legal. `a:b` is not a path. */
const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

/** The one scheme Godot addresses its own project by. Exported because main has to MAP it to a real path and
 *  must not re-spell it: two spellings is a check that passes on a string nothing runs. */
export const RES_SCHEME = 'res://';

/**
 * The de-escape every path type shares: a path quoted, or with doubled separators from JSON, is the same path.
 * One layer of quotes only, since unwrapping repeatedly would turn a suspicious value clean. Shared so no two
 * types disagree about what one string denotes.
 */
function _dePath( raw: string ): string {
	let v = raw.trim();

	// One matched pair, and only when it wraps the WHOLE value.
	if( v.length >= 2 && ( v[ 0 ] === '"' || v[ 0 ] === '\'' ) && v[ v.length - 1 ] === v[ 0 ] ) {
		v = v.slice( 1, -1 ).trim();
	}

	// A UNC path really does begin with two backslashes, so the head is held back before doubles are
	// collapsed and put on again after. Collapsing it would turn `\\server\share` into `\server\share`, a
	// different and non-existent location.
	const unc  = v.startsWith( '\\\\' ) || v.startsWith( '//' );
	const head = unc ? v.slice( 0, 2 ) : '';
	const rest = ( unc ? v.slice( 2 ) : v ).replace( /\\{2,}/g, '\\' ).replace( /\/{2,}/g, '/' );
	return head + rest;
}

/**
 * The syntax rules every path shares: what makes a string not a path, whatever it points to. This module sees
 * no disk, so a traversal is refused by shape; confinement needs a passport and is decided elsewhere.
 */
function _pathSyntax( value: string ): string | null {
	const illegal = ILLEGAL_IN_PATH.exec( value )?.[ 0 ];
	if( illegal ) return illegal;

	// The colon, minus the one legal position for it.
	if( value.replace( DRIVE, '' ).includes( ':' ) ) return ':';

	/* `..` is refused by whole segment, never substring: `..bashrc` climbs nowhere. This is not confinement;
	 * the reach check decides where a path may start. */
	if( value.split( /[\\/]/ ).includes( '..' ) ) return '..';

	return null;
}

/** The bound a part declares, read defensively: these fields reached here from storage and may be anything.
 *  A missing or malformed bound is a BLOCKING authoring fault ( `Command.getErrors` ), so this only has to
 *  avoid producing a check that silently admits everything. */
function _bound( part: FillablePart ): { min: number; max: number } {
	const min = part.kind === 'int' && Number.isFinite( part.min ) ? part.min : 0;
	const max = part.kind === 'int' && Number.isFinite( part.max ) ? part.max : -1;
	return { min, max };
}

function _options( part: FillablePart ): readonly string[] {
	return part.kind === 'enum' && Array.isArray( part.options ) ? part.options : [];
}

function _cap( part: FillablePart ): number {
	return part.kind === 'text' && Number.isFinite( part.maxLength ) ? part.maxLength : 0;
}

export const PART_TYPES: Readonly<Record<FillKind, PartType>> = {

	file_path: {
		kind:     'file_path',
		label:    'File path',
		path:     true,
		note:     'The agent writes a path to a FILE. Quotes around it and doubled backslashes are cleaned off first; wildcards, characters Windows forbids, any `..` segment, and a trailing separator are refused.',
		describe: () => 'a file path — absolute, or relative to the working directory',
		fault:    'not_a_file_path',

		normalize: _dePath,

		validate: ( value ) => {
			const syntax = _pathSyntax( value );
			if( syntax ) return syntax;

			// A trailing separator denotes a folder, so it cannot satisfy a file hole. This is the rule that separates the two rows.
			if( /[\\/]$/.test( value ) ) return 'trailing separator';

			return null;
		}
	},

	folder_path: {
		kind:     'folder_path',
		label:    'Folder path',
		path:     true,
		note:     'The agent writes a path to a DIRECTORY. Cleaned up exactly as a file path is; a trailing separator is allowed and removed. This is the type a working directory uses.',
		describe: () => 'a directory path — absolute, or relative to the working directory',
		fault:    'not_a_folder_path',

		/** The shared de-escape, with a trailing separator dropped so a folder compares equal with or without one.
		 *  A root keeps its separator: `C:\` stripped is drive-relative, and `/` stripped is nothing. */
		normalize: ( raw ) => {
			const v = _dePath( raw );
			if( /^[A-Za-z]:[\\/]$/.test( v ) || v === '/' || v === '\\' ) return v;
			return v.replace( /[\\/]+$/, '' );
		},

		/** Shared syntax only. Existence is not answerable without disk: a missing directory fails at `spawn`, in the OS's own words. */
		validate: _pathSyntax
	},

	/**
	 * A GODOT VIRTUAL PATH, and it cannot be collapsed into `file_path`.
	 *
	 * Godot's CLI takes `res://scenes/x.tscn` and not `D:\Code\Game\scenes\x.tscn`, so a real path here is simply
	 * the wrong argument — the engine resolves `res://` against the project it opened, and a filesystem path
	 * reaching that parameter does not fail cleanly, it addresses nothing.
	 *
	 * THIS FILE CHECKS THE SHAPE AND MAIN CHECKS THE GROUND. Mapping the virtual path to a real one, confirming it
	 * exists and confirming it sits inside the project are all disk questions, and this module sees no disk. What
	 * runs is the VIRTUAL form, passed through unchanged — mapping is for the reach check, never for the argv.
	 */
	res_path: {
		kind:     'res_path',
		label:    'Godot res:// path',
		path:     true,
		note:     'The agent writes a Godot VIRTUAL path — `res://scenes/x.tscn`, or `res://test/unit` for a directory. It is mapped to a real path to check it exists and sits inside the project, and then passed to the command in its res:// form, because that is what the engine resolves. Backslashes, `..` segments and a bare `res://` are refused.',
		describe: () => 'a Godot virtual path beginning `res://`, resolving to something inside the project',
		fault:    'not_a_res_path',

		/** The shared de-quote, then forward slashes collapsed. A trailing separator is kept: `res://test/unit/` and
		 *  `res://test/unit` are the same directory, and GUT is handed whichever the author's CLI wants. */
		normalize: ( raw ) => {
			let v = raw.trim();
			if( v.length >= 2 && ( v[ 0 ] === '"' || v[ 0 ] === '\'' ) && v[ v.length - 1 ] === v[ 0 ] ) {
				v = v.slice( 1, -1 ).trim();
			}
			// The scheme's own `//` is held back before doubles are collapsed, exactly as `_dePath` holds back a UNC head.
			if( !v.toLowerCase().startsWith( RES_SCHEME ) ) return v.replace( /\/{2,}/g, '/' );
			return RES_SCHEME + v.slice( RES_SCHEME.length ).replace( /\/{2,}/g, '/' );
		},

		validate: ( value ) => {
			if( !value.startsWith( RES_SCHEME ) ) return `does not begin "${ RES_SCHEME }"`;

			const rest = value.slice( RES_SCHEME.length );
			// A bare scheme addresses the project root, which is never a thing a command wants named.
			if( !rest ) return 'names nothing after the scheme';

			// Backslashes are refused outright rather than translated: a res:// path uses forward slashes, and
			// quietly converting one would mean judging a string the engine never sees.
			if( rest.includes( '\\' ) ) return '\\';

			const illegal = ILLEGAL_IN_PATH.exec( rest )?.[ 0 ];
			if( illegal ) return illegal;

			// No SECOND colon. The scheme's own is already behind us, so any remaining one is a drive letter or worse.
			if( rest.includes( ':' ) ) return ':';

			if( rest.split( '/' ).includes( '..' ) ) return '..';

			return null;
		}
	},

	/**
	 * A BOUNDED INTEGER. The bound is the type's whole content: an unbounded integer is a string of digits, and
	 * `--quit-after` taking one is how a smoke test becomes a hung lane.
	 *
	 * NON-NEGATIVE ONLY, and that is honest rather than restrictive: the shared leading-dash check refuses `-5`
	 * before any range check could admit it, so a negative bound would declare a hole nothing can fill.
	 * `getErrors` refuses a negative `min` at authoring time rather than leaving it to be discovered at a call.
	 */
	int: {
		kind:     'int',
		label:    'Whole number',
		path:     false,
		note:     'The agent writes a whole number, within the range you declare. Leading zeros and surrounding space are cleaned off. NEGATIVE NUMBERS CANNOT BE USED: a value beginning with `-` is refused as flag-like before the range is consulted, so the lowest bound you can set is 0.',
		describe: ( part ) => {
			const { min, max } = _bound( part );
			return `a whole number from ${ min } to ${ max }`;
		},
		fault:    'not_an_integer',

		/** Digits only after this, so leading zeros go: `007` and `7` are one argument, and two spellings of one
		 *  value is two strings a range check could disagree about. A value that is not digits is left alone for
		 *  `validate` to report — normalizing it would hide what the agent actually sent. */
		normalize: ( raw ) => {
			const v = raw.trim();
			if( !/^\d+$/.test( v ) ) return v;
			const stripped = v.replace( /^0+(?=\d)/, '' );
			return stripped;
		},

		validate: ( value, part ) => {
			if( !/^\d+$/.test( value ) ) return 'not a whole number';

			const { min, max } = _bound( part );
			const n = Number( value );
			// Beyond what a double represents exactly, so a comparison would be answering about a different number.
			if( !Number.isSafeInteger( n ) ) return 'larger than this can hold';
			if( n < min || n > max )         return `${ n } is outside ${ min }..${ max }`;
			return null;
		}
	},

	/**
	 * A CLOSED CHOICE — the type that removes most of the pressure for free text.
	 *
	 * A flag authored as an enum is a pick from a list the author wrote. Nothing has to reason about whether
	 * `--force` is safe here, because the author either put it in the list or did not, and a value off the list is
	 * refused by identity rather than by inspection. Matching is EXACT and case-sensitive: a CLI's flags are, and
	 * folding case here would admit a spelling the author did not approve.
	 */
	enum: {
		kind:     'enum',
		label:    'One of a list',
		path:     false,
		note:     'The agent picks exactly one of the literal strings you list. Matching is exact and case-sensitive. This is the right type for a flag or a mode — the value is one you wrote, so there is nothing to inspect.',
		describe: ( part ) => {
			const options = _options( part );
			return options.length ? `exactly one of: ${ options.join( ', ' ) }` : 'one of a list the author has not filled in';
		},
		fault:    'not_an_option',

		/** Trimmed and nothing else. The value has to equal a literal the author wrote, so any other cleaning
		 *  would be inventing a second spelling of an approved option. */
		normalize: ( raw ) => raw.trim(),

		validate: ( value, part ) => {
			const options = _options( part );
			if( options.includes( value ) ) return null;
			return options.length ? `not one of ${ options.join( ', ' ) }` : 'the author listed no options';
		}
	},

	/**
	 * ARBITRARY CONTENT, CAPPED — the only type that admits it, and the one that is safe for a reason outside this
	 * file. A commit message holding `; rm -rf /` is an odd commit message and nothing more, because `argv` is
	 * handed to `spawn` with `shell: false` and there is no interpreter for it to reach.
	 *
	 * SO IT IS NOT SANITISED, DELIBERATELY. Stripping characters from free text is the trap: it produces a value
	 * that differs from what the agent sent, reads as safety, and proves nothing — the shell that would have been
	 * the threat is already absent. The cap is here because an unbounded argument is a way to make something else
	 * fall over, and the shared control-character check stays because a newline breaks the ARGV itself: the npm and
	 * npx shims truncate an argument at the first one, silently. That is a transport fault, not a content judgement.
	 */
	text: {
		kind:     'text',
		label:    'Free text',
		path:     false,
		note:     'The agent writes anything, up to the length you declare. IT IS NOT FILTERED, and does not need to be: commands are spawned as an argument vector with no shell, so shell punctuation in here is just punctuation. Line breaks and other control characters ARE refused — they break the argument vector itself rather than being dangerous content. Keep the cap as low as the command really needs.',
		describe: ( part ) => `free text, at most ${ _cap( part ) } characters`,
		fault:    'over_length',

		/** Trimmed at the ends only. The inside is the agent's and is passed through byte for byte. */
		normalize: ( raw ) => raw.trim(),

		validate: ( value, part ) => {
			const cap = _cap( part );
			if( value.length > cap ) return `${ value.length } of ${ cap }`;
			return null;
		}
	}
};

/** The rows, in the order an author is offered them. A record has no order worth relying on. Paths first, since
 *  they are the older half and the commoner one; the value kinds after, closed choice before free text, because an
 *  author reading down the list should meet `enum` before it occurs to them to reach for `text`. */
export const FILL_KINDS: readonly FillKind[] = [ 'file_path', 'folder_path', 'res_path', 'enum', 'int', 'text' ];

/** The path half, for the surface that pairs a kind with an access level. */
export const PATH_KINDS: readonly PathKind[] = [ 'file_path', 'folder_path', 'res_path' ];

/** The row for a kind, or null for `literal` and `retired`, which are not fillable and have no validation
 *  of their own — a literal is the author's text and is never judged, a retired part is never run. */
export function partType( kind: PartKind ): PartType | null {
	return kind === 'literal' || kind === 'retired' ? null : PART_TYPES[ kind ];
}
