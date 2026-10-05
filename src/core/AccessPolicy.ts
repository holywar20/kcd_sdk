import { ACCESS_LEVELS, accessRank, type AccessLevel } from '../session/InjectedItem';

/**
 * AccessPolicy — what a person CONFIGURED, and the one place the stored shape is read.
 *
 * ── WHY THIS FILE EXISTS ──
 * The configured file policy used to be a pair of booleans ( `enabled`, `write` ) folded into a root set
 * independently in FIVE places: the file server's whitelist, write and delete guards ( two of them
 * byte-identical ), the in-process gate in Starmind's main, and the capability deck's own store. Checked
 * before the collapse, all five AGREED — which is the argument for this file rather than against it. That
 * agreement was held by five careful authors, and the sixth reader is the one that gets it wrong.
 *
 * So the fold lives here, once, and everything that needs to know what a person configured parses through
 * it. Node-free on purpose: the renderer draws this policy and cannot import the node layer, while the
 * guards enforce it in two other processes. One shape, three processes, one parse.
 *
 * ── THE LADDER, NOT A PAIR ──
 * A level is ORDERED ( see ACCESS_LEVELS ), so illegal combinations cannot be expressed. The pair could
 * spell four states of which one — disabled but writable — meant nothing and had to be defended against
 * at every reader. It cannot be written down here.
 *
 * ── FLOOR PLUS, AND DELIBERATELY NOT MOST-SPECIFIC ──
 * Overlapping entries resolve to the HIGHEST level, never the nearest one. Two entries touching one path
 * give it the deeper of the two and nothing carves a shallower pocket inside a deeper tree. That is less
 * expressive than a most-specific override scheme and that is the point: a security model that reaches
 * for every case becomes one nobody can reason about, and the whole value of this rule is that a person
 * looking at two rows can predict the answer without tracing anything. `the deepest level anything grants
 * it` fits in one sentence; `the longest matching prefix unless a grant overrides, except…` does not.
 *
 * ── THE TIERS DO NOT RESOLVE, AND HIGHEST-WINS SURVIVES BECAUSE OF THAT ( ruled 2026-09-26 ) ──
 * Four tiers write reach — app default, project, agent, session — and the question was whether a run's floor
 * should be their MERGE. It is not. Each tier SEEDS the next by copy, exactly as it always has, and a run's
 * list is its own; editing a tier above reaches nothing already seeded.
 *
 * The rule above is why. "Merged across the tiers, and removable at the session" cannot coexist with
 * highest-wins: a session entry at `none` ranks LOWEST, so an inherited `write` would win and the removal
 * would silently do nothing. Making it work needs either most-specific resolution — the scheme this file
 * declines by name, two paragraphs up — or a second, negative list at every tier to record removals as
 * removals. Both spend the predictability that is this model's whole value, and they spend it to express
 * something copy-on-seed already expresses: the session's list IS the answer, so removing a row removes it.
 *
 * What the ruling costs, stated rather than discovered: an edit above does not flow down, which is the same
 * cost `PassportSeeds` was built to work around on the tools axis. And a copied entry has forgotten which
 * tier authored it — which is why `origin` exists ( below ) and why it records only the one distinction a
 * surface can honestly explain: Starmind put this row here, or a person did. Not WHICH tier; that is gone
 * by the time anything reads the row, and a field that claimed to know it would be lying.
 *
 * ── CONTAINMENT IS NOT HERE ──
 * This module answers what an ENTRY says, never what a PATH resolves to. Deciding whether a path sits
 * inside a root is path math against the real filesystem's rules ( separator boundaries, `..` collapse,
 * Windows case-folding ) and belongs with the jail that already implements it — see
 * `SdkFileAccess.resolveLevel`, which composes this with that. The renderer needs the first and must
 * never need the second, which is exactly why the two are split.
 */

/** Who put a row here. Two states and no more — see `AccessEntry.origin`. */
export const ACCESS_ORIGINS = [ 'shipped', 'authored' ] as const;
export type AccessOrigin = typeof ACCESS_ORIGINS[ number ];

/** The origin an entry carrying no marker reads as. Load-bearing, and the back-compatible direction: every
 *  row stored before this field existed was in fact authored by a person, and reading those as shipped would
 *  relabel someone's own configuration as something the product put there. */
export const DEFAULT_ORIGIN: AccessOrigin = 'authored';

/** One configured root and how deeply it may be reached. The stored shape from this arc forward. */
export interface AccessEntry {
	/** Absolute, or a `{ProjectRoot}`-tokenized form that the reader expands before use. */
	path:  string;
	level: AccessLevel;

	/**
	 * Whether Starmind SHIPPED this row or a person AUTHORED it. A LABEL, and nothing else.
	 *
	 * ── IT NEVER ENTERS RESOLUTION ──
	 * Not in `higherLevel`, not in `levelMeets`, not in `SdkFileAccess.resolveLevel`, and not in any guard.
	 * Two entries differing only in origin resolve identically, and there is a test that says so. Floor-plus
	 * highest-wins is the rule this file spends two paragraphs defending; a marker that changed which entry
	 * won would reintroduce most-specific resolution through the back door while looking like a label, and
	 * it would do it in the one model whose whole value is that a person can predict the answer.
	 *
	 * ITS TWO INTENDED CONSUMERS, both READS: the reach ladder surface, which draws the distinction and
	 * explains what dropping a row costs; and the seed arm on `PassportSeeds`, which needs to tell a row it
	 * placed from a row a person wrote. If you are reaching for it inside a guard, you want a level.
	 *
	 * OPTIONAL ON THE WIRE AND IN MEMORY. Absent means `DEFAULT_ORIGIN`, and `originOf` is the one reader
	 * that says so — do not read this property raw, because `undefined` is not a third state.
	 */
	origin?: AccessOrigin;
}

/**
 * The level a NEWLY AUTHORED entry starts at — the top of the ladder.
 *
 * A path a person deliberately named is a deliberate act, and a working directory the agent cannot work
 * in is a configuration step standing between someone and their first useful turn. It is affordable
 * because the two axes are PERPENDICULAR: reach at this depth does not mean deletes happen quietly, it
 * means reach is not the thing that stops them and the confirmation gate is. Visible and lowerable where
 * the entry is authored — a default nobody can see is not a default, it is a surprise.
 *
 * Applies to what is authored NEXT. Migration preserves meaning exactly and never consults this.
 */
export const AUTHORED_DEFAULT_LEVEL: AccessLevel = 'delete';

/**
 * Parse one stored entry, in either shape, or null when it is malformed.
 *
 * ── THE MIGRATION TABLE, WHICH IS THIS FUNCTION ──
 * Legacy entries are migrated by READING the old pair rather than by guessing, and the reading happens
 * here on every load rather than as a one-shot rewrite: a slice can be hand-edited, an older build can
 * write one, and a migration that has to have run is a migration that has not run somewhere.
 *
 *   enabled: false            → none     ( regardless of `write`; the pair's meaningless state collapses )
 *   enabled: true,  write: false → read
 *   enabled: true,  write: true  → delete
 *
 * `write: true` maps to DELETE, not to write, and that is meaning-preserving rather than generous. Delete
 * rides the write surface today — the delete guard's root set is byte-identical to the write guard's — so
 * a write-flagged root already permits deletes, and mapping it any lower would silently revoke reach a
 * person already had. It also lands where the floor ruling says a project's working directory belongs.
 *
 * A missing `enabled` reads as ON and `write` must be exactly `true`, matching every parse this replaces —
 * the defaults are load-bearing because a hand-edited slice has always been a supported input.
 *
 * An explicit `level` wins outright: once written in the new shape an entry says what it means, and there
 * is no reason to consult flags a newer writer did not author. An unrecognised level is treated as
 * malformed rather than clamped — a policy we cannot read is not a policy we may assume is permissive.
 *
 * ── THE ORIGIN MARKER ──
 * Absent is the common case and is LEFT absent, which `originOf` reads as authored. A STATED marker must be
 * one of `ACCESS_ORIGINS`; anything else drops the WHOLE entry, exactly as an unrecognised level does and
 * for the same reason stated one paragraph up. Dropping rather than defaulting is the only honest answer
 * here too: a row whose provenance we cannot read would be drawn to a person as a fact, and a surface that
 * confidently mislabels who configured something is worse than one row short.
 */
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

/** Serialize an entry for storage — the new shape only. Writers do not emit the legacy pair, so a slice
 *  converges on one form as it is edited while old entries keep being readable until they are.
 *
 *  THE ORIGIN IS WRITTEN ALWAYS, including when it is the default. A READER tolerates silence and a WRITER
 *  states its answer: a stored row saying `authored` is one a person reading the slice can tell apart from
 *  one written before the field existed, where an omitted default leaves the two indistinguishable forever.
 *  Same precedent as `browseAll` on the passport document. */
export function serializeAccessEntry( entry: AccessEntry ): Record<string, unknown> {
	return { path: entry.path, level: entry.level, origin: originOf( entry ) };
}

/** The ONE reader of the marker, and the one place its default lives. Absent is not a third state — it is
 *  an entry written before this field existed, and those were authored by a person. Every consumer asks
 *  here rather than touching `entry.origin`, so the back-compatible direction is decided once. */
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
 * ── THE AGENT'S VOCABULARY ──
 *
 * Two audiences, two words for one fact. A PERSON picks a tier on a settings screen and wants the tier's
 * name; a MODEL is told what will succeed. They are not translations of each other and neither is the
 * "real" one — the rung is the stored fact, and this is what that fact means to the thing acting on it.
 *
 * The reason it is a vocabulary rather than a formatting choice: what reaches a model about its own
 * permissions IS prompt text. `delete` reported to an agent as the name of a level it holds is an
 * invitation nobody wrote on purpose; `remove` as one of the operations that will succeed is a fact.
 *
 * IT LIVES HERE, beside the ladder it names, because BOTH doors need it. It was written once as a private
 * function inside the spawned server's own file, reachable by exactly one caller — which is not a smaller
 * version of this, it is the drift itself: the moment the in-process door needed to say the same thing it
 * would have said it in its own words, and an agent would have learned two vocabularies for one ladder
 * depending on which door refused it.
 */

/** Every operation a rung permits, cumulative because the ladder is — what an agent is told it may DO. */
export function operationsFor( level: AccessLevel ): string {
	if ( level === 'delete' ) return 'list, read, search, write, remove';
	if ( level === 'write' )  return 'list, read, search, write';
	if ( level === 'read' )   return 'list, read, search';
	return 'nothing';
}

/** The ONE operation a rung newly permits — the verb a refusal sentence needs, where the cumulative list
 *  would be unreadable. `delete` is the only rung whose verb differs from its name, and it is the whole
 *  reason this is a lookup rather than the level itself. */
export function verbFor( level: AccessLevel ): string {
	if ( level === 'delete' ) return 'remove';
	if ( level === 'write' )  return 'write';
	if ( level === 'read' )   return 'read';
	return 'reach';
}
