/**
 * manifest.ts — the server contract.
 *
 * ServerManifest is the single inventory record for one MCP server: what it is,
 * and where it stands in the Draft → Promoted → Installed lifecycle. Pure data,
 * no behavior — read across the system (MCPService spawns from it, the UI toggle
 * flips `exposed`, promotion stamps `promoted_at`). When you want to know
 * anything about a server, you ask its manifest; it holds its own rules.
 *
 * One fat record by design. The fields divide by *who writes them*, not by type:
 *
 *  - Identity  — declared by the server author (the subclass's `static manifest`).
 *  - Lifecycle — stamped by the system as the server moves through the stages.
 *                `installed`/`exposed` are always present (false until their
 *                event); the dates are simply absent until then.
 */
/**
 * How a server relates to a PROJECT — declared by the server itself, because only the server knows
 * whether it has a workspace at all. Not a central table: the posture belongs on the thing that has it,
 * so installing a server teaches the host how to place it and removing one takes the knowledge with it.
 *
 *   'none'      the server has no workspace. Most third-party servers ( a weather API, a search index )
 *               are this, and are singletons the host never re-points. THE DEFAULT — a server that says
 *               nothing is assumed to want nothing, which is the only safe read of silence.
 *   'cwd'       the workspace is fixed at spawn, from the process working directory, and cannot move
 *               afterwards. The host spawns it into the right project; changing project needs a respawn.
 *   'per-call'  the server re-resolves its workspace on every tool call from a channel the host writes
 *               ( its package-store slice ). The host points it at the right project immediately before
 *               each call — and therefore SERIALIZES that server's calls, since one process holding one
 *               root cannot answer two projects at once.
 */
export type ServerWorkspace = 'none' | 'cwd' | 'per-call';

/**
 * The hard wall-clock ceiling on ONE tool call, in ms, for a server that names none. Claude Code's own
 * default is ~27.8 hours ( read off the binary and measured 2026-08-13 ), which is not a ceiling at all:
 * a wedged call is never cut loose and burns the entire harness turn instead, surfacing as a failure that
 * names no server and no tool.
 *
 * 180 000 is a LIVENESS ceiling, not a budget. Every installed server's measured worst case is SECONDS
 * ( a 16 158-file survey walks in ~243ms; grep is capped at 100 files ), so this is ~100x margin. What
 * picks the number is the far end: it must fire well inside `TURN_TIMEOUT_MS` so a wedge surfaces as
 * "server X tool Y timed out" with the turn still live. Those two are ONE budget — if that moves, move this.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

export interface ServerManifest {
	// ── Identity (author-declared) ──────────────────────────────────────────────
	id:           string;                 // slug; matches the server's folder name
	name:         string;                 // display name
	version:      string;                 // semver
	entryPoint:   string;                 // relative to the folder, e.g. "dist/index.js"
	transport:    'stdio';                // SSE/HTTP reserved for the future
	credentials:  string[];               // vault key names injected as env
	env?:         Record<string, string>;
	doc?:         string;                 // the server's own doc-block — its account of what it is, the recursive parent of its tools' docs
	config?:      ServerConfigSurface;    // the server's self-declared config surface — what the app's config screen renders for it (see below)
	workspace?:   ServerWorkspace;        // how this server relates to a PROJECT — see below. Absent means 'none'.
	timeoutMs?:   number;                 // hard ceiling on ONE tool call. Absent means DEFAULT_TOOL_TIMEOUT_MS.



	// ── Lifecycle (system-stamped) ──────────────────────────────────────────────
	installed:     boolean;               // has been installed into the active app
	exposed:       boolean;               // is the tool surface exposed to the model's context (the user toggle — NOT a power switch)
	promoted_at?:     string;             // ISO 8601 — set at promotion; the drift signal
	build?:           string;             // content stamp: <promoted timestamp>+<sha8 of dist/index.js> — changes whenever the bundle does
	installed_at?:    string;             // ISO 8601 — set at installation
	source_repo?:     string;             // breadcrumb back to the draft folder
	bundled_kcd_sdk?: string;             // kcd_sdk version inlined at promote — compared against main's for drift
}

/**
 * A server's self-declared config surface — what the app's config screen renders under its package seam.
 * Mirrors the app-layer `ConfigSurface` (starmind shared/SettingType) STRUCTURALLY; kept self-contained
 * here because kcd_sdk sits below the app and cannot import its UI types. The renderer re-reads it as a
 * real ConfigSurface. Two ways to declare config, same as the app's surface:
 *
 *  - `surface` names a BESPOKE renderer component (e.g. 'semantic_browser' for a whitelist editor) — used
 *    when the config is structured (a list of records) and a flat field list can't express it.
 *  - `fields` is the FLAT typed-field path — a list of primitive tunables the generic renderer draws.
 *    (Deferred wiring: no package uses it yet; the bespoke surface covers the first case.)
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
