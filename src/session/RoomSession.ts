/**
 * RoomSession — a multi-party conversation: a shared, durable transcript plus an array of
 * typed seats.
 *
 * The distinction from Session is the whole point. A Session is ONE agent's spawned run —
 * one identity, one conversation, turns that belong to it. A RoomSession has no owning
 * agent: it is a place several participants take turns speaking in, and the participants
 * are seats rather than identities, so the same agent can hold two of them and a seat can
 * outlive the agent behind it.
 *
 * The load-bearing consequence of the room owning the transcript: an agent participant
 * holds NO state between turns. Every turn re-projects the entire window from the stored
 * messages, so a participant can be wiped, respawned, or re-lensed mid-room with zero
 * bookkeeping — the room is the memory.
 *
 * Deliberately LIGHT, exactly as Session is: pure data + mutators, no `fs`, no compose().
 * The messages are DB rows fetched on demand, never held on the object. It persists as a
 * `room_sessions` row and rides the bridge whole via serialize / fromSerialized.
 */

export type RoomStatus = 'active' | 'archived';

/** How a room advances. `manual` = nothing runs until something outside asks a seat to speak
 *  (v1: a human pumps every turn). `auto` is the deferred pole — the addressee of a landed
 *  message runs automatically until a turn budget stops it. The column exists now so the
 *  behavior can land later without a migration. */
export type RoomMode = 'manual' | 'auto';

/**
 * One seat in a room. `kind` is the fork that decides who can be MADE to speak:
 *
 *  · `agent`    — runs through the orchestrator; the only drivable kind.
 *  · `human`    — speaks through the composer; never driven.
 *  · `external` — an out-of-process participant (a Claude Code session over MCP) that appends
 *                 on its own schedule. Never driven, because nothing here can wake it.
 *
 * `ref` carries the agentId for `agent` seats and is empty otherwise.
 */
export interface RoomParticipant {
	id: string;
	kind: 'agent' | 'human' | 'external';
	ref: string;
	label: string;
	color: string;
}

/**
 * One utterance in a room.
 *
 * N-party, so a message is ONE utterance with a speaker — not an exchange. That is the
 * structural reason rooms do not ride the `turns` table, whose `user_text` + `asst_text`
 * columns bake two parties into the schema.
 *
 * `fromId` / `toId` are PARTICIPANT ids, not agent ids — the seat is the addressable thing.
 * A null `toId` is a broadcast: it is visible to everyone and wakes no one.
 */
export interface RoomMessage {
	id: string;
	roomId: string;
	/** Monotonic per room. THE ordering — timestamps collide when a reply lands in the same ms. */
	seq: number;
	fromId: string;
	toId: string | null;
	body: string;
	/** The speaker's reasoning, when the tier surfaces it. Display-only, never re-projected
	 *  into another participant's window. */
	thinking: string | null;
	/** The dispatch traceId of the turn that produced this message — the join key to
	 *  turn_entries and the agent_action lane. Null for a human or external utterance. */
	traceId: string | null;
	tokensIn: number;
	tokensOut: number;
	createdAt: number;
}

/** The wire / DB-seed form of a RoomSession. Flat and declarative — everything a room IS. */
export interface SerializedRoomSession {
	id: string;
	title: string;
	participants: RoomParticipant[];
	mode: RoomMode;
	/** Per-room framing folded into every seat's preamble — the shared situation, above each
	 *  participant's own identity. Editable at runtime on purpose: tuning this is how a room is made
	 *  to behave, and that loop has to be fast. Empty = the bare room frame. */
	brief: string;
	/** How many agent turns one auto-advance may fire before it stops on its own. The room cannot run
	 *  away: this is a hard ceiling, not a hint. */
	budget: number;
	/** How many TRAILING messages a seat is shown. 0 = the whole transcript. A room's context grows
	 *  for every seat at once, so an N-party room inflates N times faster than a chat. The premise is
	 *  safe from trimming because it lives in `brief`, which rides the system prompt — which is what
	 *  makes a dumb trailing window good enough here. */
	window: number;
	createdAt: number;
	/** Epoch ms of the last utterance — the recency sort for a room roster. */
	lastActive: number;
	status: RoomStatus;
}

export interface RoomSessionOptions {
	id?: string;
	title?: string;
	participants?: RoomParticipant[];
	mode?: RoomMode;
	brief?: string;
	budget?: number;
	window?: number;
	createdAt?: number;
	lastActive?: number;
	status?: RoomStatus;
}

/** The default auto-advance ceiling. Small on purpose — the interesting failures show up in the
 *  first few exchanges, and a long unattended run mostly buys drift. */
export const ROOM_DEFAULT_BUDGET = 6;

/** What a caller hands `addParticipant` — the seat's identity minus its minted id. */
export interface RoomSeatSpec {
	kind: 'agent' | 'human' | 'external';
	ref?: string;
	label: string;
	color?: string;
}

export class RoomSession {

	readonly id: string;
	title: string;
	participants: RoomParticipant[];
	mode: RoomMode;
	brief: string;
	budget: number;
	window: number;
	readonly createdAt: number;
	lastActive: number;
	status: RoomStatus;

	private constructor(
		id: string,
		title: string,
		participants: RoomParticipant[],
		mode: RoomMode,
		brief: string,
		budget: number,
		window: number,
		createdAt: number,
		lastActive: number,
		status: RoomStatus,
	) {
		this.id           = id;
		this.title        = title;
		this.participants = participants;
		this.mode         = mode;
		this.brief        = brief;
		this.budget       = budget;
		this.window       = window;
		this.createdAt    = createdAt;
		this.lastActive   = lastActive;
		this.status       = status;
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Spawn a fresh room. Born empty — seats are added one at a time, so a room with one
	 *  participant (or none) is a legal, inert state rather than an error. */
	static create( opts: RoomSessionOptions ): RoomSession {
		const now = Date.now();
		return new RoomSession(
			opts.id ?? crypto.randomUUID(),
			opts.title ?? '',
			opts.participants ?? [],
			opts.mode ?? 'manual',
			opts.brief ?? '',
			opts.budget ?? ROOM_DEFAULT_BUDGET,
			opts.window ?? 0,
			opts.createdAt ?? now,
			opts.lastActive ?? now,
			opts.status ?? 'active',
		);
	}

	/** Rebuild from the wire / DB seed. */
	static fromSerialized( json: SerializedRoomSession ): RoomSession {
		return new RoomSession(
			json.id,
			json.title ?? '',
			json.participants ?? [],
			json.mode ?? 'manual',
			json.brief ?? '',
			json.budget ?? ROOM_DEFAULT_BUDGET,
			json.window ?? 0,
			json.createdAt,
			json.lastActive ?? json.createdAt,
			json.status ?? 'active',
		);
	}

	/** The bridge wire form, the save form, the reconstruction source — one function, many purposes. */
	serializeForWire(): SerializedRoomSession {
		return {
			id:           this.id,
			title:        this.title,
			participants: this.participants.map( ( p ) => ( { ...p } ) ),
			mode:         this.mode,
			brief:        this.brief,
			budget:       this.budget,
			window:       this.window,
			createdAt:    this.createdAt,
			lastActive:   this.lastActive,
			status:       this.status,
		};
	}

	// ── Seats ──────────────────────────────────────────────────────────────────

	/** Seat someone. Returns the born participant so the caller can address it immediately.
	 *  The id is minted here and is the room's addressing currency from then on — a caller
	 *  never addresses an agentId. */
	addParticipant( spec: RoomSeatSpec ): RoomParticipant {
		const participant: RoomParticipant = {
			id:    'seat-' + crypto.randomUUID().slice( 0, 8 ),
			kind:  spec.kind,
			ref:   spec.ref ?? '',
			label: spec.label,
			color: spec.color ?? 'var(--care)',
		};
		this.participants.push( participant );
		return participant;
	}

	/** Unseat a participant. The transcript is untouched — their past messages keep their
	 *  fromId, and the label lookup degrades to 'unknown' rather than rewriting history. */
	removeParticipant( id: string ): boolean {
		const before = this.participants.length;
		this.participants = this.participants.filter( ( p ) => p.id !== id );
		return this.participants.length !== before;
	}

	/** One seat by id, or null when there is no such seat. Absence, not failure — a stale id
	 *  from a removed participant is an ordinary read miss. */
	participant( id: string ): RoomParticipant | null {
		return this.participants.find( ( p ) => p.id === id ) ?? null;
	}

	/** The seats that can be MADE to speak — agent kind only. A human speaks through the
	 *  composer and an external participant appends on its own schedule; neither can be driven
	 *  from in here, so neither belongs in a "whose turn next" list. */
	drivable(): RoomParticipant[] {
		return this.participants.filter( ( p ) => p.kind === 'agent' );
	}

	// ── Mutators ───────────────────────────────────────────────────────────────

	rename( title: string ): void { this.title = title; }

	setMode( mode: RoomMode ): void { this.mode = mode; }

	/** Replace the room's framing text. The one knob worth turning while a room is live. */
	setBrief( brief: string ): void { this.brief = brief; }

	/** Clamp the auto-advance ceiling into a sane range — 0 disables auto-advance entirely, and the
	 *  upper bound exists because a typo must not be able to spend fifty turns. */
	setBudget( budget: number ): void {
		if ( !Number.isFinite( budget ) ) return;
		this.budget = Math.max( 0, Math.min( 40, Math.floor( budget ) ) );
	}

	/** Set the trailing-message window; 0 = the whole transcript. Floored at 0 and otherwise
	 *  unbounded — a big window is a legitimate choice, an unbounded one is the default already. */
	setWindow( window: number ): void {
		if ( !Number.isFinite( window ) ) return;
		this.window = Math.max( 0, Math.floor( window ) );
	}

	/** The trailing slice of a transcript this room shows a seat — the LAST `window` messages, or
	 *  everything when the window is 0. Lives here rather than in the projector because it is a
	 *  property of the ROOM's policy, not of how one speaker's window gets flattened. */
	windowed<T>( rows: T[] ): T[] {
		if ( this.window <= 0 || rows.length <= this.window ) return rows;
		return rows.slice( rows.length - this.window );
	}

	/** Stamp lastActive to now — called when an utterance lands, so a roster sorts by recency. */
	touch(): void { this.lastActive = Date.now(); }

	/** A display title even when none was set. */
	displayTitle(): string {
		if ( this.title ) return this.title;
		return 'Room ' + new Date( this.createdAt ).toISOString().slice( 0, 16 ).replace( 'T', ' ' );
	}
}
