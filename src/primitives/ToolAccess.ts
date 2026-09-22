/**
 * ToolAccess — the two vocabularies a tool is held under, and where each one has authority.
 *
 * ── WHY THESE LIVE IN THE SDK ──
 * They ride the persisted agent schema ( `SerializedAgent.toolModes` ) and the passport document, so they
 * must hydrate on both sides of the bridge. The app's `ToolVocabulary` re-exports them and keeps the halves
 * that are genuinely its own — the identity separator, the provenance of a resolved policy — because a
 * package that cannot import the app must not be told how the app spells an id.
 *
 * ── TWO VOCABULARIES, ONE STATE UNDERNEATH ( Bryan, 2026-09-22 ) ──
 * An agent is a PROTOTYPE and a passport is an INSTANCE, so they are asked different questions and answer in
 * different words. The words differ because the authority does, not because the states do:
 *
 *   agent config          passport
 *   ------------          --------
 *   off            ←→     deny  ( both are ABSENCE — see below )
 *   on             ←→     allow or ask
 *   preload                —
 *
 * `off` on an agent and `deny` on a passport are the same fact named for where it is invoked: one says this
 * agent does not have the tool, the other says this run may not call it, and neither is stored. A tool at
 * `off` is simply not minted into the passport, and a passport that does not hold a tool refuses it.
 *
 * ── THE LADDER ──
 * Defaults ( a floor across all projects ) → the project passport → the agent's tool config → the passport
 * minted from it on spawn → grants. Each rung is a level of concern while AUTHORING, and the first three
 * resolve exactly once, at mint; nothing above a minted passport is read again. Only two things are judged
 * per call: the passport and the grants handed to that run. A PROJECT DENIAL sits above all of it, read live,
 * and is the one thing that reaches a run already in flight.
 *
 * ── PRELOAD IS THE AGENT'S ALONE, AND THE PASSPORT HAS NO COST AXIS ( Bryan, 2026-09-22 ) ──
 * A passport governs a session in flight, where fetching a schema is one cheap call an agent makes only if it
 * actually needs one. Preload is not a permission and not a running concern: it is SEMANTIC PRIMING, decided
 * while building the agent — put this tool's whole shape in front of it because it is likely to reach for it.
 * That is an authoring decision, so it lives on the prototype and is expected to stay uncommon. This is what
 * retired `surfaces` from the passport document, and `manifest` with it: the cheap state is what every held
 * tool already is, so it needs no word.
 *
 * NOT `load`, though the slot three-state took that word on 2026-09-16. `preload` says WHEN, which is the
 * whole of what the third rung decides, and the agent's ladder keeps it.
 */

/**
 * THE PASSPORT'S WORDS — what a run may do, judged per call.
 *
 * Ordered loosest to strictest, and the order is load-bearing: a segmented control renders in array order, so
 * the track says which direction is safer without needing a legend.
 *
 *   allow — it runs, and nobody is asked.
 *   ask   — it runs once a person says so, every call.
 *   off   — NOT HELD. On a tool this is absence rather than a stored value; gates and commands, which are not
 *           presence lists, store it.
 *   deny  — NEVER. Authored on a project and read live, above every passport and every grant. No tier below
 *           holds it, and seeding strips it.
 */
export const POLICIES = [ 'allow', 'ask', 'off', 'deny' ] as const;
export type Policy = typeof POLICIES[ number ];

/** Whether a policy leaves the thing callable — neither `off` nor `deny`. */
export function holds( policy: Policy ): boolean {
	return policy === 'allow' || policy === 'ask';
}

/**
 * THE AGENT'S WORDS — what this agent has, and how much of it is put in front of the model.
 *
 * Ordered the same way, least in front to most. `off` is never stored: absence is the only way a tool is not
 * carried, so a reader holding the map cannot mistake a subtraction for a grant, and an agent listing every
 * served tool still writes a small record.
 *
 *   off     — not carried. It is not minted into the passport, so the run refuses it.
 *   on      — carried, and named in the manifest as one line. The model calls for its schema if it wants one.
 *   preload — carried, with its whole schema in the prompt from the first round.
 */
export const TOOL_MODES = [ 'off', 'on', 'preload' ] as const;
export type ToolMode = typeof TOOL_MODES[ number ];

/** Whether a mode means the agent carries the tool at all. */
export function carries( mode: ToolMode ): boolean {
	return mode === 'on' || mode === 'preload';
}

/**
 * WHAT A MODE MINTS AS — the one place the two vocabularies meet.
 *
 * `allow` rather than `ask`, and null for a tool the agent does not carry. An agent has no `ask` to give: the
 * confirm question belongs to the passport and the project, which is why this mapping is total and boring.
 * The project's own policy for the tool overrides this at mint, which is where `ask` actually comes from.
 */
export function policyForMode( mode: ToolMode ): Policy | null {
	return carries( mode ) ? 'allow' : null;
}
