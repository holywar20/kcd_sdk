import type { GrantRef } from '../session/InjectedItem';

/**
 * CallMeta — the out-of-band half of a `tools/call`, carried on JSON-RPC's reserved `_meta` field
 * BESIDE `arguments` rather than inside it.
 *
 * That position is the whole point, and the only reason any of this is trustworthy. `arguments` is
 * what the MODEL writes; `_meta` is what the CLIENT writes. A model asking to read a file it was
 * never handed has no channel through which to claim it WAS handed it — the field is not in the
 * tool's inputSchema, was never shown to it, and is attached after its tool_use block has already
 * been parsed. Put an authorization inside `arguments` and the agent authorizes itself.
 *
 * THE GRANT ON THE WIRE IS THE PERMISSION. There is nothing else: no session id, no server-side
 * table, no lookup. A server receiving a grant honours it for exactly that subject on exactly that
 * call, and a server receiving none has no exception to apply. That is deliberate and load-bearing —
 * it keeps the override SHORT-TERM and VISIBLE by construction ( it is re-asserted, in full, on
 * every single call ), and it leaves no state anywhere for a second layer of permission logic to
 * grow in later. Revoking is then not an operation at all: the grant simply stops being sent.
 *
 * Both ends of the wire read this one file, so the client's assertion and the server's reading of
 * it cannot drift apart.
 */
/**
 * The variable the HARNESS tier's carrier rides on.
 *
 * Exported so the host that WRITES it and the server that READS it name it once — a string literal
 * duplicated across a process boundary is a silent no-grant the first time one side is edited.
 */
export const GRANT_ENV = 'STARMIND_GRANTS';

export const CallMeta = {

	/** Build the `_meta` payload for one outgoing call, or null when there is nothing to assert —
	 *  so an ungranted call goes out byte-identical to one sent before any of this existed. */
	build( grants: GrantRef[] ): Record<string, unknown> | null {
		if ( grants.length === 0 ) return null;
		return { starmind: { grants } };
	},

	/**
	 * The env VALUE for a set of grants. ALWAYS a string — `[]` when the turn holds none.
	 *
	 * Not symmetric with `build`, deliberately. `_meta` is authored at call time, so omitting it and
	 * having nothing to say are the same statement. This variable is REFERENCED from a spawn config
	 * written once, before any turn's grants are known ( MCPService.harnessConfig stamps
	 * `${STARMIND_GRANTS}` on every server ), so leaving it undefined does not say "no grants" — it
	 * leaves a dangling reference and defers to whatever the harness does with one. An empty list says
	 * no grants in the same shape a full one says the rest, and every turn resolves.
	 *
	 * The HARNESS tier's carrier. There, Claude Code owns the call and spawns the server itself, so none
	 * of our `_meta` is on it and the only channel into that process is the environment its parent was
	 * given. The model cannot reach it: the host authors both the variable and the spawn.
	 *
	 * A bare `GrantRef[]`, not the `_meta` envelope. The `starmind` namespace exists because `_meta` is a
	 * protocol field shared with other writers; a dedicated variable has no neighbours to avoid, so the
	 * wrapper would be ceremony. The TYPE is identical across both carriers, and that is the part that
	 * must never drift — which is why both are defined in this one file.
	 *
	 * SAFE ONLY FOR A PER-TURN CHILD. Env is fixed for a process's life, so a long-lived server handed
	 * this would freeze its grants at spawn and carry them across every session it went on to serve. The
	 * harness child is killed with each `claude` invocation, which is what makes the carrier honest;
	 * Starmind's own long-lived servers use `_meta` instead and are never given this variable.
	 */
	envValue( grants: GrantRef[] ): string {
		return JSON.stringify( grants );
	},

	/** The grants asserted on a received call. Absence is NORMAL, never an error: every non-Starmind
	 *  client sends none, and so does an ungranted call from this one. */
	grants( meta?: Record<string, unknown> ): GrantRef[] {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { grants?: unknown };
		return Array.isArray( own.grants ) ? ( own.grants as GrantRef[] ) : [];
	},
};
