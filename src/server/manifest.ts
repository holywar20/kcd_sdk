/**
 * manifest.ts — the server contract.
 *
 * ServerManifest is one server's inventory record and its place in the Draft → Promoted → Installed lifecycle. Pure
 * data that holds its own rules: ask a server's manifest, not the system. Identity is declared by the server author
 * (`static manifest`); Lifecycle is stamped by the system, with `installed` and `exposed` always present and the dates
 * absent until their event.
 */
/**
 * How a server relates to a PROJECT. Declared by the server, because only it knows whether it has a workspace at all.
 *
 *   'none'      no workspace. THE DEFAULT: a server that says nothing is assumed to want nothing.
 *   'cwd'       fixed at spawn from the working directory; changing project needs a respawn.
 *   'per-call'  re-resolved on every call from a channel the host writes. The host points it at the right project before
 *               each call, which SERIALIZES that server's calls: one root cannot answer two projects at once.
 */
export type ServerWorkspace = 'none' | 'cwd' | 'per-call';

/**
 * AN INJECTION HOOK: text this package contributes to a host's compiled context, declared here for the same reason as
 * `workspace`. NO TIER: every contribution lands in the injected band, because letting a package name its rank would
 * hand the prefix-cache contract to whoever installed it. Two contracts the type cannot state, and an author meets both
 * as silence: the tool must return TEXT content, and the injection rides only for an agent that already holds `tool`.
 */
export interface ContextContribution {
	tool:       string;                   // an ordinary tool on this package's ordinary surface
	heading?:   string;                   // defaults to the package's display name
	params?:    ServerConfigField[];      // rendered per agent; passed as the tool's arguments, key for key
	timeoutMs?: number;                   // this call rides a turn nobody asked for, so its budget is its own
}

/**
 * The hard wall-clock ceiling on ONE tool call, for a server that names none. A LIVENESS ceiling, not a budget: Claude
 * Code's own default is effectively no ceiling, so a wedged call burns the whole turn. Three minutes of a bounded tool
 * call means wedged rather than slow, and cutting it loose surfaces as "server X tool Y timed out" with the turn still
 * live to report it. Nothing above this ceiling expires: a turn ends when it finishes, a person stops it, or the child dies.
 *
 * Not the permission prompt's clock (`PERMISSION_ASK_TIMEOUT_MS`): that one is longer and measures human patience, so a
 * gated call's wait is not charged against this ceiling.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

/**
 * The default ceiling on a CONTEXT INJECTION, for a contributor that names none in `ContextContribution.timeoutMs`.
 * A BUDGET, not a liveness ceiling, and separate from the tool call above: this rides a turn nobody asked for, in front
 * of the first token, and its failure is a band that does not ride. It bounds the call only: a contributor whose server
 * must be spawned first pays that upstream of the gate.
 */
export const DEFAULT_INJECTION_TIMEOUT_MS = 10_000;

export interface ServerManifest {
	// ── Identity (author-declared) ──────────────────────────────────────────────
	id:           string;                 // slug; matches the server's folder name
	name:         string;                 // display name
	version:      string;                 // semver
	entryPoint:   string;                 // relative to the folder, e.g. "dist/index.js"
	transport:    'stdio';                // SSE/HTTP reserved for the future
	credentials:  string[];               // vault key names injected as env
	env?:         Record<string, string>;
	doc?:         string;                 // the server's own doc-block: its account of itself, parent of its tools' docs
	config?:      ServerConfigSurface;    // self-declared config surface the app's config screen renders (see below)
	workspace?:   ServerWorkspace;        // how this server relates to a PROJECT — see below. Absent means 'none'.
	contributes?: ContextContribution;    // injection hook: text this package adds to the compiled context. Absent means nothing.
	timeoutMs?:   number;                 // hard ceiling on ONE tool call. Absent means DEFAULT_TOOL_TIMEOUT_MS.



	// ── Lifecycle (system-stamped) ──────────────────────────────────────────────
	installed:     boolean;               // has been installed into the active app
	exposed:       boolean;               // the user's toggle for the tool surface exposed to the model; NOT a power switch
	promoted_at?:     string;             // ISO 8601 — set at promotion; the drift signal
	build?:           string;             // content stamp: <promoted timestamp>+<sha8 of dist/index.js> — changes whenever the bundle does
	installed_at?:    string;             // ISO 8601 — set at installation
	source_repo?:     string;             // breadcrumb back to the draft folder
	bundled_kcd_sdk?: string;             // kcd_sdk version inlined at promote — compared against main's for drift
}

/**
 * A server's self-declared config surface, rendered by the app's config screen under its package seam. Mirrors the app's
 * `ConfigSurface` (starmind shared/SettingType) structurally, because kcd_sdk sits below the app and cannot import its UI
 * types. Two ways to declare config:
 *
 *  - `surface` names a BESPOKE renderer component, for structured config a flat field list cannot express.
 *  - `fields` is the FLAT typed-field path: primitive tunables the generic renderer draws.
 *
 * Absent = the package exposes documentation only.
 */
export interface ServerConfigSurface {
	surface?: string;                     // a bespoke renderer component name the app maps to a component
	fields?:  ServerConfigField[];        // the flat primitive-tunable path (mirrors the app's ConfigField)
}

/** One flat config field — mirrors the app's ConfigField. `type` is a bare string here (kcd_sdk has no UI
 *  vocabulary); the app narrows it to its SettingType union when it renders. */
export interface ServerConfigField {
	key:          string;
	label:        string;
	type:         string;                 // 'text' | 'toggle' | 'number' | … — a SettingType at the app layer
	default:      unknown;
	options?:     string[];               // for 'select'
	min?:         number;                 // for 'number'
	max?:         number;                 // for 'number'
	placeholder?: string;
}
