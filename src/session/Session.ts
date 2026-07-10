/**
 * Session — a spawned RUN of an agent, an identity distinct from the agent itself.
 *
 * The model shift this encodes: an Agent is the reusable identity + recipe (who + how
 * configured); a Session is one live conversation spawned FROM an agent. Many sessions
 * can share one agent, and a session can be deleted, renamed, and tagged without touching
 * the agent it came from. The turns of a conversation belong to the SESSION, not the agent.
 *
 * Deliberately LIGHT — pure data, no lens graph, no compose(). A session is metadata +
 * identity; its turn history lives as DB rows (CompletedTurn) fetched on demand, never
 * held on the object (exactly as Agent does not carry its own turns). It crosses the IPC
 * bridge whole via serialize / fromSerialized, the same trinity as Agent.
 */

export type SessionStatus = 'active' | 'archived';

/** The generic font stacks a session's chat surface can pick between — the render side owns
 *  the actual CSS stacks; this is just the closed key set a session persists. */
export type FontFamilyKey = 'sans' | 'serif' | 'mono';

/** The wire / DB-seed form of a Session. Flat and declarative — everything a session IS. */
export interface SerializedSession {
	id: string;
	/** The agent this session was spawned from — its identity source. EMPTY STRING ('') = a DRAFT
	 *  session not yet bound to an agent (spawned agentless from the roster's "+ session"); it's inert
	 *  until an agent is assigned. Never null on the wire — the sentinel is '', so the DB's NOT NULL
	 *  agent_id column stays satisfied without a nullable-column migration. */
	agentId: string;
	/** Renamable display title, independent of the agent's name. Null → derive one (agent + stamp). */
	title: string | null;
	/** Free-form grouping label ( flat, one level — mirrors the agents' `folder` idiom ). Null =
	 *  ungrouped. Just a string the roster groups by, not a real container. */
	folder: string | null;
	/** Free-form, user-defined tags — a future search + agent-dredge key. */
	tags: string[];
	createdAt: number;
	/** Epoch ms of the last turn (or last touch) — the recency sort for a session switcher. */
	lastActive: number;
	status: SessionStatus;
	/** This session's chat-surface text zoom. Null → the render side's default (1). Scoped to
	 *  the chat panel itself, not the app window — set via the chat header's A-/A+ control. */
	zoom: number | null;
	/** This session's chat-surface font family. Null → the render side's default ('sans'). */
	fontFamily: FontFamilyKey | null;
}

export interface SessionOptions {
	id?: string;
	/** Omit ( or pass '' ) to spawn a DRAFT session with no agent yet — assigned later via reassign(). */
	agentId?: string;
	title?: string | null;
	folder?: string | null;
	tags?: string[];
	createdAt?: number;
	lastActive?: number;
	status?: SessionStatus;
	zoom?: number | null;
	fontFamily?: FontFamilyKey | null;
}

/**
 * Session — the conversation-identity primitive. Pure data + a handful of mutators; no `fs`,
 * no file backing. It persists as a `sessions` DB row and rides the bridge as serialized JSON.
 */
export class Session {

	readonly id: string;
	/** Mutable now ( was readonly ) — a draft session is born agentless ('') and reassigned once the
	 *  user picks an agent. '' is the unassigned sentinel; hasAgent() is the readable check. */
	agentId: string;
	title: string | null;
	/** Grouping label — flat, one level. Null = ungrouped. */
	folder: string | null;
	tags: string[];
	readonly createdAt: number;
	lastActive: number;
	status: SessionStatus;
	zoom: number | null;
	fontFamily: FontFamilyKey | null;

	private constructor(
		id: string,
		agentId: string,
		title: string | null,
		folder: string | null,
		tags: string[],
		createdAt: number,
		lastActive: number,
		status: SessionStatus,
		zoom: number | null,
		fontFamily: FontFamilyKey | null,
	) {
		this.id         = id;
		this.agentId    = agentId;
		this.title      = title;
		this.folder     = folder;
		this.tags       = tags;
		this.createdAt  = createdAt;
		this.lastActive = lastActive;
		this.status     = status;
		this.zoom       = zoom;
		this.fontFamily = fontFamily;
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Spawn a fresh session. `agentId` may be omitted / '' for a DRAFT (agentless) session — it's inert
	 *  until reassign() binds it to an agent. */
	static create( opts: SessionOptions ): Session {
		const now = Date.now();
		return new Session(
			opts.id ?? crypto.randomUUID(),
			opts.agentId ?? '',
			opts.title ?? null,
			opts.folder ?? null,
			opts.tags ?? [],
			opts.createdAt ?? now,
			opts.lastActive ?? now,
			opts.status ?? 'active',
			opts.zoom ?? null,
			opts.fontFamily ?? null,
		);
	}

	/** Rebuild from the wire / DB seed. */
	static fromSerialized( json: SerializedSession ): Session {
		return new Session(
			json.id,
			json.agentId ?? '',
			json.title ?? null,
			json.folder ?? null,
			json.tags ?? [],
			json.createdAt,
			json.lastActive ?? json.createdAt,
			json.status ?? 'active',
			json.zoom ?? null,
			json.fontFamily ?? null,
		);
	}

	/** The bridge wire form, the save form, the reconstruction source — one function, many purposes. */
	serializeForWire(): SerializedSession {
		return {
			id:         this.id,
			agentId:    this.agentId,
			title:      this.title,
			folder:     this.folder,
			tags:       [ ...this.tags ],
			createdAt:  this.createdAt,
			lastActive: this.lastActive,
			status:     this.status,
			zoom:       this.zoom,
			fontFamily: this.fontFamily,
		};
	}

	// ── Mutators ───────────────────────────────────────────────────────────────

	/** Rename the session; null clears back to the derived title. */
	rename( title: string | null ): void { this.title = title; }

	/** Bind ( or rebind ) this session to an agent — the draft-session assignment path. '' clears it
	 *  back to unassigned. Mutates in place; the caller persists ( DB update_session_agent ). */
	reassign( agentId: string ): void { this.agentId = agentId; }

	/** True once this session has a real source agent — the readable form of `agentId !== ''`. A draft
	 *  session ( false ) is inert: it can't take a turn until an agent is assigned. */
	hasAgent(): boolean { return this.agentId !== ''; }

	/** Move this session into a grouping folder ( flat label ); null = ungrouped. */
	setFolder( folder: string | null ): void { this.folder = folder; }

	/** Stamp lastActive to now — called when a turn lands, so the switcher sorts by recency. */
	touch(): void { this.lastActive = Date.now(); }

	hasTag( tag: string ): boolean { return this.tags.includes( tag ); }

	/** Add a tag (no-op if already present). Free-form — the user coins their own vocabulary. */
	addTag( tag: string ): void {
		if ( !this.tags.includes( tag ) ) this.tags.push( tag );
	}

	removeTag( tag: string ): void {
		this.tags = this.tags.filter( ( t ) => t !== tag );
	}

	/** Set this session's chat-surface zoom + font family ( either may be null to fall back to
	 *  the render side's default ). The chat header's A-/A+ and font controls call this. */
	setDisplay( zoom: number | null, fontFamily: FontFamilyKey | null ): void {
		this.zoom = zoom;
		this.fontFamily = fontFamily;
	}

	/** A display title even when none was set — the explicit title, else a stamp-derived fallback. */
	displayTitle(): string {
		if ( this.title ) return this.title;
		return 'Session ' + new Date( this.createdAt ).toISOString().slice( 0, 16 ).replace( 'T', ' ' );
	}
}
