/**
 * ToolDef — the minimal tool descriptor an Agent binds as environment ( `agent.bindEnv({ toolDefs })` ).
 * The core-side shape of the app's `WireToolDef`, carrying only what the agent needs: the name/description/
 * schema to build its tool manifest + suggested surface, and the BAKED per-mode counts to price them.
 *
 * Deliberately STRUCTURAL: the app's richer `WireToolDef` ( which also carries annotations / example / doc )
 * is assignable to this, so the renderer binds its store's tools directly with no mapping, and the SDK never
 * imports an app type — the dependency stays app → SDK, never the reverse.
 *
 * A tool def is immutable once its server declares it, so its cost is BAKED main-side ( see MCPService, off
 * the one `KCDPrimitive._estimateTokens` ) and rides with the def. `manifestTokens` is the `on`-mode
 * one-liner weight, `suggestedTokens` the `suggested`-mode full-surface weight — the agent SUMS these rather
 * than re-estimating a schema. Absent only on a def that never crossed the priced serve seam ( e.g. a test
 * double ), where a reader falls back to computing.
 */
export interface ToolDef {
	name:         string;
	description:  string;
	inputSchema:  Record<string, unknown>;
	manifestTokens?:  number;
	suggestedTokens?: number;
	/** The MCP server this tool belongs to — stamped main-side at the priced serve seam so a bound agent
	 *  can GROUP its manifest by server ( folder ) with the server's own description. Absent on a test
	 *  double or a def that never crossed the seam ( grouped under a fallback bucket then ). */
	server?: { id: string; name: string; doc: string };
}
