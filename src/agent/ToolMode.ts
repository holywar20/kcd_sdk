/**
 * ToolMode — the three-state inclusion setting for an MCP tool on an agent. Lives in the SDK ( not the
 * renderer ) because it is part of the persisted agent schema ( SerializedAgent.toolModes ), so it must
 * cross the wire and hydrate on both sides. The renderer re-exports this type and adds the display
 * facts ( labels, hues ) on top; the SDK owns only the values.
 *
 *   · off       — excluded. The agent never sees the tool.
 *   · on         — available: listed as a one-liner in the system-prompt manifest ( name + blurb ). The
 *                 server stays lazy; the agent can request the tool, spawning it on first invoke.
 *   · suggested — the tool's full surface ( name + description + input schema ) is injected into context
 *                 as a standing suggestion ( a seen tool is likelier to be used ). Kept light by design.
 */
export const TOOL_MODES = [ 'off', 'on', 'suggested' ] as const;

export type ToolMode = typeof TOOL_MODES[ number ];
