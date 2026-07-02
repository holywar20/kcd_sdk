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

/** The wire / DB-seed form of a Session. Flat and declarative — everything a session IS. */
export interface SerializedSession {
	id: string;
	/** The agent this session was spawned from — its identity source. Never null. */
	agentId: string;
	/** Renamable display title, independent of the agent's name. Null → derive one (agent + stamp). */
	title: string | null;
	/** Free-form, user-defined tags — a future search + agent-dredge key. */
	tags: string[];
	createdAt: number;
	/** Epoch ms of the last turn (or last touch) — the recency sort for a session switcher. */
	lastActive: number;
	status: SessionStatus;
}

export interface SessionOptions {
	id?: string;
	agentId: string;
	title?: string | null;
	tags?: string[];
	createdAt?: number;
	lastActive?: number;
	status?: SessionStatus;
}

/**
 * Session — the conversation-identity primitive. Pure data + a handful of mutators; no `fs`,
 * no file backing. It persists as a `sessions` DB row and rides the bridge as serialized JSON.
 */
export class Session {

	readonly id: string;
	readonly agentId: string;
	title: string | null;
	tags: string[];
	readonly createdAt: number;
	lastActive: number;
	status: SessionStatus;

	private constructor(
		id: string,
		agentId: string,
		title: string | null,
		tags: string[],
		createdAt: number,
		lastActive: number,
		status: SessionStatus,
	) {
		this.id         = id;
		this.agentId    = agentId;
		this.title      = title;
		this.tags       = tags;
		this.createdAt  = createdAt;
		this.lastActive = lastActive;
		this.status     = status;
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Spawn a fresh session under an agent. A session always has a source agent — agentId is required. */
	static create( opts: SessionOptions ): Session {
		const now = Date.now();
		return new Session(
			opts.id ?? crypto.randomUUID(),
			opts.agentId,
			opts.title ?? null,
			opts.tags ?? [],
			opts.createdAt ?? now,
			opts.lastActive ?? now,
			opts.status ?? 'active',
		);
	}

	/** Rebuild from the wire / DB seed. */
	static fromSerialized( json: SerializedSession ): Session {
		return new Session(
			json.id,
			json.agentId,
			json.title ?? null,
			json.tags ?? [],
			json.createdAt,
			json.lastActive ?? json.createdAt,
			json.status ?? 'active',
		);
	}

	/** The bridge wire form, the save form, the reconstruction source — one function, many purposes. */
	serializeForWire(): SerializedSession {
		return {
			id:         this.id,
			agentId:    this.agentId,
			title:      this.title,
			tags:       [ ...this.tags ],
			createdAt:  this.createdAt,
			lastActive: this.lastActive,
			status:     this.status,
		};
	}

	// ── Mutators ───────────────────────────────────────────────────────────────

	/** Rename the session; null clears back to the derived title. */
	rename( title: string | null ): void { this.title = title; }

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

	/** A display title even when none was set — the explicit title, else a stamp-derived fallback. */
	displayTitle(): string {
		if ( this.title ) return this.title;
		return 'Session ' + new Date( this.createdAt ).toISOString().slice( 0, 16 ).replace( 'T', ' ' );
	}
}
