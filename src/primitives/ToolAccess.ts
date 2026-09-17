/**
 * ToolAccess — the two axes a tool is held on, and the only persisted words for either.
 *
 * ── WHY THESE LIVE IN THE SDK ──
 * They ride the persisted agent schema ( `SerializedAgent.toolPolicies` / `toolSurfaces` ), so they must
 * hydrate on both sides of the bridge. The app's `ToolVocabulary` re-exports them and keeps the halves that
 * are genuinely its own — the identity separator, the provenance of a resolved policy — because a package
 * that cannot import the app must not be told how the app spells an id.
 *
 * ── POLICY: MAY IT RUN ──
 * Ordered loosest to strictest, and the order is load-bearing: the segmented control renders in array order,
 * so the track says which direction is safer without needing a legend.
 *
 *   off  — NOT GRANTED. A setting a person can change. As a tool value it is a subtraction: it takes back a
 *          tool a lens supplied, and is spent during assembly rather than stored.
 *   deny — NEVER. Authored on a project and read live, above every passport. No tier below holds it.
 *
 * ── SURFACE: HOW MUCH OF IT RIDES IN THE PROMPT ──
 * `manifest` is a name and a line saying what it is for. `preload` is the full schema, in the prompt before
 * the agent has asked for it. That difference is what buys hundreds of tools at low cost beside a small
 * pre-selected set — the extra round trip to fetch a shape is the design, not a missing feature.
 *
 * NOT `suggested`, which is the word this axis carried first. It named our MOTIVE — we are suggesting this
 * tool — rather than what the setting does; `preload` says when it happens and what it costs.
 *
 * AND NOT `load` either, though the slot three-state took that word on 2026-09-16 and there was a standing
 * ruling to bring this axis with it. Reversed on the day ( Bryan ): `preload` is the better word here
 * because it says WHEN, which is the whole of what this axis decides. The two axes reading differently is
 * the honest outcome — they ask different questions.
 *
 * MOOT FOR A TOOL THAT IS NOT HELD. There is no cost question to answer about a thing that is not there,
 * and a control must not offer one.
 */
export const POLICIES = [ 'allow', 'ask', 'off', 'deny' ] as const;
export type Policy = typeof POLICIES[ number ];

/** Whether a policy leaves the thing callable — neither `off` nor `deny`. */
export function holds( policy: Policy ): boolean {
	return policy === 'allow' || policy === 'ask';
}

export const SURFACES = [ 'manifest', 'preload' ] as const;
export type Surface = typeof SURFACES[ number ];
