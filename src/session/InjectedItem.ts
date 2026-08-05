/**
 * InjectedItem — the composer gutter's currency: one thing a USER handed to a session.
 *
 * A file, a folder and a tool differ only in WHAT they are, never in how they behave here. Each lands
 * by a user action, lives until the user takes it back, and is revoked by removal. So they are one
 * discriminated union rather than three parallel lists a surface has to zip together, and a fourth kind
 * ( a memory, a reference, a compiled lens ) joins by adding a variant rather than a second list.
 *
 * This type RETIRED `AttachmentView`. That was the file-only shape, and its `kind` carried the
 * TranscriptEntry kind ( `'injected-file' | 'image'` ) — the second time one property name on this deck
 * stood for two things ( the first was the retired `'system' | 'inline'` position model ). The fact
 * survives as `entryKind` on the file variant, where it is unambiguous. `kind` now belongs to the union
 * and to nothing else.
 */
export const INJECTED_KINDS = [ 'file', 'folder', 'tool' ] as const;

export type InjectedKind = typeof INJECTED_KINDS[ number ];

/** What every injected kind carries, whatever it is. */
interface InjectedBase {
	kind: InjectedKind;
	/**
	 * The one thing this injection is ABOUT, read according to `kind` — an absolute path for a file or a
	 * folder, a qualified tool id for a tool. It is the deck's identity: what a tile keys on, what a
	 * removal names, and what a gate is asked about.
	 *
	 * Named for the grant record rather than for the file case ( `path` ) deliberately: the view and the
	 * record it projects use one word, so neither can drift into meaning something the other doesn't.
	 */
	subject: string;
	/** What the tile writes on itself — a basename, a folder name, a tool name. */
	name: string;
	/** Wire token weight as this rides TODAY: full for something about to be injected, a pointer's weight
	 *  for something already recorded. The gauge's "what will this send cost" number. */
	tokens: number;
	/** Not yet carried by a turn. Governs DETACHMENT: a pending item can be taken back because nothing has
	 *  happened yet; a recorded one cannot, because the transcript is the account of what happened. */
	pending: boolean;
	/** Marked for removal. It still rides nothing and still shows here until a COMPACTION executes the
	 *  intent — batched there because dropping an entry mid-transcript re-prefills everything downstream
	 *  of it, and compaction is the one moment the prefix is being rewritten anyway. */
	removed: boolean;
	/** Whether this item's mode can be CHANGED. False only in the narrow window where the thing sits on a
	 *  turn still in flight, whose row ids do not exist yet. Separate from `pending` because "can this be
	 *  taken back" and "can this be tuned" have different answers; one boolean standing for both is how a
	 *  surface ends up disabling a control that would have worked. A surface reads this to DISABLE rather
	 *  than to offer-and-fail. */
	editable: boolean;
}

/** A file — `subject` is its absolute path. Rides WHOLE on the turn it is injected and as a pointer on
 *  every turn after. */
export interface InjectedFile extends InjectedBase {
	kind: 'file';
	/** Which TranscriptEntry kind backs it. An image is not a text file: it frames differently and prices
	 *  differently, and this is the only place that distinction survives on the view. */
	entryKind: 'injected-file' | 'image';
}

/** A folder — `subject` is its absolute path. Compiles to a flat LISTING ( subdirectories included, one
 *  level ), never a recursive read, and re-resolves on every compile so a file added tomorrow is in
 *  scope tomorrow. */
export interface InjectedFolder extends InjectedBase {
	kind: 'folder';
}

/** A tool — `subject` is its qualified id ( `server.tool` ). Injectable whatever the agent's roster says,
 *  because the injection IS the authorization. */
export interface InjectedTool extends InjectedBase {
	kind: 'tool';
	/** Which server offers it. Carried rather than split back out of `subject`: a tool whose name holds a
	 *  dot would mislabel itself under any parsing rule, and the producer knows both halves already. The
	 *  tile reads this — a tool without its server is two tools from two packages looking identical. */
	server: string;
}

export type InjectedItem = InjectedFile | InjectedFolder | InjectedTool;

/**
 * One AUTHORIZATION — the fact that a session may reach a subject, and nothing else.
 *
 * Deliberately SOURCE-AGNOSTIC. It says what is permitted, never how the permission arose, so a gate
 * consulting it asks one question and gets one answer regardless of who granted it. Today the only
 * producer is a context injection ( the transcript entry IS the record ), but the two are different
 * facts wearing one name and they come apart the moment anything else wants to grant: a permission is
 * not positional, does not decay, and outlives the turn that created it, none of which is true of the
 * injection that happens to have produced it.
 *
 * Agnostic by OMISSION rather than by a provenance field — a type that never mentions its origin cannot
 * be narrowed to one. Add provenance when a second producer exists and something actually needs to tell
 * them apart.
 */
export interface GrantRef {
	kind: InjectedKind;
	subject: string;
}
