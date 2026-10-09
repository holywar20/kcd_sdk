import { ACCESS_LEVELS, accessRank, type AccessLevel } from '../session/InjectedItem';

/**
 * AccessPolicy — what a person configured, and the one place the stored shape is read. Node-free, so the renderer
 * draws this policy while the guards enforce it in two other processes: one shape, one parse.
 * A level is ORDERED, so illegal combinations cannot be written. Overlapping entries resolve to the HIGHEST level,
 * never the nearest: no most-specific override, so a person can predict the answer from two rows.
 * Tiers never merge: each seeds the next by copy, which is why highest-wins holds across them.
 * `origin` is a label that never enters resolution. Containment is not here: path math belongs to
 * `SdkFileAccess.resolveLevel`, which composes this.
 */

/** Who put a row here. Two states and no more — see `AccessEntry.origin`. */
export const ACCESS_ORIGINS = [ 'shipped', 'authored' ] as const;
export type AccessOrigin = typeof ACCESS_ORIGINS[ number ];

/** The origin an unmarked entry reads as: every row stored before this field was authored by a person, and reading
 *  those as shipped would relabel their configuration as the product's. */
export const DEFAULT_ORIGIN: AccessOrigin = 'authored';

/** One configured root and how deeply it may be reached. */
export interface AccessEntry {
	/** Absolute, or a `{ProjectRoot}`-tokenized form that the reader expands before use. */
	path:  string;
	level: AccessLevel;

	/** Whether Starmind SHIPPED this row or a person AUTHORED it: a label that never enters resolution.
	 *  Reach for a level in a guard, never this; read through `originOf`, since absent is not a third state. */
	origin?: AccessOrigin;
}

/** The level a NEWLY AUTHORED entry starts at, the top of the ladder. Reach is not what stops a delete; the
 *  confirmation gate is. Migration never consults it, and the default must stay visible where it is authored. */
export const AUTHORED_DEFAULT_LEVEL: AccessLevel = 'delete';

/** Parse one stored entry in either shape, or null when malformed. A legacy pair is read on every load, and
 *  `write: true` maps to DELETE, not write, since a write root already permits deletes. An unknown level or
 *  origin drops the entry; it is never clamped. */
export function parseAccessEntry( raw: unknown ): AccessEntry | null {
	if( typeof raw !== 'object' || raw === null ) return null;
	const e = raw as Record<string, unknown>;
	if( typeof e[ 'path' ] !== 'string' || !e[ 'path' ] ) return null;
	const path = e[ 'path' ] as string;

	// Read BEFORE the level/legacy branch, because a malformed marker condemns the entry on every route
	// through this function — new shape and legacy pair alike.
	const origin = e[ 'origin' ];
	if( origin !== undefined && !ACCESS_ORIGINS.includes( origin as AccessOrigin ) ) return null;
	const mark = origin === undefined ? {} : { origin: origin as AccessOrigin };

	const stated = e[ 'level' ];
	if( stated !== undefined ) {
		return ACCESS_LEVELS.includes( stated as AccessLevel ) ? { path, level: stated as AccessLevel, ...mark } : null;
	}

	if( e[ 'enabled' ] === false ) return { path, level: 'none', ...mark };
	return { path, level: e[ 'write' ] === true ? 'delete' : 'read', ...mark };
}

/** Parse a whole stored list, dropping what cannot be read. A non-array is an unreadable policy, which is
 *  an EMPTY one — every guard then refuses, which is the safe direction and the one already taken. */
export function parseAccessList( raw: unknown ): AccessEntry[] {
	if( !Array.isArray( raw ) ) return [];
	const out: AccessEntry[] = [];
	for( const item of raw ) {
		const entry = parseAccessEntry( item );
		if( entry ) out.push( entry );
	}
	return out;
}

/** Serialize an entry for storage, new shape only. The origin is always written, even as the default, so a stored
 *  row says `authored` rather than being indistinguishable from one written before the field existed. */
export function serializeAccessEntry( entry: AccessEntry ): Record<string, unknown> {
	return { path: entry.path, level: entry.level, origin: originOf( entry ) };
}

/** The ONE reader of the marker, and the one place its default lives: absent is an entry written before the field
 *  existed, and those were authored by a person. Every consumer asks here, never `entry.origin`. */
export function originOf( entry: Pick<AccessEntry, 'origin'> ): AccessOrigin {
	return entry.origin ?? DEFAULT_ORIGIN;
}

/** The deeper of two levels. The floor-plus primitive — every combination rule in this model is this. */
export function higherLevel( a: AccessLevel, b: AccessLevel ): AccessLevel {
	return accessRank( a ) >= accessRank( b ) ? a : b;
}

/** Whether `held` is deep enough for an operation needing `required`. The one question every guard asks. */
export function levelMeets( held: AccessLevel, required: AccessLevel ): boolean {
	return accessRank( held ) >= accessRank( required );
}

/**
 * The agent's vocabulary for the ladder: what reaches a model is prompt text, so `delete` is reported as the
 * operation `remove`. It lives here because both doors need it; a second copy would teach two vocabularies.
 */

/** Every operation a rung permits, cumulative because the ladder is — what an agent is told it may DO. */
export function operationsFor( level: AccessLevel ): string {
	if ( level === 'delete' ) return 'list, read, search, write, remove';
	if ( level === 'write' )  return 'list, read, search, write';
	if ( level === 'read' )   return 'list, read, search';
	return 'nothing';
}

/** The one operation a rung newly permits, for a refusal sentence. `delete` alone differs from its name, so this
 *  is a lookup. */
export function verbFor( level: AccessLevel ): string {
	if ( level === 'delete' ) return 'remove';
	if ( level === 'write' )  return 'write';
	if ( level === 'read' )   return 'read';
	return 'reach';
}
