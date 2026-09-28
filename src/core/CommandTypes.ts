/**
 * THE ARGUMENT TYPES — what a hole in a command line may hold, and the logic that decides it.
 *
 * ── WHY A REGISTRY AND NOT A PILE OF `if`s ──
 * A command's parts used to be three opaque kinds — `fix`, `in`, `pick` — and the validation for all of
 * them lived in one `inspectPart` ladder that applied the same blanket character blacklist to every value.
 * That is wrong in both directions at once: too strict for a value whose legitimate form contains a
 * blacklisted character, and too vague for a person authoring one, who was told "in" and had to guess.
 *
 * So each type OWNS its own logic and its own words. A row below is the whole of a type: what an author
 * picks it by, what an agent is told to put there, how a value is cleaned up, and what makes one invalid.
 * Growing the vocabulary is adding a word to `FillKind` and a row here — the two edits sit next to each
 * other, so a type cannot exist without the logic that decides it.
 *
 * ── THERE IS DELIBERATELY NO FREE-TEXT TYPE ── ( Bryan, 2026-09-27 )
 * There was one, and it was the old `in` kind: any string, guarded by a blacklist of shell metacharacters.
 * It is gone, and not as a simplification — a blacklist is a claim that every dangerous spelling has been
 * thought of, which is the same bet a shell makes and the bet this whole design exists to refuse. An
 * agent-authored value is admissible only where "correct" has a definition somebody can write down.
 *
 * A file path has one. That is why it is the first type and, for now, the only one. A script path that must
 * sit inside a permitted folder would have one too; so would a port, or a member of a fixed menu. "Any
 * string a shell might accept" does not, and no amount of character-filtering gives it one.
 *
 * ── NORMALIZE, THEN VALIDATE, AND THE ORDER IS LOAD-BEARING ──
 * `normalize` runs first and its output is what gets validated AND what reaches argv. That ordering is the
 * only safe one: a validator that inspects a raw value while argv receives a cleaned one is checking a
 * string that never runs, which is the classic validate-then-mutate hole. `Command` normalizes in exactly
 * one place for exactly this reason — see `Command.filled`.
 *
 * ── WHAT A TYPE MAY NOT RELAX ──
 * Three checks sit ABOVE this registry in `Command.inspectPart` and no row here can widen them, because
 * they break the argv itself rather than merely looking dangerous: a control character ( the npm shims
 * truncate an argument at the first newline, silently ), the length cap, and a leading `-` ( the one
 * injection that survives having no shell at all ). A type narrows; it never widens.
 */

/** A hole an agent fills. The union rather than a bare string is the point: adding a type is a word here
 *  plus a row in `PART_TYPES`, and the compiler finds every place that must learn it. */
export type FillKind = 'file_path' | 'folder_path';

/** Every kind a part may be: the author's own fixed text, a typed hole, or a part carried forward from a
 *  retired kind. `retired` is not authorable — see `Command.fromSerialized`. */
export type PartKind = 'literal' | FillKind | 'retired';

/**
 * ONE TYPE, WHOLE. The display half is for the person authoring; `describe` is the sentence an agent reads
 * in the manifest, which is why a hole needs no hand-written hint — the type already says what belongs
 * there, and a per-hole sentence was a second copy of it that nobody could author anyway.
 */
export interface PartType {
	kind: FillKind;
	/** What an author picks it by. Plain words: the old labels were `in` and `pick`. */
	label: string;
	/** What the author is told, in the surface, about what this accepts. */
	note: string;
	/** What the AGENT is told this hole wants. Generated into the manifest line. */
	describe: string;
	/**
	 * Clean a value up before it is judged or run. Total and idempotent — it must not reject, because
	 * rejecting is `validate`'s job and a normalizer that threw would produce a fault with no code.
	 */
	normalize( raw: string ): string;
	/**
	 * What is wrong with this NORMALIZED value, as the offending detail, or null when nothing is. The
	 * fault CODE belongs to the type ( `fault` ), so a surface keys on a constant rather than on prose.
	 */
	validate( value: string ): string | null;
	/** The code a failed `validate` is reported under. */
	fault: 'not_a_file_path' | 'not_a_folder_path';
}

/** Characters Windows itself forbids in a filename. Four of them — `|`, `<`, `>` and `"` — are on any
 *  shell's interesting list too, so this rule is narrower than a blanket blacklist where it matters and
 *  wider only where a real filename needs it: `(`, `)`, `$`, `%`, `^` and `&` are ordinary characters in a
 *  real path ( `C:\Program Files (x86)`, `report (final).pdf` ) and the blanket rule refused all of them. */
const ILLEGAL_IN_PATH = /["*?<>|]/;

/** A drive at the head of a path, which is the ONE place a colon is legal. `a:b` is not a path. */
const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

/**
 * THE DE-ESCAPE, shared by every path-shaped type.
 *
 * A model hands a path back the way it has seen one written, which in practice means wrapped in quotes
 * ( because a path with a space is quoted everywhere a human writes one ) or with its separators doubled
 * ( because it travelled through JSON ). Both are the SAME path, and refusing them teaches an agent nothing
 * it can act on — it sent the right answer in a normal spelling.
 *
 * ONE LAYER OF QUOTES, not a loop. `""x""` is not a path anybody meant, and unwrapping repeatedly turns a
 * suspicious value into a clean one, which is the opposite of what a normalizer is for.
 *
 * SHARED rather than copied into each row, because a second de-escape that drifts from this one would mean a
 * file argument and a folder argument disagreed about what the same string denotes — and the one that got it
 * wrong would be the one nobody tested.
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
 * THE SYNTAX RULES EVERY PATH SHARES — what makes a string not a path at all, whatever it points to.
 *
 * Returns the offending detail, or null. Shared for the same reason `_dePath` is: these are facts about path
 * spelling rather than about files, and two copies would eventually disagree about one of them.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything about the filesystem. This module sees no disk, so a traversal has
 * to be refused by SHAPE, and whether a path is really a directory is a question for the process that
 * spawns. Confinement to a root is not here either — it needs a passport, and this needs nothing.
 */
function _pathSyntax( value: string ): string | null {
	const illegal = ILLEGAL_IN_PATH.exec( value )?.[ 0 ];
	if( illegal ) return illegal;

	// The colon, minus the one legal position for it.
	if( value.replace( DRIVE, '' ).includes( ':' ) ) return ':';

	/*
	 * `..` BY SEGMENT, never by substring. A file honestly named `..bashrc` or `a..b` carries the two
	 * characters and climbs nowhere; only a whole segment does.
	 *
	 * NOT THE SAME AS CONFINEMENT. This stops a path climbing out of wherever it starts; it does not decide
	 * where it may start, and an absolute path still goes wherever it says. Deciding that is the reach
	 * check's job, and it happens where a passport is in hand.
	 */
	if( value.split( /[\\/]/ ).includes( '..' ) ) return '..';

	return null;
}

export const PART_TYPES: Readonly<Record<FillKind, PartType>> = {

	file_path: {
		kind:     'file_path',
		label:    'File path',
		note:     'The agent writes a path to a FILE. Quotes around it and doubled backslashes are cleaned off first; wildcards, characters Windows forbids, any `..` segment, and a trailing separator are refused.',
		describe: 'a file path — absolute, or relative to the working directory',
		fault:    'not_a_file_path',

		normalize: _dePath,

		validate: ( value ) => {
			const syntax = _pathSyntax( value );
			if( syntax ) return syntax;

			// A TRAILING SEPARATOR MEANS A DIRECTORY, which is the one rule separating this row from the next.
			// A value ending in `\` denotes a folder in every spelling anybody uses, so accepting it here would
			// let a folder through a hole an author declared for a file — and the program on the other end
			// would then fail in its own words, about an argument rather than about the hole.
			if( /[\\/]$/.test( value ) ) return 'trailing separator';

			return null;
		}
	},

	folder_path: {
		kind:     'folder_path',
		label:    'Folder path',
		note:     'The agent writes a path to a DIRECTORY. Cleaned up exactly as a file path is; a trailing separator is allowed and removed. This is the type a working directory uses.',
		describe: 'a directory path — absolute, or relative to the working directory',
		fault:    'not_a_folder_path',

		/** The shared de-escape, plus the trailing separator a folder is allowed to carry — dropped, so `C:\x\`
		 *  and `C:\x` are one value rather than two that compare unequal downstream.
		 *
		 *  A ROOT KEEPS ITS SEPARATOR. `C:\` stripped to `C:` is a DRIVE-RELATIVE path, which resolves against
		 *  that drive's current directory and means something else entirely; `/` stripped to `''` is nothing at
		 *  all. Both are the one case where the trailing separator is load-bearing. */
		normalize: ( raw ) => {
			const v = _dePath( raw );
			if( /^[A-Za-z]:[\\/]$/.test( v ) || v === '/' || v === '\\' ) return v;
			return v.replace( /[\\/]+$/, '' );
		},

		/** THE SHARED SYNTAX RULES AND NOTHING MORE. Whether the directory EXISTS is not answerable here — this
		 *  module sees no disk — and it need not be: a working directory that is not there fails at `spawn`, in
		 *  the operating system's own words, which is a better sentence than one guessed at from a stat. */
		validate: _pathSyntax
	}
};

/** The rows, in the order an author is offered them. A record has no order worth relying on. */
export const FILL_KINDS: readonly FillKind[] = [ 'file_path', 'folder_path' ];

/** The row for a kind, or null for `literal` and `retired`, which are not fillable and have no validation
 *  of their own — a literal is the author's text and is never judged, a retired part is never run. */
export function partType( kind: PartKind ): PartType | null {
	return kind === 'literal' || kind === 'retired' ? null : PART_TYPES[ kind ];
}
