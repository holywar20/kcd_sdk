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

import { Transcript, type Turn, type WireMessage, type TranscriptTurn, type RetentionPolicy, type CompactionPolicy, type SessionPolicies, type SessionCompaction } from './TurnEntry';

/**
 * A session's LIFECYCLE state — is this conversation live or filed away? Persisted, user-driven,
 * changes rarely. Deliberately kept separate from `TurnStatus` below: "is this archived?" and "is this
 * working right now?" are different questions on different clocks, and folding them into one field
 * would make every read ambiguous.
 */
export type SessionStatus = 'active' | 'archived';

/**
 * A session's RUN state — is a turn in flight right now?
 *
 * This is the home the flag was moved TO ( 2026-07-21 ). It used to be `Agent.status`, which was wrong
 * on two counts. Conceptually: an agent is a CONFIGURATION — an identity, a lens stack, a tool
 * composition — and configuration does not run. A turn runs, and a turn happens inside a session, so
 * the session is the narrowest thing that can honestly answer "are you busy?". Practically: because
 * many sessions can share one agent, two concurrent runs clobbered the single shared flag — whichever
 * finished first flipped it to idle while the other was still going. Per-session, that case is correct
 * by construction.
 *
 * NOT PERSISTED, deliberately — it is never written to the session row ( see SessionService._toRow ).
 * Run state has no meaning across a restart: the turn it described is dead, and persisting it would let
 * a crash mid-turn resurrect a session permanently stuck on 'thinking' with no turn to ever clear it.
 * Every session therefore hydrates 'idle', which is always true at load.
 *
 * It DOES cross the wire ( it is on SerializedSession ), because its whole point is being visible to
 * surfaces that did not fire the turn. It does not replace the Session store's local `pending`: that is
 * optimistic UI, flipped the instant the user hits send so the spinner is immediate. `pending` is local
 * optimism for the sender; `turnStatus` is authoritative state for everyone else.
 */
export type TurnStatus = 'idle' | 'thinking';

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
	/** Every POLICY acting on this session's context, by name — what rides the next request and whether
	 *  the transcript compacts itself. PERSISTED ( unlike the transcript itself ): these are session
	 *  CONFIGURATION the user sets deliberately, so reopening a session restores the policies it was left
	 *  on. Absent on an older wire/row, as is a BARE legacy retention policy — both hydrate through
	 *  `Session.policiesFrom`, which is the one place the old shape is understood. */
	policies?: SessionPolicies;
	/** Is a turn in flight right now — see `TurnStatus`. Rides the wire so every surface can see it;
	 *  never written to the session row. Absent → 'idle', which is always true on arrival. */
	turnStatus?: TurnStatus;
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
	policies?: SessionPolicies;
}

/** The policies every session is born on — the whole transcript rides ( nothing narrowed ) and it never
 *  compacts itself until the user turns that on. Both defaults are deliberately inert: a fresh session
 *  hides nothing and rewrites nothing. */
const DEFAULT_POLICIES: SessionPolicies = {
	retention:  { kind: 'all' },
	compaction: { enabled: false, threshold: 120_000 },
};

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

	/** Every POLICY acting on this session's context, by name. PERSISTED session configuration — the
	 *  deliberate counterpart to the non-persisted `transcript` below: the transcript is the durable
	 *  account of what happened, these are the lenses over it. Changing one NEVER edits history; it only
	 *  changes what the next `wireMessages()` projects. */
	policies: SessionPolicies;

	/** Is a turn in flight right now — the run-state that used to live ( wrongly, and dead ) on the
	 *  Agent. See `TurnStatus` for the full reasoning. Runtime-only: born 'idle', never persisted, so a
	 *  crash mid-turn can never leave a session stuck 'thinking'. */
	turnStatus: TurnStatus = 'idle';

	/** The session's DYNAMIC context — the typed, ordered transcript of turns ( user / assistant /
	 *  tool-call / tool-result / injected-file, plus display-only thinking ). NON-PERSISTED object state,
	 *  the mirror of agent.bindEnv: never in SerializedSession, rebuilt on arrival via bindTranscript().
	 *  Its home of record is the DB `entries` rows ( hydrated on load — see bindTranscript ). Empty until
	 *  bound, so it is never null. */
	transcript: Transcript = Transcript.empty();

	/** The COMPACTIONS acting on this session — the summaries that stand in for the turns they cover. The
	 *  same species as `transcript`: NON-PERSISTED object state, never in SerializedSession, rebuilt on
	 *  arrival via bindCompactions(). Its home of record is the `session_compactions` table. Empty until
	 *  bound, so the projection below is a no-op on a session that has never compacted. */
	compactions: SessionCompaction[] = [];

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
		policies: SessionPolicies,
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
		this.policies   = policies;
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
			Session.policiesFrom( opts.policies ),
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
			Session.policiesFrom( json.policies ),
		);
	}

	/**
	 * Hydrate a policy bag from anything a wire / row might hold — the ONE place the legacy shape is
	 * understood, so every other reader can assume the container.
	 *
	 * Three inputs land here: the container itself, a BARE legacy retention policy ( `{ kind: … }`, what
	 * sessions stored before compaction existed — it becomes the `retention` entry ), and nothing at all.
	 * Deliberately forgiving in the same spirit as the service-side parse: an unreadable policy must never
	 * make a session's history unreachable, and every default is inert.
	 */
	static policiesFrom( raw: unknown ): SessionPolicies {
		const v = ( raw ?? null ) as Record<string, unknown> | null;
		if ( !v || typeof v !== 'object' ) return { ...DEFAULT_POLICIES };
		// the bare legacy shape — a retention policy stored before there was a bag to put it in
		if ( typeof v[ 'kind' ] === 'string' ) {
			return { retention: v as RetentionPolicy, compaction: { ...DEFAULT_POLICIES.compaction } };
		}
		return {
			retention:  ( v[ 'retention' ]  as RetentionPolicy  ) ?? { ...DEFAULT_POLICIES.retention  },
			compaction: ( v[ 'compaction' ] as CompactionPolicy ) ?? { ...DEFAULT_POLICIES.compaction },
		};
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
			policies:   this.policies,
			turnStatus: this.turnStatus,
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

	// ── Transcript ( the dynamic half of the wire ) ─────────────────────────────

	/** Rebuild the transcript wholesale from a turn list — the flush-and-fill mirror of agent.bindEnv().
	 *  Aggressive rebuild is cheap and always correct; the source is the DB `entries` rows on load, or the
	 *  live turn list the renderer projects. Non-persisted: it is never written by serializeForWire. */
	bindTranscript( turns: Turn[] ): void {
		this.transcript = new Transcript( turns );
	}

	/** Rebuild the compaction list wholesale — the flush-and-fill twin of bindTranscript(). Bound from the
	 *  same load as the transcript, and rebound whenever a pass writes a new one, so the very next send is
	 *  narrowed by it rather than waiting for a reload. Oldest→newest; the projection re-sorts defensively
	 *  rather than trusting the caller's order. */
	bindCompactions( compactions: SessionCompaction[] ): void {
		this.compactions = compactions;
	}

	/** Set ONE named policy, leaving its siblings alone. Pure configuration: no policy touches the
	 *  transcript, so nothing is ever lost by changing one. The caller persists the whole bag ( DB
	 *  update_session_policy ).
	 *
	 *  Named rather than whole-bag ( `setPolicies( bag )` ) because every real caller is a single control
	 *  changing a single lever — a whole-bag setter would make each of them read, spread, and write back
	 *  the others, which is exactly how one control silently reverts another. */
	setPolicy<K extends keyof SessionPolicies>( name: K, policy: SessionPolicies[ K ] ): void {
		this.policies = { ...this.policies, [ name ]: policy };
	}

	/** Flip the run state around a turn. Deliberately has NO persistence counterpart — the caller
	 *  broadcasts it and nothing writes it ( see `TurnStatus` ). Bracket every turn idle → thinking →
	 *  idle from a `finally`, so a failure can't strand a session lit. */
	setTurnStatus( status: TurnStatus ): void { this.turnStatus = status; }

	/** The transcript as it will actually RIDE — EVERY policy applied, in the ratified order: retention
	 *  first ( which turns survive ), compaction second ( the summary standing in for the prefix, over
	 *  whatever retention kept ). Running compaction last is what stops a narrow retention from smuggling
	 *  a covered turn back in.
	 *
	 *  Private and SHARED, because wireMessages() and estimateTokens() are the two readers that must never
	 *  disagree about what rides — the moment they compose the policies separately, the gauge starts lying
	 *  about the send. A third policy composes here and both readers get it for free.
	 *
	 *  Neither policy edits the transcript. Both are lenses over it, so narrowing and re-widening loses
	 *  nothing and the itinerary still shows everything that happened. */
	private _projected(): Transcript {
		return this.transcript
			.windowed( this.policies.retention )
			.compacted( this.compactions );
	}

	/** The DYNAMIC half of the wire — the projected transcript as neutral messages a connector maps to its
	 *  provider format ( thinking excluded ). Joins agent.wireSystem() ( the stable half ) at send: the
	 *  whole request is { system: agent.wireSystem(), messages: session.wireMessages() }. Every policy is
	 *  applied HERE, at the projection — the transcript itself is never edited. */
	wireMessages(): WireMessage[] {
		return this._projected().wireMessages();
	}

	/** The inspector itinerary — one BLOCK per turn, each carrying the entries that happened inside it
	 *  ( thinking included ). DELIBERATELY UNWINDOWED: the Turns folder is the account of what actually
	 *  happened, and a narrow policy must not make history look like it vanished. ( Marking which turns
	 *  are in-window is a display concern for the folder itself. ) The System folder reads
	 *  agent.wireSystem(). */
	transcriptTurns(): TranscriptTurn[] {
		return this.transcript.turnRows();
	}

	/** The session's own context cost — the wire weight of the PROJECTED transcript ( self-priced per
	 *  entry ), so it prices what will actually ride rather than everything ever said: a compacted session
	 *  is priced on its summary, which is the whole reason a user compacts one. Reads the same _projected()
	 *  the wire does, so the number cannot drift from the send. The whole-context estimate folds this onto
	 *  agent.estimateTokens(); a caller sums the two halves. */
	estimateTokens(): number {
		return this._projected().estimateTokens();
	}

	/**
	 * A display title even when none was set. An untitled session is a session whose first prompt has not
	 * been named yet — either it has not taken a turn, or the house agent's naming pass is still thinking —
	 * so the placeholder says exactly that and nothing more.
	 *
	 * It used to be a creation timestamp, back when a titleless session was a permanent state. It isn't
	 * one any more: a title arrives on its own within a turn, and a stamp would have read like a real name
	 * that just happened to be useless.
	 */
	displayTitle(): string {
		if ( this.title ) return this.title;
		return 'New session';
	}
}
