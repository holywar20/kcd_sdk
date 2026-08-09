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

import { Transcript, type Turn, type WireMessage, type WireOptions, type TranscriptTurn, type RetentionPolicy, type CompactionPolicy, type SessionPolicies, type SessionCompaction, type Grant, isGrant, grantSubject, grantKind, frameToolResultStub, KEEP_TOOL_RESULT_TURNS } from './TurnEntry';
import { type GrantRef } from './InjectedItem';

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
	/** The workspace this session ran in ( `projects.id` ). Denormalized from its agent rather than
	 *  derived through it, so a DRAFT session — which has no agent — still carries one. */
	projectId: string;
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
	/** The owning workspace ( `projects.id` ) — the spawning caller resolves it from the agent. */
	projectId?: string;
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

	/** Where this session's tool results are SPILLED — the absolute path of its result log, as
	 *  `frameToolResultStub` names it and `read_file` resolves it. The same species as `transcript` and
	 *  `compactions`: non-persisted object state, never in SerializedSession, bound on arrival.
	 *
	 *  BOUND rather than derived because the log lives under the app's userData, which is an Electron fact
	 *  with no business in a Node-free package. '' until bound, and that emptiness is the OFF switch for the
	 *  whole reduction: a session with nowhere to point cannot honestly stub anything.
	 *
	 *  It is bound UNCONDITIONALLY, on every session, and what makes that safe is an invariant rather than a
	 *  check: a stub is only ever produced for a tool-result ENTRY, and the only writer of tool-result entries
	 *  is the loop that spills them. So a session with no results has an empty stub set and never names the
	 *  file, while a session with results has necessarily written it. The tier that runs its own tools
	 *  ( Claude Code ) records no results here at all, which is why it needs no exception. */
	resultLogPath: string = '';

	/** Attachments made but NOT yet carried by a turn. The same species as `transcript`: non-persisted
	 *  object state, never in SerializedSession. They drain onto the turn the orchestrator opens, ahead of
	 *  the user's prompt — which is what makes them persist for free ( the turn's `entries` column is
	 *  written when it ends ) and keeps a Turn atomic: a prompt plus everything that answered it. Before
	 *  the first send there is no turn to hold them, which is the whole reason this list exists. */
	pendingAttachments: Grant[] = [];

	private constructor(
		id: string,
		projectId: string,
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
		this.projectId  = projectId;
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
			opts.projectId ?? '',
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
			json.projectId ?? '',   // absent on a payload written before sessions carried their project
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
			projectId:  this.projectId,
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

	/** Bind the result log's path — the only main-only fact the reduction needs. Bound once at registration
	 *  rather than per-read, so the readers that consult it cannot be handed different paths. */
	bindResultLog( path: string ): void {
		this.resultLogPath = path;
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

	/** The transcript as it will actually RIDE — retention first ( which turns survive, read off each
	 *  turn's own `include` flag ), compaction second ( the summary put in front of what survived ).
	 *
	 *  The order no longer carries the weight it used to. Compaction ran last to stop a narrow retention
	 *  from smuggling a covered turn back in — impossible now, because a covered turn was marked
	 *  `include: false` once by `compactThrough()` and `windowed()` has already dropped it before
	 *  `compacted()` is reached. The sequence is what reads naturally, not a rule holding a bug shut.
	 *
	 *  Private and SHARED, because wireMessages() and estimateTokens() are the two readers that must never
	 *  disagree about what rides — the moment they compose the policies separately, the gauge starts lying
	 *  about the send. A third policy composes here and both readers get it for free. `_resultStubs()` is a
	 *  third reader now, and it asks the same question of the same projection for the same reason.
	 *
	 *  Neither step edits the transcript: both build a new one, and the itinerary still shows every turn
	 *  that ever happened. Note the asymmetry in what re-widening buys, though — a retention change hands
	 *  back the turns it dropped, while a compacted turn is gone from the wire for good. It stays in the
	 *  account of what happened; it is simply no longer context. */
	private _projected(): Transcript {
		return this.transcript
			.windowed( this.policies.retention )
			.compacted( this.compactions );
	}

	// ── THREE READERS OVER ONE TRANSCRIPT ────────────────────────────────────────────────────────────
	//
	// `attachments()`, `grants()` and `hoistedGrants()` all walk the same grant entries and all read like
	// "the injected things". They are not redundant, and collapsing any two of them breaks something
	// quietly rather than loudly. Each answers a genuinely different question:
	//
	//   attachments()   — what is on the DECK?           live entries + pending. What the gutter draws.
	//   grants()        — what is AUTHORIZED?            live + pending + hoisted. What a gate asks.
	//   hoistedGrants() — what must reach the MANIFEST?  compacted, unrevoked, and not also live.
	//
	// They part company on the two axes that matter: whether COMPACTION removes an entry, and whether a
	// REVOCATION does. Compaction takes an entry off the deck but not out of the authorization — a
	// permission does not expire because its turn got summarised. A revocation is pending on both until
	// the compaction that executes it, so a revoked grant still shows and still authorizes until then.
	//
	// `hoistedGrants()` is a SUBSET of `grants()` and disjoint from `attachments()` by construction: it
	// exists for exactly the entries the deck has stopped showing. That is what makes the hoist a MOVE
	// between tiers rather than a copy.
	//
	// Merge them and either the gutter starts drawing compacted files, or a permission silently expires at
	// a compaction the user never asked for and cannot see.

	/**
	 * Every attachment this session carries — those already on a turn plus anything attached since the
	 * last send. ONE reader, so the gutter and the compactor cannot disagree about a file the user
	 * attached thirty seconds ago and has not sent yet.
	 *
	 * Reads the whole transcript rather than `_projected()`, and the difference is deliberate: a file the
	 * RETENTION window narrowed past is still attached, because that policy can be widened back and a chip
	 * flickering in and out with the window is unusable. A COMPACTED turn's files are gone from the list —
	 * `Transcript.attachments()` draws that line, and draws it once.
	 */
	attachments(): Grant[] {
		return [ ...this.transcript.attachments(), ...this.pendingAttachments ];
	}

	/**
	 * What this session is AUTHORIZED to reach — the answer a gate asks for, deduped by subject.
	 *
	 * Reads the whole transcript rather than the deck, and the difference is the whole point: the deck
	 * hides a compacted turn's entries because they stopped being CONTEXT, while a permission granted an
	 * hour ago is still a permission. A grant ends when the user revokes it and at no other moment.
	 *
	 * Returns `GrantRef`, which says what is permitted and never how the permission arose. Today every one
	 * comes from an injection; a second producer adds to this list without anything downstream noticing,
	 * which is the property that makes it usable as an authorization surface rather than a view of the
	 * gutter.
	 */
	grants(): GrantRef[] {
		const out = new Map<string, GrantRef>();
		// LIVE grants — every uncompacted entry, revoked or not. A revocation is PENDING, exactly as the
		// context half of it is: the user is managing what the agent is looking at, not slamming a security
		// door, and nobody revokes a file to ban it from a session within the same turn. Honouring it
		// instantly would buy a re-prefill for a distinction no one asked for.
		for ( const turn of this.transcript.allTurns() ) {
			if ( turn.compacted ) continue;
			for ( const entry of turn.entries ) {
				if ( !isGrant( entry ) ) continue;
				out.set( grantSubject( entry ), { kind: grantKind( entry ), subject: grantSubject( entry ) } );
			}
		}
		for ( const entry of this.pendingAttachments ) {
			out.set( grantSubject( entry ), { kind: grantKind( entry ), subject: grantSubject( entry ) } );
		}
		// …plus everything already CANONIZED. A compacted grant left the transcript but not the session: that
		// is what promotion means, and an authorization that evaporated the moment its turn was summarised
		// would make compaction silently revoke things nobody revoked.
		for ( const g of this.hoistedGrants() ) out.set( g.subject, g );
		return [ ...out.values() ];
	}

	/**
	 * The CANONIZED grants as manifest rows — what/where/why, one line each, in the shape every other
	 * manifest table uses.
	 *
	 * `why` is the same for all of them and says so plainly: a user granted this. That is not filler — it is
	 * the whole authorization model in the one place the agent reads it, and an agent that knows a
	 * capability came from the person it is working for reasons about it differently than one that found it
	 * lying in its configuration.
	 *
	 * '' when nothing has been canonized, so the section drops out of the manifest entirely rather than
	 * riding as an empty heading.
	 */
	grantManifest(): string {
		const rows = this.hoistedGrants().map( ( g ) => `- ${ g.kind } · ${ g.subject } · granted by the user for this session` );
		return rows.length ? rows.join( '\n' ) : '';
	}

	/**
	 * The grants that must be CANONIZED into the manifest — those whose turns have been compacted, and
	 * whose transcript line therefore no longer rides.
	 *
	 * The hoist is a MOVE between tiers, never a copy: while a grant's turn still rides, its reference line
	 * is already in context and a manifest row beside it would state the same fact twice. Promotion waits
	 * for compaction for the reason every deferred mutation does — that is the one moment the prefix is
	 * being rewritten anyway, so the cache miss is already paid for.
	 *
	 * COMPACTION IS ALSO WHERE A REVOCATION LANDS, and the two rules turn out to be one rule read from both
	 * ends: a grant that survives compaction is canonized, and a grant marked removed simply is not. So the
	 * pass that rewrites the prefix settles every pending decision at once, and nothing needs a second
	 * mechanism to execute a revocation — not-promoting IS the execution.
	 */
	hoistedGrants(): GrantRef[] {
		const live = new Set<string>();
		const out  = new Map<string, GrantRef>();
		for ( const turn of this.transcript.allTurns() ) {
			for ( const entry of turn.entries ) {
				if ( !isGrant( entry ) ) continue;
				const subject = grantSubject( entry );
				if ( !turn.compacted ) { live.add( subject ); continue; }
				// Revoked AND compacted: the pending revocation EXECUTES here, by the grant simply not being
				// promoted. Nothing else has to run — not-promoting is the execution, which is why one pass
				// settles both deferred decisions.
				if ( entry.removed ) { out.delete( subject ); continue; }
				out.set( subject, { kind: grantKind( entry ), subject } );
			}
		}
		// A re-injection on a LIVE turn un-hoists it: the reference is riding again, so the manifest row
		// would be the duplicate this method exists to avoid.
		for ( const subject of live ) out.delete( subject );
		return [ ...out.values() ];
	}

	/**
	 * The attachments that would RIDE — the WINDOW's, not the whole transcript's.
	 *
	 * The other half of the pair above, and the distinction is the same one `_projected()` draws: that one
	 * answers "what is attached" for the gutter, this one answers "what rides". A file on a compacted turn
	 * is still attached and must not ride again — the summary stands in for it, and re-sending it would pay
	 * for that history twice.
	 *
	 * Exists because a NON-REPLAYING tier needs it. Every other caller gets attachments for free inside
	 * `wireMessages()`, which projects the whole window; the harness tier is exempt from replaying that
	 * window and so must ask for this one part of it by name. It reads `_projected()` rather than composing
	 * the policies itself, for the reason that method exists at all: two readers that compose them
	 * separately start disagreeing about what rides the moment either policy changes.
	 *
	 * REMOVED entries come back, exactly as `attachments()` returns them — a removed file keeps riding as a
	 * pointer until its turn is compacted, and filtering here would be a second copy of a rule that lives at
	 * the projection.
	 */
	projectedAttachments(): Grant[] {
		return this._projected().attachments();
	}

	/** The DYNAMIC half of the wire — the projected transcript as neutral messages a connector maps to its
	 *  provider format ( thinking excluded ). Joins agent.wireSystem() ( the stable half ) at send: the
	 *  whole request is { system: agent.wireSystem(), messages: session.wireMessages() }. Every policy is
	 *  applied HERE, at the projection — the transcript itself is never edited.
	 *
	 *  `opts` passes through to the transcript, with the result-log LINE MAP filled in on the way ( see
	 *  `_resultLines` ). The caller supplies what only it can know — the model's `multimodal` declaration,
	 *  the log's path — and the Session supplies what only it can. */
	wireMessages( opts?: WireOptions ): WireMessage[] {
		return this._projected().wireMessages( this._wireOpts( opts ) );
	}

	/**
	 * `toolUseId` → its 1-based line in this session's result log.
	 *
	 * Read off the WHOLE transcript, and that is the crux of the whole mechanism rather than an
	 * implementation detail. `wireMessages()` runs on `_projected()`, which has already dropped everything a
	 * compaction covered — but the LOG still holds those results, because the writer spills what the
	 * transcript holds and never what the window kept. Counting in the projection would number every line
	 * short by however many results a compaction had replaced, and every stub would point at the wrong one.
	 *
	 * A COUNT, not a lookup. The writer walks the same turns in the same order, so the file and the pointer
	 * agree by construction — nothing coordinates them and no id-to-line map is persisted anywhere. What
	 * that buys is also what it costs: change the write order and every stub already sent is wrong.
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
	 * The caller's options with this session's REDUCTION folded in — the keep-window, the log path, and the
	 * line map. Private and shared by every reader, for the same reason `_projected()` is: they must not be
	 * able to disagree.
	 *
	 * Composed HERE rather than passed in, and that is the change. It used to be built at the send, which left
	 * the itinerary — which arrives through a pull channel and never touches a send — with no way to ask the
	 * same question without restating the answer. One producer, every reader.
	 *
	 * No log path, no reduction. That is absence, not failure: a session nothing has spilled for has no file
	 * to point at, and a stub naming one that does not exist is worse than the result it replaced.
	 */
	private _wireOpts( opts?: WireOptions ): WireOptions | undefined {
		if ( !this.resultLogPath ) return opts;
		return {
			...opts,
			toolResults: { keepTurns: KEEP_TOOL_RESULT_TURNS, logPath: this.resultLogPath, lines: this._resultLines() }
		};
	}

	/**
	 * Every tool result riding as a STUB on the next send, keyed by `tool_use_id` — the itinerary's copy of
	 * what the wire is about to do.
	 *
	 * The two halves count over DIFFERENT turn sets and both are right: WHICH results stub is a question about
	 * the projection ( the last N that ride ), while WHICH LINE each sits on is a question about all of
	 * history ( the log holds what compaction dropped ). This is the only object holding both, which is why
	 * the itinerary is handed an answer instead of the inputs to compute one.
	 *
	 * The stub TEXT, not a flag — so the marker a user reads and the text the model receives are the same
	 * string, produced once. A boolean would have left the display to re-frame it, and the wording is the
	 * whole point of the stub.
	 */
	private _resultStubs(): Map<string, string> {
		const out       = new Map<string, string>();
		const opts      = this._wireOpts();
		const reduction = opts?.toolResults;
		if ( !reduction ) return out;
		for ( const id of this._projected().stubbedResults( opts ) ) {
			out.set( id, frameToolResultStub( reduction.logPath, reduction.lines?.get( id ), id ) );
		}
		return out;
	}

	/** The inspector itinerary — one BLOCK per turn, each carrying the entries that happened inside it
	 *  ( thinking included ). DELIBERATELY UNWINDOWED: the Turns folder is the account of what actually
	 *  happened, and a narrow policy must not make history look like it vanished. ( Marking which turns
	 *  are in-window is a display concern for the folder itself. ) The System folder reads
	 *  agent.wireSystem().
	 *
	 *  Rows carry the STUB the wire is about to send in their place — a reduction nobody can see is
	 *  indistinguishable from a bug. A row on a COMPACTED turn carries none, which is correct rather than an
	 *  omission: it does not ride at all, so calling it stubbed would claim it does. */
	transcriptTurns(): TranscriptTurn[] {
		return this.transcript.turnRows( this._resultStubs() );
	}

	/** The session's own context cost — the wire weight of the PROJECTED transcript ( self-priced per
	 *  entry ), so it prices what will actually ride rather than everything ever said: a compacted session
	 *  is priced on its summary, which is the whole reason a user compacts one. Reads the same _projected()
	 *  the wire does, so the number cannot drift from the send. The whole-context estimate folds this onto
	 *  agent.estimateTokens(); a caller sums the two halves.
	 *
	 *  Takes the same options the wire does, through the same `_wireOpts` — a gauge that prices an
	 *  unreduced transcript while the wire sends a reduced one is the exact drift both readers exist to
	 *  prevent. A caller that passes nothing prices the transcript whole, which is still honest: that is
	 *  what an unreduced send costs. */
	estimateTokens( opts?: WireOptions ): number {
		return this._projected().estimateTokens( this._wireOpts( opts ) );
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
