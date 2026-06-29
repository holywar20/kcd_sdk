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
