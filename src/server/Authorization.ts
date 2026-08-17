import { ACCESS_LEVELS, INJECTED_KINDS, type AccessLevel, type InjectedKind, type GrantRef } from '../session/InjectedItem';
import { parseAccessList, type AccessEntry } from '../core/AccessPolicy';

/**
 * Authorization — what the HOST asserts about one turn's capability exceptions, and how both ends of the
 * wire read it back.
 *
 * There are TWO LANES and they do not share a carrier. Starmind's own dispatch calls a server it spawned,
 * so it can attach the assertion to the call itself; Claude Code spawns its own copies of these servers,
 * so nothing of ours is on that call and the only channel into that process is the environment its parent
 * was given. Each writer below NAMES the lane it serves, because the one thing a reader of this file must
 * not get wrong is which road they are on — a fact carried on one lane and forgotten on the other is a
 * capability that works in the app and silently does nothing under the harness.
 *
 *   assertOnCall   — the in-process lane. Rides `_meta` on the `tools/call` itself.
 *   publishToChild — the harness lane. Rides the child's environment, read once at boot. Emits EVERY
 *                    variable in one call, so a fact cannot be published on one and forgotten on another.
 *
 * `_meta` is JSON-RPC's reserved out-of-band field, carried BESIDE `arguments` rather than inside it.
 * That position is the whole point, and the only reason any of this is trustworthy. `arguments` is what
 * the MODEL writes; `_meta` is what the CLIENT writes. A model asking to read a file it was never handed
 * has no channel through which to claim it WAS handed it — the field is not in the tool's inputSchema, was
 * never shown to it, and is attached after its tool_use block has already been parsed. Put an
 * authorization inside `arguments` and the agent authorizes itself.
 *
 * THE GRANT ON THE WIRE IS THE PERMISSION. There is nothing else: no session id, no server-side table, no
 * lookup. A server receiving a grant honours it for exactly that subject on exactly that call, and a
 * server receiving none has no exception to apply. That is deliberate and load-bearing — it keeps the
 * override SHORT-TERM and VISIBLE by construction ( it is re-asserted, in full, on every single call ),
 * and it leaves no state anywhere for a second layer of permission logic to grow in later. Revoking is
 * then not an operation at all: the grant simply stops being sent.
 *
 * Both ends of the wire read this one file, so the client's assertion and the server's reading of it
 * cannot drift apart.
 */
/**
 * The variables the HARNESS lane's carrier rides on — the turn's EXCEPTIONS and the FLOOR they except from.
 *
 * Exported so the host that WRITES them and the server that READS them name them once — a string literal
 * duplicated across a process boundary is a silent no-grant the first time one side is edited.
 *
 * TWO VARIABLES RATHER THAN A WIDER PAYLOAD, and the reason is version skew. The child is vendored into the
 * host's plugin directory and promoted on its own schedule, so a newer host meeting an older bundle is an
 * ordinary Tuesday. Widening the grant payload to carry the floor as well would hand an older child an
 * object where it expects an array — it would count the whole thing as one dropped entry and assert nothing.
 * Separate variables skew safely in both directions: an older child ignores the floor and reads its slice
 * exactly as it does today, and a newer child under an older host finds the variable absent and does the
 * same. Neither skew is worse than the state before either existed.
 */
export const GRANT_ENV  = 'STARMIND_GRANTS';
export const ACCESS_ENV = 'STARMIND_ACCESS';

/**
 * What the host publishes to one per-turn harness child: the turn's grants, and the configured floor those
 * grants are exceptions to.
 *
 * One shape rather than two parameters because they are published together or not at all — a caller that
 * hands over the exceptions and forgets the baseline has produced an agent whose permissions are whatever
 * some other lane last wrote. Plain data at a seam, not a class: nothing here has behaviour, and the two
 * writers that turn it into environment variables live below.
 */
export interface HarnessAuthorization {
	grants: readonly GrantRef[];
	access: readonly AccessEntry[];
	/**
	 * The WORKSPACE both of the above are scoped to. Empty when no project backs the turn.
	 *
	 * It belongs in this envelope for the same reason the other two share one: grants are exceptions to a
	 * floor, and a floor is a property of a project — so a reader holding two of the three has to go and
	 * find the third, and will find it by asking whichever project happens to be ACTIVE. That is a different
	 * question from which project this TURN belongs to, and the two answers diverge the moment a person
	 * switches project while an agent is running.
	 *
	 * Not published to the child ( it resolves paths, not ids, and is pointed at its workspace by the host ).
	 * It is here for the in-process readers that gate a routed call on the asking turn's reach.
	 */
	projectId: string;
}

/**
 * How a published floor arrived — four states, four names, because behaviour and diagnosis want different
 * cuts of the same answer and collapsing them is how a fallback becomes invisible.
 *
 *   absent     — no variable. An older host, or a lane that publishes nothing. Fall back to configuration.
 *   unexpanded — the literal `${…}` reference arrived. The harness failed to expand it, which is a transport
 *                failure rather than a statement about access, so it behaves as absent and is named so a
 *                trace can tell the two apart. This has happened before on the grant carrier.
 *   published  — a floor was published; it IS the floor, including when it is empty.
 *   unreadable — a floor was published and could not be parsed. Grants nothing, because a floor we cannot
 *                read is not one we may quietly substitute a different floor for.
 */
export type FloorState = 'absent' | 'unexpanded' | 'published' | 'unreadable';

export const Authorization = {

	/**
	 * THE IN-PROCESS LANE — the `_meta` payload for one outgoing `tools/call`, or null when there is
	 * nothing to say, so a bare call goes out byte-identical to one sent before any of this existed.
	 *
	 * Takes the PROJECT as well as the grants, and its sibling does not. That asymmetry is a ruling rather
	 * than an omission: see `projectId` below for why a project may be named to an in-process reader and
	 * must not be named to a spawned one.
	 *
	 * IT CARRIES THE FLOOR TOO, which is what makes this the same writer as `forSpawn` rather than half of
	 * one. A grant is an exception and a floor is what it is an exception TO, so a reader holding one
	 * without the other has to go and find the missing half — and will find it by asking whichever project
	 * happens to be ACTIVE. The two lanes were already required not to drift on the grant; carrying the
	 * pair on both is how that stops being a thing to remember.
	 *
	 * `access` IS OPTIONAL AND `[]` IS NOT THE SAME AS OMITTING IT. Absent says this lane publishes no
	 * floor and a receiving server should use its own configuration; empty says this caller reaches
	 * nothing. Those are opposite instructions, and only the CALLER knows which it means — so the choice is
	 * made at the call site and never inferred here. Collapsing them would silently restore whatever a
	 * server's own configuration held at the moment a host meant to deny.
	 */
	assertOnCall(
		grants:     readonly GrantRef[],
		projectId?: string,
		access?:    readonly AccessEntry[]
	): Record<string, unknown> | null {
		if ( grants.length === 0 && !projectId && !access ) return null;
		const own: Record<string, unknown> = {};
		if ( grants.length ) own[ 'grants' ] = grants;
		if ( projectId )     own[ 'projectId' ] = projectId;
		if ( access )        own[ 'access' ] = access;
		return { starmind: own };
	},

	/**
	 * Which project this call belongs to — a ROUTING key for an IN-PROCESS reader, and nothing else.
	 *
	 * Read this only where the reader shares a process with the host and can resolve the project itself.
	 * It is deliberately NOT how a spawned server learns its workspace: that would put a lookup key on the
	 * wire and make the receiving end trust a table it cannot see, which is exactly the thing the grant
	 * design refuses. A spawned server is POINTED at its project by the host writing the resolved policy
	 * into the slice it re-reads — so what crosses a process boundary is always the answer, never the key.
	 * That is why `publishToChild` names no project: there is no reader on that lane who could use one — it
	 * is handed the resolved FLOOR instead, which is what a project id would only have been looked up to get.
	 *
	 * Trustworthy for the same reason a grant is: `_meta` is the client-written half of a call and the
	 * model has no channel to it. An empty string is "no project on this call" — a sessionless crossing
	 * like the inspector's Run button — and reads as no configured access rather than as the default one.
	 */
	projectId( meta?: Record<string, unknown> ): string {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { projectId?: unknown };
		return typeof own.projectId === 'string' ? own.projectId : '';
	},

	/**
	 * THE HARNESS LANE — EVERY variable a per-turn child is given, in one call.
	 *
	 * One writer for both, so a fact added to what the host publishes cannot land on one variable and be
	 * forgotten on the other. That is not a hypothetical tidiness: the floor and the grants answer halves of
	 * the same question, and for a long time only one of them had a carrier on this lane at all — the child
	 * read its exceptions from the host and its baseline from a slice shared with a different lane.
	 *
	 * BOTH ARE ALWAYS EMITTED, `[]` when there is nothing to say. Not symmetric with `assertOnCall`,
	 * deliberately. `_meta` is authored at call time, so omitting it and having nothing to say are the same
	 * statement. These variables are REFERENCED from a spawn config written once, before any turn's grants
	 * are known ( MCPService.harnessConfig stamps `${…}` on every server ), so leaving one undefined does
	 * not say "none" — it leaves a dangling reference and defers to whatever the harness does with one. An
	 * empty list says none in the same shape a full one says the rest, and every turn resolves.
	 *
	 * Bare arrays, not the `_meta` envelope. The `starmind` namespace exists because `_meta` is a protocol
	 * field shared with other writers; a dedicated variable has no neighbours to avoid, so the wrapper would
	 * be ceremony. The TYPES are identical across both carriers, and that is the part that must never drift —
	 * which is why both writers are defined in this one file, beside the parses they share.
	 *
	 * SAFE ONLY FOR A PER-TURN CHILD. Env is fixed for a process's life, so a long-lived server handed these
	 * would freeze its permissions at spawn and carry them across every session it went on to serve. The
	 * harness child is killed with each `claude` invocation, which is what makes the carrier honest;
	 * Starmind's own long-lived servers are pointed through their slice instead and never see these.
	 */
	publishToChild( auth: HarnessAuthorization ): Record<string, string> {
		return {
			[ GRANT_ENV ]:  JSON.stringify( auth.grants ),
			[ ACCESS_ENV ]: JSON.stringify( auth.access ),
		};
	},

	/**
	 * THE RECEIVING END of the published floor — what a spawned child should treat as its configured access.
	 *
	 * `entries` is null when nothing was published, and the caller falls back to its own configuration. It
	 * is the list when a floor WAS published, including when that list is empty — a published empty floor
	 * grants nothing, and reading it as "nothing was published" would silently restore whatever the slice
	 * happened to hold. Those are opposite outcomes and they must not share a value.
	 *
	 * An unexpanded `${…}` reference reads as ABSENT rather than as garbage. It means the harness did not
	 * expand the variable, which is a transport failure and not a statement about access — the child is no
	 * worse off falling back than it was before this carrier existed, and denying every path over a failed
	 * string substitution would take file access down for a reason nobody could see. `state` is what makes
	 * that decision auditable instead of silent.
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
	 * THE RECEIVING END on the WIRE lane — the same contract `readFloor` gives the environment lane, so a
	 * server asks one and then the other and reads one answer either way.
	 *
	 * SAME FOUR STATES, and the same null-versus-empty meaning: `entries` is null only when nothing was
	 * published, and a published EMPTY floor grants nothing rather than meaning fall back. That is the one
	 * distinction this whole field exists to preserve — see `assertOnCall`.
	 *
	 * `unexpanded` IS UNREACHABLE HERE and is deliberately never returned. It describes a harness failing
	 * to substitute a `${…}` reference into a string, and there is no string substitution on a wire
	 * envelope. The state type is shared because the READERS are shared; not every lane produces every
	 * state, and faking one to look symmetrical would be inventing a diagnosis nobody can act on.
	 *
	 * `unreadable` MEANS SOMETHING DIFFERENT ON THIS LANE, and callers must treat it accordingly. On the
	 * environment lane a floor that will not parse is a transport failure — a harness mis-expanded a
	 * variable — which is a degraded condition to tolerate and report quietly. HERE the envelope was
	 * authored by our own gate, in this process or one hop away, and handed straight to a server we also
	 * wrote. There is no third party to blame and no retry that helps: an unreadable floor on this lane is
	 * a DEFECT in Starmind. It still fails closed, because a floor we cannot read is not one we may
	 * substitute a different floor for — but a caller that merely notes it has mistaken a bug for weather.
	 *
	 * Silent by construction, like every other parse in this file, and for the reason stated on
	 * `parseGrantsCounted`: the spawned child has no logger this layer could reach. `state` is what the
	 * host shouts with.
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
	 * Read a grant payload off EITHER carrier — the wire envelope or the environment variable.
	 *
	 * ONE PARSE FOR BOTH, and that is the whole reason it lives here. Until this existed the two carriers
	 * did not merely risk drifting, they had already drifted: the environment side validated every field
	 * strictly and dropped what it could not read, while the wire side did `as GrantRef[]` — an unchecked
	 * cast, so a malformed assertion reached the guards as a grant-shaped object with undefined fields.
	 * The file said the two must not drift and one of them was not being read at all.
	 *
	 * FAILS CLOSED ON EVERYTHING. Absent, unparseable, wrong shape, unknown kind, empty subject — all
	 * yield no grant, because a grant that cannot be read is a grant that was not given. That also covers
	 * an unexpanded `${…}` reference arriving literally, which JSON.parse rejects.
	 *
	 * A MISSING LEVEL IS A MIGRATION, NOT A DEFAULT. A payload written before depths existed meant `read`,
	 * so that is what it resolves to — meaning-preserving in the only direction that is safe, since it can
	 * never reach write or delete. This matters concretely rather than theoretically: the child is
	 * vendored into the host's plugin directory and promoted on its own schedule, so a newer host talking
	 * to an older bundle, or the reverse, is an ordinary Tuesday. Both skews under-grant; neither breaks.
	 *
	 * An unrecognised level is malformed and drops the whole grant, rather than being clamped to something
	 * workable — a level we cannot read is not a level we may assume is shallow.
	 */
	parseGrants( raw: unknown ): GrantRef[] {
		return Authorization.parseGrantsCounted( raw ).grants;
	},

	/**
	 * The same parse, plus HOW MANY entries it refused — the number that makes a failure here findable.
	 *
	 * Every rejection above is deliberately silent, and silence is right at this layer: a parser that threw
	 * would turn one malformed grant into a dead tool call, and one that logged would need a logger the
	 * spawned child does not have. But a grant that fails closed and says nothing is indistinguishable from
	 * a grant that was never given, and those two want opposite fixes. So this reports the count and the
	 * HOST decides what to do with it — main to its trace, the child to its own trace file.
	 *
	 * A non-array payload counts as ONE drop: a payload that cannot be read is a grant set that did not
	 * arrive, and calling that zero would report "nothing was lost" about the largest possible loss. Absent
	 * counts as zero, because absence is the ordinary case on every call that was never granted anything.
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
