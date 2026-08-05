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
export const CallMeta = {

	/** Build the `_meta` payload for one outgoing call, or null when there is nothing to assert —
	 *  so an ungranted call goes out byte-identical to one sent before any of this existed. */
	build( grants: GrantRef[] ): Record<string, unknown> | null {
		if ( grants.length === 0 ) return null;
		return { starmind: { grants } };
	},

	/** The grants asserted on a received call. Absence is NORMAL, never an error: every non-Starmind
	 *  client sends none, and so does an ungranted call from this one. */
	grants( meta?: Record<string, unknown> ): GrantRef[] {
		const own = ( meta?.[ 'starmind' ] ?? {} ) as { grants?: unknown };
		return Array.isArray( own.grants ) ? ( own.grants as GrantRef[] ) : [];
	},
};
