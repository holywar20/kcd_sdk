/**
 * InjectedItem — the composer gutter's currency: one thing a USER handed to a session. A file, a folder and a tool
 * differ only in WHAT they are, so they are one discriminated union, and a new kind joins by adding a variant.
 * `kind` belongs to this union and nothing else; the retired AttachmentView's entry kind survives as `entryKind`.
 */
export const INJECTED_KINDS = [ 'file', 'folder', 'tool' ] as const;

export type InjectedKind = typeof INJECTED_KINDS[ number ];

/**
 * ACCESS — the ordered ladder a subject is reached at: `none` below `read` below `write` below `delete`.
 *
 * ORDERED rather than flags, so the illegal states cannot be expressed and every guard asks one question. `delete` is a
 * CONFIGURATION level, unreachable by any gesture. It sits in the union so the ceiling is a clamp on what a gesture may
 * produce, and a kind invented later cannot reach delete by never having been considered.
 */
export const ACCESS_LEVELS = [ 'none', 'read', 'write', 'delete' ] as const;

export type AccessLevel = typeof ACCESS_LEVELS[ number ];

/** The deepest level a user GESTURE may produce. Configuration goes deeper; a drag never does. */
export const GESTURE_CEILING: AccessLevel = 'write';

/** Rank on the ladder — the one comparison every "is this deep enough" question is made of. */
export function accessRank( level: AccessLevel ): number {
	return ACCESS_LEVELS.indexOf( level );
}

/** A level clamped to what a gesture may produce. Anything at or past the ceiling comes back AS the
 *  ceiling, so the clamp is a property of the type's use rather than a rule each caller remembers. */
export function clampToGesture( level: AccessLevel ): AccessLevel {
	return accessRank( level ) > accessRank( GESTURE_CEILING ) ? GESTURE_CEILING : level;
}

/** What every injected kind carries, whatever it is. */
interface InjectedBase {
	kind: InjectedKind;
	/** What this injection is ABOUT: an absolute path (file, folder) or a qualified tool id. The deck's identity, named for the grant record so the view and the record share one word. */
	subject: string;
	/** What the tile writes on itself — a basename, a folder name, a tool name. */
	name: string;
	/** Wire token weight as this rides TODAY: full for something about to be injected, a pointer's weight
	 *  for something already recorded. The gauge's "what will this send cost" number. */
	tokens: number;
	/** Not yet carried by a turn. Governs DETACHMENT: a pending item can be taken back because nothing has
	 *  happened yet; a recorded one cannot, because the transcript is the account of what happened. */
	pending: boolean;
	/** Marked for removal: rides nothing and shows here until a COMPACTION executes it. Batched there because dropping an entry mid-transcript re-prefills everything downstream. */
	removed: boolean;
	/** Whether the mode can be CHANGED: false only while the item sits on a turn still in flight. Separate from `pending`, so a surface can DISABLE a control rather than offer-and-fail. */
	editable: boolean;
}

/** A file — `subject` is its absolute path. Rides WHOLE on the turn it is injected and as a pointer on
 *  every turn after. */
export interface InjectedFile extends InjectedBase {
	kind: 'file';
	/** How deeply this subject may be reached: the level the DROP chose, clamped below `delete`. NULL is a grant made before
	 *  drop zones existed. That is unspecified, not `none`, so a reader says so rather than assuming a depth. */
	level: AccessLevel | null;
	/** Which TranscriptEntry kind backs it. An image is not a text file: it frames differently and prices
	 *  differently, and this is the only place that distinction survives on the view. */
	entryKind: 'injected-file' | 'image';
}

/** A folder — `subject` is its absolute path. Compiles to a flat one-level LISTING, never a recursive read. The agent
 *  lists on demand, which is more current than a listing compiled at the last send. */
export interface InjectedFolder extends InjectedBase {
	kind: 'folder';
	/** How deeply this root may be reached, see InjectedFile.level. A dropped folder is a WORKING ROOT, not a read-only
	 *  listing, and the level comes from the zone the drop landed on. */
	level: AccessLevel | null;
}

/** A tool — `subject` is its qualified id ( `server.tool` ). Injectable whatever the agent's roster says,
 *  because the injection IS the authorization. */
export interface InjectedTool extends InjectedBase {
	kind: 'tool';
	/** Which server offers it. Carried rather than split out of `subject`, since a tool name with a dot mislabels under any
	 *  parse. A tool without its server is two tools from two packages that look identical. */
	server: string;
}

export type InjectedItem = InjectedFile | InjectedFolder | InjectedTool;

/**
 * One AUTHORIZATION: the fact that a session may reach a subject, and nothing else. SOURCE-AGNOSTIC: it says what is
 * permitted, never how it arose, so a gate asks one question. Today the only producer is a context injection, but a
 * permission is not positional, does not decay, and outlives the turn that made it. Agnostic by OMISSION: add provenance
 * when a second producer exists and something needs to tell them apart.
 */
export interface GrantRef {
	kind: InjectedKind;
	subject: string;
	/**
	 * How deep this grant reaches ON DISK: the rung the drop landed on, clamped below `delete`. Never null: a record that
	 * never chose resolves to the conservative `read` here, once, rather than at every gate. `none` for a TOOL grant. Path
	 * resolution skips non-path kinds outright, so this is a second reason, not the first.
	 */
	level: AccessLevel;
}

/**
 * The granted TOOL subjects ( `server.tool` ) out of a grant list, which the tool registry widens its admission by.
 * A filter, not a second stored list: a derived view cannot fall out of step with the grants.
 */
export function grantedTools( grants: readonly GrantRef[] ): string[] {
	return grants.filter( ( g ) => g.kind === 'tool' ).map( ( g ) => g.subject );
}
