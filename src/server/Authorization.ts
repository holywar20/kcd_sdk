import { ACCESS_LEVELS, INJECTED_KINDS, type AccessLevel, type InjectedKind, type GrantRef } from '../session/InjectedItem';
import { parseAccessList, type AccessEntry } from '../core/AccessPolicy';

/**
 * What the host asserts about one turn's capability exceptions, and how both ends read it back.
 *
 * Two lanes share no carrier: in-process rides `_meta` on the `tools/call`; harness rides the child's environment,
 * and publishToChild writes every variable in one call. Each writer names its lane, because a fact carried on one
 * and forgotten on the other works in the app and does nothing under the harness. `_meta` sits beside `arguments`,
 * which the model writes, so an authorization inside `arguments` would let the agent authorize itself.
 *
 * The grant on the wire is the permission, with no other state: re-asserted on every call, revoked by not sending it.
 * Both ends read this one file, so they cannot drift.
 */
/**
 * Exported so the writer and reader name them once: a literal duplicated across a process boundary is a silent
 * no-grant the first time one side is edited. Two variables, not one payload: an older child handed an object
 * where it expects an array counts it as one dropped entry and asserts nothing.
 */
export const GRANT_ENV  = 'STARMIND_GRANTS';
export const ACCESS_ENV = 'STARMIND_ACCESS';

/**
 * What the host publishes to one per-turn harness child: the turn's grants and the floor they except from.
 * One shape, because they are published together or not at all: exceptions without their floor leave the
 * agent's permissions to whatever another lane last wrote.
 */
export interface HarnessAuthorization {
	grants: readonly GrantRef[];
	access: readonly AccessEntry[];
	/**
	 * The WORKSPACE both of the above are scoped to; empty when no project backs the turn. It is the TURN's project,
	 * not the active one, and the two diverge when a person switches project mid-run.
	 *
	 * Not published to the child, which resolves paths and is pointed at its workspace by the host.
	 */
	projectId: string;
}

/**
 * How a published floor arrived. Four names, because behaviour and diagnosis want different cuts of one answer,
 * and collapsing them hides a fallback.
 *
 *   absent     — no variable: fall back to configuration.
 *   unexpanded — the literal `${…}` arrived: a transport failure, so it behaves as absent but is named apart.
 *   published  — a floor; it IS the floor, including when empty.
 *   unreadable — published but unparseable: grants nothing, and no other floor is substituted.
 */
export type FloorState = 'absent' | 'unexpanded' | 'published' | 'unreadable';

/**
 * WHO a call is on behalf of. Attribution only, never read to decide a verdict. Unlike `projectId`, it carries
 * a string a person wrote, which is the cost of having one writer.
 */
export interface AskerRef {
	agentId:   string | null;
	agentName: string | null;
	traceId:   string;
}

/**
 * The gate's answer for ONE step of a composite call, by position. `null` is a step the gate did not judge, and it
 * is never a pass. A name that is no sibling's is answered in the same words as a sibling never offered, because a
 * tool that tells them apart tells an agent which guesses are real. A composite with no verdicts at all refuses
 * every step, because the call went round the gate.
 */
export type StepVerdict = { ok: true } | { ok: false; refusal: string } | null;

export const Authorization = {

	/**
	 * The in-process lane's `_meta` payload for one outgoing `tools/call`, or null when there is nothing to say, so a
	 * bare call stays byte-identical to one sent before any of this existed.
	 *
	 * It takes the PROJECT and its sibling does not: a project may be named to an in-process reader, never to a harness
	 * child. It carries the floor too, because a grant is an exception, and a reader holding one without its floor would
	 * find the other by asking whichever project is ACTIVE.
	 *
	 * `access`: absent and `[]` are opposite instructions. Absent says use the server's own configuration; empty says
	 * reach nothing. Only the caller knows which it means, and collapsing them restores the configuration where a host
	 * meant to deny, so the choice is made at the call site.
	 *
	 * `steps` rides here because `_meta` is client-written: a model cannot hand its own batch a verdict.
	 *
	 * `browseAll` is emitted only when true, since absent and false say the same. It is a single bit about the asking
	 * holder, and it crosses as the answer rather than a key, since the callee cannot resolve a passport.
	 */
	assertOnCall(
		grants:     readonly GrantRef[],
		projectId?: string,
		access?:    readonly AccessEntry[],
		asker?:     AskerRef,
		steps?:     readonly StepVerdict[],
		browseAll?: boolean
	): Record<string, unknown> | null {
		// Identity makes an asker, not the trace: an all-null identity names nobody. An asker still counts as
		// something to say, so an ungranted call carries who is behind it and a callee can ask a named person.
		const named = !!( asker && ( asker.agentId || asker.agentName ) );
		if ( grants.length === 0 && !projectId && !access && !named && !steps && !browseAll ) return null;
		const own: Record<string, unknown> = {};
		if ( grants.length ) own[ 'grants' ] = grants;
		if ( projectId )     own[ 'projectId' ] = projectId;
		if ( access )        own[ 'access' ] = access;
		if ( named )         own[ 'asker' ] = asker;
		if ( steps )         own[ 'steps' ] = steps;
		if ( browseAll )     own[ 'browseAll' ] = true;
		return { starmind: own };
	},

	/** The receiving end of the holder's web release valve: TRUE only for a literal `true`. Absent, false and
	 *  non-booleans all read as off, because the secure and absent answers are the same one. */
	browseAllOnCall( meta?: Record<string, unknown> ): boolean {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { browseAll?: unknown };
		return own.browseAll === true;
	},

	/** The receiving end of a composite call's verdicts — NULL when the envelope carries none, which the
	 *  composite reads as nothing judged. An entry that is not a well-formed verdict reads as unjudged. */
	stepsOnCall( meta?: Record<string, unknown> ): StepVerdict[] | null {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { steps?: unknown };
		if ( !Array.isArray( own.steps ) ) return null;
		const out: StepVerdict[] = [];
		for ( const raw of own.steps as unknown[] ) {
			const v = ( typeof raw === 'object' && raw !== null ? raw : {} ) as Record<string, unknown>;
			if ( v[ 'ok' ] === true )                                          out.push( { ok: true } );
			else if ( v[ 'ok' ] === false && typeof v[ 'refusal' ] === 'string' ) out.push( { ok: false, refusal: v[ 'refusal' ] as string } );
			else                                                                out.push( null );
		}
		return out;
	},

	/** The receiving end. UNDEFINED when the envelope named nobody — the inspector's Run button, a bare
	 *  widget call — because an all-null asker would be a second way to spell the same absence. */
	askerOnCall( meta?: Record<string, unknown> ): AskerRef | undefined {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { asker?: unknown };
		if ( typeof own.asker !== 'object' || own.asker === null ) return undefined;
		const a = own.asker as Record<string, unknown>;
		const agentId   = typeof a[ 'agentId' ]   === 'string' ? a[ 'agentId' ]   as string : null;
		const agentName = typeof a[ 'agentName' ] === 'string' ? a[ 'agentName' ] as string : null;
		if ( !agentId && !agentName ) return undefined;
		return { agentId, agentName, traceId: typeof a[ 'traceId' ] === 'string' ? a[ 'traceId' ] as string : '' };
	},

	/**
	 * Which project this call belongs to: a ROUTING key for an IN-PROCESS reader, and nothing else. A spawned server is
	 * never told its project this way, since that would put a lookup key on the wire for the receiver to trust; the
	 * host points it at its project by writing the resolved floor into its slice, so only answers cross.
	 * Trusted for the reason a grant is: `_meta` is client-written. An empty string is "no project on this call" and
	 * reads as no configured access, never as the default.
	 */
	projectId( meta?: Record<string, unknown> ): string {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { projectId?: unknown };
		return typeof own.projectId === 'string' ? own.projectId : '';
	},

	/**
	 * THE HARNESS LANE — EVERY variable a per-turn child is given, in one call, so a fact added to the publish cannot
	 * land on one variable and be forgotten on the other.
	 *
	 * BOTH ARE ALWAYS EMITTED, `[]` when there is nothing to say, unlike `assertOnCall`. The spawn config references
	 * these variables once, before any turn's grants are known, so an undefined one is a dangling reference, not "none".
	 *
	 * Bare arrays, not the `_meta` envelope: a dedicated variable has no neighbours to avoid. The types are identical
	 * across both carriers, which is the part that must never drift.
	 *
	 * SAFE ONLY FOR A PER-TURN CHILD. Env is fixed for a process's life, so a long-lived server would freeze its
	 * permissions at spawn. The harness child dies with each `claude` invocation; Starmind's own servers are pointed
	 * through their slice and never see these.
	 */
	publishToChild( auth: HarnessAuthorization ): Record<string, string> {
		return {
			[ GRANT_ENV ]:  JSON.stringify( auth.grants ),
			[ ACCESS_ENV ]: JSON.stringify( auth.access ),
		};
	},

	/**
	 * The receiving end of the published floor, for a spawned child. `entries` is null only when nothing was published,
	 * and the caller falls back to its own configuration. A published EMPTY floor is `[]` and grants nothing: reading it
	 * as "nothing published" would silently restore whatever the slice held. Those are opposite outcomes.
	 *
	 * An unexpanded `${…}` reads as ABSENT. It is a transport failure, not a statement about access, and denying every
	 * path over a failed substitution would take file access down for a reason nobody can see. `state` keeps that auditable.
	 */
	readFloor( raw: string | undefined ): { entries: AccessEntry[] | null; state: FloorState } {
		if ( !raw )                   return { entries: null, state: 'absent' };
		if ( raw.startsWith( '${' ) ) return { entries: null, state: 'unexpanded' };
		let parsed: unknown;
		try {
			parsed = JSON.parse( raw );
		} catch {
			return { entries: [], state: 'unreadable' };
		}
		if ( !Array.isArray( parsed ) ) return { entries: [], state: 'unreadable' };
		return { entries: parseAccessList( parsed ), state: 'published' };
	},

	/**
	 * The wire lane's contract, the same as `readFloor`'s: the four states and the null-versus-empty meaning.
	 * `unexpanded` is never returned here, since no string substitution happens on a wire envelope. The type is shared
	 * because the readers are, and faking the state to look symmetrical would invent a diagnosis.
	 *
	 * `unreadable` means something different on this lane. The envelope came from our own gate, so an unreadable floor
	 * is a Starmind defect rather than a transport failure to tolerate. It still fails closed, and a caller that only
	 * notes it has mistaken a bug for weather.
	 *
	 * Silent, like every parse in this file, because the spawned child has no logger; `state` is what the host reports.
	 */
	floorOnCall( meta?: Record<string, unknown> ): { entries: AccessEntry[] | null; state: FloorState } {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { access?: unknown };
		if ( own.access === undefined || own.access === null ) return { entries: null, state: 'absent' };
		if ( !Array.isArray( own.access ) )                    return { entries: [], state: 'unreadable' };
		return { entries: parseAccessList( own.access ), state: 'published' };
	},

	/** The grants asserted on a received call. Absence is NORMAL, never an error: every non-Starmind
	 *  client sends none, and so does an ungranted call from this one. PARSED, not cast — see parseGrants. */
	grants( meta?: Record<string, unknown> ): GrantRef[] {
		return Authorization.grantsCounted( meta ).grants;
	},

	/** The same read, plus what it REFUSED — for the one caller that logs the transport rather than using
	 *  it. See `parseGrantsCounted` for why a count is the only thing that makes a silent drop visible. */
	grantsCounted( meta?: Record<string, unknown> ): { grants: GrantRef[]; dropped: number } {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { grants?: unknown };
		return Authorization.parseGrantsCounted( own.grants );
	},

	/**
	 * Read a grant payload off EITHER carrier, the wire envelope or the environment variable. One parse for both, so the
	 * two cannot drift. FAILS CLOSED on everything: absent, unparseable, wrong shape, unknown kind and empty subject all
	 * yield no grant, including an unexpanded `${…}` that JSON.parse rejects.
	 *
	 * A MISSING LEVEL IS A MIGRATION, NOT A DEFAULT: a payload from before depths existed meant `read`, which can never
	 * reach write or delete. Both skews between host and bundle under-grant, and neither breaks. An unrecognised level
	 * drops the whole grant, because a level we cannot read is not one we may assume is shallow.
	 */
	parseGrants( raw: unknown ): GrantRef[] {
		return Authorization.parseGrantsCounted( raw ).grants;
	},

	/**
	 * The same parse, plus HOW MANY entries it refused. Rejections are silent by design: a throwing parser would turn one
	 * malformed grant into a dead tool call, and the spawned child has no logger. But a grant that fails closed and says
	 * nothing looks exactly like one never given, and those want opposite fixes, so the count goes to the HOST to report.
	 *
	 * A non-array payload counts as ONE drop, since calling an unreadable set zero would report nothing lost about the
	 * largest possible loss. Absent counts as zero: absence is the ordinary case for an ungranted call.
	 */
	parseGrantsCounted( raw: unknown ): { grants: GrantRef[]; dropped: number } {
		if ( raw === undefined || raw === null ) return { grants: [], dropped: 0 };
		if ( !Array.isArray( raw ) )            return { grants: [], dropped: 1 };
		const grants: GrantRef[] = [];
		let dropped = 0;
		for ( const item of raw ) {
			const grant = Authorization.parseGrant( item );
			if ( grant ) grants.push( grant );
			else dropped++;
		}
		return { grants, dropped };
	},

	/** One grant, or null when it cannot be read. Strict on all three fields: `subject` is what the jail
	 *  compares, `kind` is what the audit line reports and what decides whether this is a path grant at
	 *  all, and `level` is how much. */
	parseGrant( raw: unknown ): GrantRef | null {
		if ( typeof raw !== 'object' || raw === null ) return null;
		const g = raw as Record<string, unknown>;

		const subject = g[ 'subject' ];
		if ( typeof subject !== 'string' || !subject ) return null;

		const kind = g[ 'kind' ];
		if ( typeof kind !== 'string' || !INJECTED_KINDS.includes( kind as InjectedKind ) ) return null;

		const stated = g[ 'level' ];
		if ( stated === undefined ) return { kind: kind as InjectedKind, subject, level: 'read' };
		if ( !ACCESS_LEVELS.includes( stated as AccessLevel ) ) return null;
		return { kind: kind as InjectedKind, subject, level: stated as AccessLevel };
	},
};
