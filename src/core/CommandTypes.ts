/**
 * The argument types: what a hole in a command line may hold, and the logic that decides it. Each type owns its
 * logic and words, so a type cannot exist without its check. There is no free-text type: a blacklist is the bet
 * a shell makes, that every dangerous spelling was thought of. `normalize` runs before `validate`, and its output is what runs.
 * A type narrows and never widens the control, length and leading-dash checks in `Command.inspectPart`.
 */

/** A hole an agent fills. The union rather than a bare string is the point: adding a type is a word here
 *  plus a row in `PART_TYPES`, and the compiler finds every place that must learn it. */
export type FillKind = 'file_path' | 'folder_path';

/** Every kind a part may be: the author's own fixed text, a typed hole, or a part carried forward from a
 *  retired kind. `retired` is not authorable — see `Command.fromSerialized`. */
export type PartKind = 'literal' | FillKind | 'retired';

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
 * One type, whole. `describe` is the sentence an agent reads in the manifest, so a hole needs no hand-written
 * hint: the type already says what belongs there.
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
	 * Clean a value before it is judged or run. Total and idempotent: it must not reject, since rejecting
	 * is `validate`'s job.
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

/** Characters Windows forbids in a filename. Narrower than a shell blacklist on purpose: `(`, `$`, `%`, `^`
 *  and `&` are legal in real paths. */
const ILLEGAL_IN_PATH = /["*?<>|]/;

/** A drive at the head of a path, which is the ONE place a colon is legal. `a:b` is not a path. */
const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

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

			// A trailing separator denotes a folder, so it cannot satisfy a file hole. This is the rule that separates the two rows.
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

		/** The shared de-escape, with a trailing separator dropped so a folder compares equal with or without one.
		 *  A root keeps its separator: `C:\` stripped is drive-relative, and `/` stripped is nothing. */
		normalize: ( raw ) => {
			const v = _dePath( raw );
			if( /^[A-Za-z]:[\\/]$/.test( v ) || v === '/' || v === '\\' ) return v;
			return v.replace( /[\\/]+$/, '' );
		},

		/** Shared syntax only. Existence is not answerable without disk: a missing directory fails at `spawn`, in the OS's own words. */
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
