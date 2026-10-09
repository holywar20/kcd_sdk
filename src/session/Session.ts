/**
 * Session — a spawned RUN of an agent. An Agent is the reusable configuration; a Session is one live
 * conversation spawned FROM it, and the turns belong to the session, not the agent.
 * Deliberately light: pure data, no lens graph. Turn history is DB rows fetched on demand, never held here.
 */

import { Transcript, type Turn, type TurnEntry, type WireMessage, type WireOptions, type TranscriptTurn, type CompactionPolicy, type ReasoningPolicy, type ToolsPolicy, type ChatPolicy, type LimitsPolicy, type SessionPolicies, type SessionCompaction, type Grant, isGrant, grantSubject, grantKind, grantLevel, frameToolResultStub, frameFork, KEEP_TOOL_RESULT_TURNS } from './TurnEntry';
import { type GrantRef } from './InjectedItem';
import type { Agent } from '../agent/Agent';
import type { SlotRow } from '../core/html/KcdContext';

/**
 * A session's LIFECYCLE state, live or filed away. Kept apart from `TurnStatus`: 'archived' and 'working' are
 * different clocks, and one field would make every read ambiguous. The Plan Studio is the only writer; a roster
 * tidy is delete, never retirement.
 */
export type SessionStatus = 'active' | 'archived';

/**
 * A session is what RUNS: an agent is configuration and does not, and two concurrent runs on one shared agent
 * clobbered a single flag. Never persisted, so a crash mid-turn cannot resurrect a session stuck on 'thinking'.
 * Wire-visible, and not the local `pending` optimism: `pending` is the sender's spinner; this is authoritative.
 */
export type TurnStatus = 'idle' | 'thinking';

/** The generic font stacks a session's chat surface can pick between — the render side owns
 *  the actual CSS stacks; this is just the closed key set a session persists. */
export type FontFamilyKey = 'sans' | 'serif' | 'mono';

/** The wire / DB-seed form of a Session. Flat and declarative — everything a session IS. */
export interface SerializedSession {
	id: string;
	/** The workspace this session ran in ( `projects.id` ). Denormalized from its agent rather than
	 *  derived through it, so a DRAFT session — which has no agent — still carries one. */
	projectId: string;
	/** Its identity source. '' = a DRAFT session not yet bound to an agent. Never null on the wire, so the NOT NULL
	 *  column stays satisfied without a nullable-column migration. */
	agentId: string;
	/** The plan this session was opened to write; 0 for none. Written once at birth, never inherited by a fork.
	 *  The key is the PAIR (agentId, planId): within one pair exactly one session is 'active', the rest 'archived'. */
	planId: number;
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
	/** Epoch ms the person last saw this session's newest output; null = never seen. Absent reads the same. */
	readAt?: number | null;
	status: SessionStatus;
	/** This session's chat-surface text zoom. Null → the render side's default (1). Scoped to
	 *  the chat panel itself, not the app window — set via the chat header's A-/A+ control. */
	zoom: number | null;
	/** This session's chat-surface font family. Null → the render side's default ('sans'). */
	fontFamily: FontFamilyKey | null;
	/** The policies acting on this session's context. PERSISTED, unlike the transcript: reopening restores them.
	 *  `Session.policiesFrom` is the one place the legacy bare-policy shape is understood. */
	policies?: SessionPolicies;
	/** Why this session was opened — see `SessionBrief`. PERSISTED, so compilation survives a restart. */
	brief?: SessionBrief | null;
	/** Is a turn in flight right now — see `TurnStatus`. Never written to the row. Absent reads as 'idle'. */
	turnStatus?: TurnStatus;
}

/**
 * A named template and its values, rendered into the frame layer. The surface supplies facts only: the wording
 * is authored in app code, because a renderer that sent its own text would be a second author of the system prompt.
 * Written once at open and never refreshed, so the stable prefix does not move under the model on every edit.
 */
export interface SessionBrief {
	/** Which authored template to fill. Unknown names render nothing rather than failing a turn. */
	template: string;
	/** The values it is filled with, `{Name}` by name. */
	params:   Record<string, string>;
}

export interface SessionOptions {
	id?: string;
	/** The owning workspace ( `projects.id` ) — the spawning caller resolves it from the agent. */
	projectId?: string;
	/** Omit ( or pass '' ) to spawn a DRAFT session with no agent yet — assigned later via reassign(). */
	agentId?: string;
	/** The plan this session is being opened to write; omit for none. */
	planId?: number;
	title?: string | null;
	folder?: string | null;
	tags?: string[];
	createdAt?: number;
	lastActive?: number;
	status?: SessionStatus;
	zoom?: number | null;
	fontFamily?: FontFamilyKey | null;
	/** PARTIAL: every absent entry is filled from the defaults, so an opener need only name the policy it cares about. */
	policies?: Partial<SessionPolicies>;
	/** Why this session was opened — see `SessionBrief`. Absent for an ordinary chat. */
	brief?: SessionBrief | null;
}

/** The policies every session is born on — the whole transcript rides ( nothing narrowed ) and it never
 *  compacts itself until the user turns that on. Both defaults are deliberately inert: a fresh session
 *  hides nothing and rewrites nothing. */
const DEFAULT_POLICIES: SessionPolicies = {
	compaction: { enabled: false, threshold: 120_000 },
	reasoning:  { effort: 'medium', mode: 'chain' },
	tools:      { enabled: true },
	// ON unless the opener says otherwise: nearly every session IS a chat surface, and a default that
	// stripped the roster would silently un-teach every agent the forms the renderer honours.
	chat:       { enabled: true },
	// Finite on purpose: a turn that needs more rounds is a job for a governor across turns.
	limits:     { maxRounds: 24 },
};

/**
 * Session — the conversation-identity primitive. Pure data + a handful of mutators; no `fs`,
 * no file backing. It persists as a `sessions` DB row and rides the bridge as serialized JSON.
 */
export class Session {

	readonly id: string;
	/** The workspace this session ran in ( see SerializedSession.projectId ). Readonly for the agent's
	 *  reason: set once at birth, from the agent it was spawned under. */
	readonly projectId: string;
	/** Mutable now ( was readonly ) — a draft session is born agentless ('') and reassigned once the
	 *  user picks an agent. '' is the unassigned sentinel; hasAgent() is the readable check. */
	agentId: string;
	title: string | null;
	/** Grouping label — flat, one level. Null = ungrouped. */
	folder: string | null;
	tags: string[];
	/** The plan this session was opened to write; 0 for none. READONLY, because it is what the session was
	 *  opened for rather than something about it now — see `SerializedSession.planId`. */
	readonly planId: number;
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

	/** The typed, ordered transcript of turns. NON-PERSISTED: rebuilt on arrival via bindTranscript(); the home of
	 *  record is the DB `entries` rows. */
	transcript: Transcript = Transcript.empty();

	/** The summaries standing in for the turns they cover. NON-PERSISTED, like `transcript`; the home of record is
	 *  the `session_compactions` table. */
	compactions: SessionCompaction[] = [];

	/** Absolute path of this session's tool-result spill log, bound on arrival. '' is the OFF switch. Bound on every
	 *  session safely: a stub comes only from a tool-result entry, and only the spill loop writes those. */
	resultLogPath: string = '';

	/** Entries made but not yet carried by a turn. NON-PERSISTED. They drain onto the next turn ahead of the prompt,
	 *  which keeps a Turn atomic. `TurnEntry[]`, not `Grant[]`: a policy change is queued here too and is not a grant. */
	pendingEntries: TurnEntry[] = [];

	/** The caller's own frame, riding ABOVE the agent's compile. RUNTIME ONLY, never serialized. A surface cannot set
	 *  it: it sends a `brief`, and main renders that beside this field. */
	frame: string = '';

	/** WHY this session was opened, kept so its frame can be rendered at every compile, a restart included.
	 *  See `SessionBrief`. */
	brief: SessionBrief | null = null;

	/**
	 * The digest of the project configuration this session was last told. Never pushed: a session discovers a change at
	 * its own next turn. NULL = never compiled, and announces nothing, since the baseline is set silently. RUNTIME ONLY, like `frame`.
	 */
	lastConfigStamp: string | null = null;

	/**
	 * The project notice as this session was told it, captured once at its first compile and frozen for its life. NULL =
	 * not yet captured; '' = captured as no notice. Frozen so an edit reaches the NEXT session, not running ones: it also
	 * keeps the cached prefix stable. RUNTIME ONLY; written by `Environment._projectNotice` and nowhere else.
	 */
	projectNotice: string | null = null;

	/**
	 * When the person last saw this session's newest output, epoch ms. NULL is a real state, never read-long-ago: a fork is
	 * born null. Marked only while on screen AND focused; marking on mount would make every opened session read caught-up forever.
	 */
	readAt: number | null = null;

	/** WHO THIS SESSION RUNS AS, bound not held. A resolver, not an Agent: an Agent is rebuilt on reload, so a held one goes stale. */
	private _resolveAgent: ( () => Agent | null ) | null = null;

	private constructor(
		id: string,
		projectId: string,
		agentId: string,
		planId: number,
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
		this.projectId  = projectId;
		this.agentId    = agentId;
		this.planId     = planId;
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

	/** Spawn a fresh session. `agentId` omitted or '' makes a DRAFT, inert until reassign(). */
	/** Turns a fork from a lane carries: five complete turns, enough for the work in hand and cheaper than its source. */
	static readonly FORK_KEEP_TURNS = 5;

	static create( opts: SessionOptions ): Session {
		const now     = Date.now();
		const session = new Session(
			opts.id ?? crypto.randomUUID(),
			opts.projectId ?? '',
			opts.agentId ?? '',
			opts.planId ?? 0,
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
		// Assigned rather than constructed, as `frame` is: both are layers a caller hangs on a session, not
		// part of what a session IS.
		session.brief = opts.brief ?? null;
		return session;
	}

	/** Rebuild from the wire / DB seed. */
	static fromSerialized( json: SerializedSession ): Session {
		const session = new Session(
			json.id,
			json.projectId ?? '',   // absent on a payload written before sessions carried their project
			json.agentId ?? '',
			json.planId ?? 0,   // absent on a row written before a session could name a plan
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
		session.brief = json.brief ?? null;
		// Absent on a row or payload written before the marker existed, which reads as never seen — exactly
		// what it means, so there is nothing to default here.
		session.readAt = json.readAt ?? null;
		return session;
	}

	/**
	 * Hydrates a policy bag from any wire or row: the ONE reader of the legacy shape. An unreadable policy falls to
	 * inert defaults, never to unreachable history.
	 */
	static policiesFrom( raw: unknown ): SessionPolicies {
		const v = ( raw ?? null ) as Record<string, unknown> | null;
		if ( !v || typeof v !== 'object' ) return { ...DEFAULT_POLICIES };
		// A stored `retention` entry is retired (2026-09-16) and dropped on the next write.
		return {
			compaction: ( v[ 'compaction' ] as CompactionPolicy ) ?? { ...DEFAULT_POLICIES.compaction },
			reasoning:  ( v[ 'reasoning' ]  as ReasoningPolicy  ) ?? { ...DEFAULT_POLICIES.reasoning  },
			tools:      ( v[ 'tools' ]      as ToolsPolicy      ) ?? { ...DEFAULT_POLICIES.tools      },
			chat:       ( v[ 'chat' ]       as ChatPolicy       ) ?? { ...DEFAULT_POLICIES.chat       },
			limits:     ( v[ 'limits' ]     as LimitsPolicy     ) ?? { ...DEFAULT_POLICIES.limits     },
		};
	}

	/** The bridge wire form, the save form, the reconstruction source — one function, many purposes. */
	/**
	 * FORK FROM ITS LANE: a sibling re-authored as though opened fresh, not a compaction. Nothing is cached yet,
	 * so the child is WRITTEN correctly rather than patched: no compaction records, no summaries, no compacted turns.
	 *
	 * Text is never compressed; only the count of turns carried is chosen. Grant entries are stripped from the copied
	 * turns and the current set seeded once onto `pendingEntries`, so the authorization is restated rather than replayed.
	 * The caller places what comes back.
	 */
	forkFromLane( opts: { keepTurns?: number; title?: string | null } = {} ): Session {
		const child = Session.create( {
			projectId:  this.projectId,
			agentId:    this.agentId,
			title:      opts.title ?? null,
			folder:     this.folder,
			tags:       [ ...this.tags ],
			zoom:          this.zoom,
			fontFamily:    this.fontFamily,
			policies:      this.policies,
		} );

		// COMPLETE turns only. A failed turn never landed and an empty one has nothing in it, so carrying
		// either spends the child's window on something that was not part of the conversation.
		const whole = this.transcript.allTurns().filter( ( t ) => !t.failed && t.entries.length > 0 );
		const keep  = Math.max( 0, opts.keepTurns ?? Session.FORK_KEEP_TURNS );

		child.transcript = new Transcript( whole.slice( -keep ).map( ( t ) => ( {
			...t,
			entries: t.entries.filter( ( e ) => !isGrant( e ) ),
			// Born included and unmarked: a child has no compaction records to derive `compacted` from.
			include:   true,
			compacted: false,
		} ) ) );

		// The reorientation is text in the conversation, not session state, so it survives a reload as history.
		child.pendingEntries = [ { at: Date.now(), kind: 'user', text: frameFork() }, ...this._currentGrants() ];
		return child;
	}

	/**
	 * Every grant held, as entries and as of now: the last word per subject, revoked ones dropped. Flat, where
	 * `grants()` and its tiers are not, because a child being authored fresh has no compaction history.
	 */
	private _currentGrants(): TurnEntry[] {
		const out = new Map<string, Grant>();
		for ( const turn of this.transcript.allTurns() ) {
			for ( const entry of turn.entries ) {
				if ( !isGrant( entry ) ) continue;
				out.set( grantSubject( entry ), entry );
			}
		}
		for ( const entry of this.pendingEntries ) {
			if ( isGrant( entry ) ) out.set( grantSubject( entry ), entry );
		}
		return [ ...out.values() ]
			.filter( ( g ) => !g.removed )
			.map( ( g ) => ( { ...g } ) );
	}

	serializeForWire(): SerializedSession {
		return {
			id:         this.id,
			projectId:  this.projectId,
			agentId:    this.agentId,
			planId:     this.planId,
			title:      this.title,
			folder:     this.folder,
			tags:       [ ...this.tags ],
			createdAt:  this.createdAt,
			lastActive: this.lastActive,
			// Always written, null included: a marker the renderer cannot see is the whole feature missing.
			readAt:     this.readAt,
			status:     this.status,
			zoom:          this.zoom,
			fontFamily:    this.fontFamily,
			policies:      this.policies,
			brief:         this.brief,
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

	/** Set how this session's chat is READ — text zoom and font family. Either may be null to fall back
	 *  to the render side's default. The chat header's A-/A+ and font controls call this. */
	setDisplay( zoom: number | null, fontFamily: FontFamilyKey | null ): void {
		this.zoom = zoom;
		this.fontFamily = fontFamily;
	}

	/**
	 * Records that the person has seen this session as it stands. Only moves forward: an out-of-order call must not
	 * un-read a conversation somebody is looking at.
	 */
	markRead( at: number ): void {
		if ( this.readAt !== null && at <= this.readAt ) return;
		this.readAt = at;
	}

	// ── Transcript ( the dynamic half of the wire ) ─────────────────────────────

	/**
	 * OPEN this turn and put into it everything said before the model answers: the attachments that
	 * accumulated between sends, then the prompt itself.
	 *
	 * The session owns this because every part of it is session state — the pending list exists precisely
	 * because between sends there is no turn to hold them. Grant CONTENTS are NOT filled here: reading a
	 * file off disk is a main-side capability, so the caller hydrates the entries this returns.
	 */
	openTurn( prompt: { id: string; text: string } ): Turn {
		const turn = this.transcript.openTurn( prompt.id, Date.now() );
		for ( const attachment of this.pendingEntries ) this.transcript.append( attachment, turn );
		this.pendingEntries = [];
		this.transcript.append( { at: Date.now(), kind: 'user', text: prompt.text }, turn );
		return turn;
	}

	/** Rebuild the transcript wholesale from a turn list. Non-persisted: serializeForWire never writes it. */
	bindTranscript( turns: Turn[] ): void {
		this.transcript = new Transcript( turns );
	}

	/** Rebuild the compaction list wholesale, rebound whenever a pass writes one, so the next send is narrowed at once. */
	bindCompactions( compactions: SessionCompaction[] ): void {
		this.compactions = compactions;
	}

	/** Bind the result log path once at registration, so every reader sees the same path. */
	bindResultLog( path: string ): void {
		this.resultLogPath = path;
	}

	/** Bind the agent resolver — see `_resolveAgent`. */
	bindAgent( resolve: () => Agent | null ): void {
		this._resolveAgent = resolve;
	}

	/** This session's live Agent, or null when it has none: an unbound session ( nobody said how to answer )
	 *  or a DRAFT one ( no agent assigned yet ). Absence, not failure — the caller decides what that means. */
	agent(): Agent | null {
		return this._resolveAgent?.() ?? null;
	}

	/** Set ONE named policy, leaving its siblings alone. No policy touches the transcript. Named, not whole-bag: a
	 *  whole-bag setter lets one control silently revert another. */
	setPolicy<K extends keyof SessionPolicies>( name: K, policy: SessionPolicies[ K ] ): void {
		this.policies = { ...this.policies, [ name ]: policy };
	}

	/** Flip the run state. Never persisted. Bracket every turn from a `finally`, so a failure cannot strand a session lit. */
	setTurnStatus( status: TurnStatus ): void { this.turnStatus = status; }

	/** The transcript as it RIDES: `windowed()` first, then `compacted()`. Private and SHARED, because wireMessages(),
	 *  estimateTokens() and resultStubs() must never disagree about what rides, or the gauge lies about the send. */
	private _projected(): Transcript {
		return this.transcript
			.windowed()
			.compacted( this.compactions );
	}

	// ── THREE READERS OVER ONE TRANSCRIPT ────────────────────────────────────────────────────────────
	//
	// `attachments()` is the deck, `grants()` is what is authorized, `hoistedGrants()` is what must reach the manifest.
	// Compaction takes an entry off the deck but never out of the authorization: merge them and a permission silently
	// expires at a compaction nobody asked for.

	/**
	 * Every attachment carried, on a turn or pending. ONE reader, so the gutter and the compactor agree. Reads the whole
	 * transcript, not `_projected()`: a file a retention window narrowed past is still attached.
	 */
	attachments(): Grant[] {
		return [ ...this.transcript.attachments(), ...this.pendingEntries.filter( isGrant ) ];
	}

	/**
	 * What this session is AUTHORIZED to reach, deduped by subject. A grant ends only when the user revokes it, never by
	 * compaction. Returns `GrantRef`: what is permitted, never how it arose.
	 */
	grants(): GrantRef[] {
		const out = new Map<string, GrantRef>();
		// Live grants, revoked or not: a revocation stays pending until the compaction that executes it.
		for ( const turn of this.transcript.allTurns() ) {
			if ( turn.compacted ) continue;
			for ( const entry of turn.entries ) {
				if ( !isGrant( entry ) ) continue;
				out.set( grantSubject( entry ), _ref( entry ) );
			}
		}
		for ( const entry of this.pendingEntries ) {
			if ( !isGrant( entry ) ) continue;
			out.set( grantSubject( entry ), _ref( entry ) );
		}
		// …plus canonized grants: compaction moves a grant out of the transcript, never out of the authorization.
		for ( const g of this.hoistedGrants() ) out.set( g.subject, g );
		return [ ...out.values() ];
	}

	/**
	 * The CANONIZED grants as manifest rows — what/where/why, in the shape every other manifest table uses.
	 *
	 * `why` is the same for all of them and says so plainly: a user granted this. That is not filler — it is
	 * the whole authorization model in the one place the agent reads it, and an agent that knows a
	 * capability came from the person it is working for reasons about it differently than one that found it
	 * lying in its configuration.
	 *
	 * STRUCTURED ROWS, NOT PROSE, and that is the whole correction. This returned a pre-joined string, which
	 * read like the shape every other manifest section uses and was not it: a manifest section is MERGED,
	 * and the merge reads each block's structured `rows` and re-renders from them by design — it never
	 * parses rendered text back apart. A block carrying only text therefore contributed no rows, so every
	 * canonized grant was dropped on the way to the wire and the heading arrived alone. The empty `## Grants`
	 * people saw was not a cosmetic slip; it was the entire section failing to say anything.
	 *
	 * `where` is the SUBJECT, which is also what the merge dedupes on — correct here rather than incidental,
	 * because a grant's identity IS its subject. Two grants for one path are one row, exactly as two lenses
	 * pointing at one reference are.
	 *
	 * Empty when nothing has been canonized, so the section drops out of the manifest rather than riding as
	 * a heading with nothing under it.
	 */
	grantRows(): SlotRow[] {
		return this.hoistedGrants().map( ( g ) => ( {
			what:  g.kind,
			where: g.subject,
			why:   'granted by the user for this session'
		} ) );
	}

	/**
	 * The grants to CANONIZE into the manifest: those whose turns are compacted. A MOVE between tiers, never a copy,
	 * since a live reference line already states the fact. A removed grant is simply not promoted.
	 */
	hoistedGrants(): GrantRef[] {
		const live = new Set<string>();
		const out  = new Map<string, GrantRef>();
		for ( const turn of this.transcript.allTurns() ) {
			for ( const entry of turn.entries ) {
				if ( !isGrant( entry ) ) continue;
				const subject = grantSubject( entry );
				if ( !turn.compacted ) { live.add( subject ); continue; }
				// Revoked and compacted: not promoting it is the revocation executing.
				if ( entry.removed ) { out.delete( subject ); continue; }
				out.set( subject, _ref( entry ) );
			}
		}
		// A re-injection on a LIVE turn un-hoists it: the reference is riding again, so the manifest row
		// would be the duplicate this method exists to avoid.
		for ( const subject of live ) out.delete( subject );
		return [ ...out.values() ];
	}

	/**
	 * The attachments that RIDE: the window's, not the whole transcript's. A file on a compacted turn is attached but must
	 * not ride again, or its history is paid for twice. A non-replaying tier needs this by name.
	 */
	projectedAttachments(): Grant[] {
		return this._projected().attachments();
	}

	/** The dynamic half of the wire: the projected transcript as neutral messages, thinking excluded. Every policy is
	 *  applied here, at the projection; the transcript itself is never edited. */
	wireMessages( opts?: WireOptions ): WireMessage[] {
		return this._projected().wireMessages( this._wireOpts( opts ) );
	}

	/**
	 * One turn, projected as the window is: two projections of one transcript, never two formats. A tier that keeps its own
	 * history must not replay the window, or it stacks duplicates in its cached prefix. Not windowed or compacted.
	 */
	wireTurn( turn: Turn, opts?: WireOptions ): WireMessage[] {
		return new Transcript( [ turn ] ).wireMessages( this._wireOpts( opts ) );
	}

	/**
	 * Everything BEFORE this turn, as it stood when the turn opened. Used to re-seed a transport that lost its history;
	 * sending the live turn twice is the failure this exists to avoid.
	 */
	wireBefore( turn: Turn, opts?: WireOptions ): WireMessage[] {
		const before = this._projected().allTurns().filter( ( t ) => t !== turn );
		return before.length ? new Transcript( before ).wireMessages( this._wireOpts( opts ) ) : [];
	}

	/**
	 * `toolUseId` → its 1-based line in the result log. Counted over the WHOLE transcript, because the log keeps what
	 * compaction covered. A count, not a stored map: the writer walks the same turns in the same order, so changing the
	 * write order makes every stub already sent wrong.
	 */
	private _resultLines(): Map<string, number> {
		const lines = new Map<string, number>();
		let n = 0;
		for ( const turn of this.transcript.allTurns() ) {
			for ( const entry of turn.entries ) {
				if ( entry.kind === 'tool-result' ) lines.set( entry.toolUseId, ++n );
			}
		}
		return lines;
	}

	/**
	 * The caller's options with this session's reduction folded in, composed here so every reader agrees. No log path
	 * means no reduction: a stub naming a file that does not exist is worse than the result it replaced.
	 */
	private _wireOpts( opts?: WireOptions ): WireOptions | undefined {
		if ( !this.resultLogPath ) return opts;
		return {
			...opts,
			toolResults: { keepTurns: KEEP_TOOL_RESULT_TURNS, logPath: this.resultLogPath, lines: this._resultLines() }
		};
	}

	/**
	 * The pointer text for tool results that will not ride whole, keyed by `tool_use_id`. Stub text, not a flag, so the
	 * marker a user reads and the text the model receives are one string. With no log, there are no stubs.
	 */
	resultStubs( ids?: Iterable<string> ): Map<string, string> {
		const out       = new Map<string, string>();
		const opts      = this._wireOpts();
		const reduction = opts?.toolResults;
		if ( !reduction ) return out;
		for ( const id of ids ?? this._projected().stubbedResults( opts ) ) {
			out.set( id, frameToolResultStub( reduction.logPath, reduction.lines?.get( id ), id ) );
		}
		return out;
	}

	/** The inspector itinerary: one block per turn, unwindowed so history never looks like it vanished. Rows carry the
	 *  stub the wire is about to send; a compacted row carries none, because it does not ride. */
	transcriptTurns(): TranscriptTurn[] {
		return this.transcript.turnRows( this.resultStubs() );
	}

	/** The session's own context cost: the wire weight of the projected transcript, priced on what will actually ride.
	 *  Takes the same options as the wire through `_wireOpts`, so the gauge and the send cannot drift. */
	estimateTokens( opts?: WireOptions ): number {
		return this._projected().estimateTokens( this._wireOpts( opts ) );
	}

	/**
	 * A display title even when none was set. The placeholder says the first prompt has not been named yet, and nothing more.
	 */
	displayTitle(): string {
		if ( this.title ) return this.title;
		return 'New session';
	}
}

/**
 * One transcript entry read as an authorization. A field added to `GrantRef` must reach all three producers, or it is
 * silently dropped.
 */
function _ref( entry: Grant ): GrantRef {
	return { kind: grantKind( entry ), subject: grantSubject( entry ), level: grantLevel( entry ) };
}
