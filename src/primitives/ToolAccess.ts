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
 * `off` IS A SUBTRACTION, NOT A STATE ANY DOCUMENT CARRIES. Absence and deny are one fact rather than two —
 * a tool that is not on the passport is denied, and a denied tool is not on it. That identity is what makes
 * a denial unable to leak: there is nothing there to leak. The word is stored for exactly one reason, which
 * is that an agent must be able to take back a tool a LENS supplied, and a subtraction has to be written
 * down somewhere to be applied. It is spent during assembly and never survives it.
 *
 * ── SURFACE: HOW MUCH OF IT RIDES IN THE PROMPT ──
 * `manifest` is a name and a line saying what it is for. `preload` is the full schema, in the prompt before
 * the agent has asked for it. That difference is what buys hundreds of tools at low cost beside a small
 * pre-selected set — the extra round trip to fetch a shape is the design, not a missing feature.
 *
 * NOT `suggested`, which is the word this axis carried first and the one `SLOT_MODES` still carries for
 * references and habits. It named our MOTIVE — we are suggesting this tool — rather than what the setting
 * does; `preload` says when it happens and what it costs.
 *
 * MOOT FOR A TOOL THAT IS NOT HELD. There is no cost question to answer about a thing that is not there,
 * and a control must not offer one.
 */
export const POLICIES = [ 'allow', 'ask', 'off' ] as const;
export type Policy = typeof POLICIES[ number ];

export const SURFACES = [ 'manifest', 'preload' ] as const;
export type Surface = typeof SURFACES[ number ];
