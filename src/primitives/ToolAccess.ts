/**
 * ToolAccess — the two vocabularies a tool is held under, which ride the persisted agent schema and the passport.
 * An agent (a prototype) says `off | on | preload`; a passport (an instance) says `allow | ask | off | deny`.
 * `off` and `deny` are the same absence, named for where it is invoked, and neither is stored.
 * Defaults, the project passport and the agent's config resolve once, at mint.
 * Per call only the passport and grants are judged; a project denial is read live and reaches a run in flight.
 * `preload` is the agent's alone: semantic priming decided while building the agent, not a permission. Not `load`.
 */

/**
 * What a run may do, judged per call; the order runs loosest to strictest, and a segmented control renders in it.
 * `off` is absence on a tool, stored only by gates and commands. `deny` is authored on a project and read live.
 */
export const POLICIES = [ 'allow', 'ask', 'off', 'deny' ] as const;
export type Policy = typeof POLICIES[ number ];

/** Whether a policy leaves the thing callable — neither `off` nor `deny`. */
export function holds( policy: Policy ): boolean {
	return policy === 'allow' || policy === 'ask';
}

/**
 * What the agent carries, least in front of the model to most. `off` is never stored; absence is how a tool is not carried.
 * `on` names the tool in the manifest; `preload` puts its whole schema in the prompt from the first round.
 */
export const TOOL_MODES = [ 'off', 'on', 'preload' ] as const;
export type ToolMode = typeof TOOL_MODES[ number ];

/** Whether a mode means the agent carries the tool at all. */
export function carries( mode: ToolMode ): boolean {
	return mode === 'on' || mode === 'preload';
}

/**
 * `allow` rather than `ask`, because an agent has no `ask` to give. The project's own policy overrides this at mint,
 * which is where `ask` comes from. Null for a tool the agent does not carry.
 */
export function policyForMode( mode: ToolMode ): Policy | null {
	return carries( mode ) ? 'allow' : null;
}
