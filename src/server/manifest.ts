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

	// ── Lifecycle (system-stamped) ──────────────────────────────────────────────
	installed:     boolean;               // has been installed into the active app
	exposed:       boolean;               // is the tool surface exposed to the model's context (the user toggle — NOT a power switch)
	promoted_at?:  string;                // ISO 8601 — set at promotion; the drift signal
	installed_at?: string;                // ISO 8601 — set at installation
	source_repo?:  string;                // breadcrumb back to the draft folder
}
