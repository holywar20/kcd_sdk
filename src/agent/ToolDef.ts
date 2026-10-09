/**
 * ToolDef — the minimal tool descriptor an Agent binds as environment (`agent.bindEnv({ toolDefs })`).
 * Deliberately STRUCTURAL: the app's richer `WireToolDef` is assignable to it, and the SDK never imports an app
 * type, so the dependency stays app → SDK. Token counts are baked main-side when the def is served, and summed.
 */
export interface ToolDef {
	name:         string;
	description:  string;
	inputSchema:  Record<string, unknown>;
	manifestTokens?: number;
	preloadTokens?:  number;
	/** The MCP server this tool belongs to, stamped main-side so the manifest groups by server. Absent on a def
	 *  that never crossed the seam. */
	server?: { id: string; name: string; doc: string };
	/** THE WIRE IDENTITY, `group.tool`, stamped beside `server`. It rides rather than being spelled here: an SDK
	 *  that built the string would be a second speller of a format it cannot see change. */
	id?: string;
	/** THE WIRE NAME, `group__tool` — the identity as a model reads and writes it, stamped beside `id` and
	 *  riding for the same reason. What the manifest names a tool by. Absent pre-seam. */
	wire?: string;
}
