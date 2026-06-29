/**
 * The model an agent runs on, as data. Pure description — the connector binding
 * (which descriptor routes to which API client) lives main-side, where connectors live.
 *
 * Deliberately minimal: local-vs-remote differentiation and per-client API encoding
 * are deferred to the driver project (see the Agent+Orchestrator plan, Phase 1 notes).
 */
export type Tier = 'local' | 'remote' | 'frontier';

export interface ModelDescriptor {
	/** Registry key — the value stored on a SerializedAgent. */
	key: string;
	/** UI display name. */
	label: string;
	/** Which connector family serves this model. */
	provider: 'anthropic' | 'test' | 'local' | 'remote';
	/** The wire id sent to the provider's API. */
	modelId: string;
	maxTokens: number;
	/**
	 * Working tier — how heavy the model is / where it runs. Orthogonal to provider:
	 * a 'remote' connector may front a remote-tier self-host OR a frontier endpoint,
	 * so tier is declared, not derived. Widgets constrain their model choice by it.
	 *
	 * Optional only so a half-written hand-edit doesn't crash dispatch — a real
	 * (non-test) model with no tier is a misconfiguration that warns at boot (see
	 * the registry's load check, starmind main). The test brain is exempt: it carries no tier.
	 */
	tier?: Tier;
	/**
	 * What the model can take in / how big its window is. Optional and partial by
	 * design — a folder-derived model fills what its manifest knows and the main-side
	 * registry defaults the rest; a missing field is "unknown", never a crash. The
	 * file-injection filter (a later slice) reads `multimodal` to refuse a non-multimodal
	 * model a binary.
	 */
	capabilities?: {
		multimodal?:    boolean;
		contextLength?: number;
	};
	/**
	 * Per-MILLION-token price in USD, split input/output (providers bill the two at different rates).
	 * Drives the run cost meter — the orchestrator multiplies the turn's real token counts by these.
	 * Optional by design: a local/self-hosted model has no per-token cost (absent → $0), and a
	 * hand-edited descriptor that omits it never crashes — cost simply reads zero. Frontier rates are
	 * declared on the cloud fixtures; tune them as the published prices move.
	 */
	price?: {
		inputPerMTok:  number;
		outputPerMTok: number;
	};
}

/**
 * A model's live "degree of hookup" — how usable it is RIGHT NOW, provider-shaped.
 * Universal across providers, but only a `local` model has a process we manage:
 *
 * - `local`, fully booted: `{ usable: true, phase: 'ready', managed: true, origin: 'adopted', arena, port }`
 * - `local`, still loading: `{ usable: false, phase: 'loading', managed: true, … }`
 * - `remote` / `anthropic`: `{ usable: true, phase: 'unmanaged', managed: false, origin: null, arena: null, port: null }`
 *   — a model with no server WE own (a hosted URL / the cloud API).
 *
 * `unmanaged` is honest today and leaves room: a future health surface refines it into
 * reachable / no-key / unreachable per provider WITHOUT touching the local path. The
 * context-window gauge reads `arena`; a picker reads `usable`. Plain data — crosses the
 * pull lane (the main-side ModelService joins it onto each descriptor in the roster).
 */
export interface ModelStatus {
	/** Can a turn land on this model right now (a picker's real question). */
	usable: boolean;
	/** The degree of hookup. `unmanaged` = a model exists but there's no server we run. */
	phase: 'ready' | 'loading' | 'absent' | 'exited' | 'unmanaged';
	/** Do WE run the process — true only for a `local` model with a managed llama-server. */
	managed: boolean;
	/** How the running server got there, or null when there's nothing managed. */
	origin: 'spawned' | 'adopted' | null;
	/** The launched context window (the `-c` value) — the TRUE KV-cache ceiling, null when unmanaged/unset. */
	arena: number | null;
	/** The loopback port the managed server answers on, null when unmanaged. */
	port: number | null;
}

/**
 * One display-ready model-configuration fact — a label over its already-formatted value. The list of
 * these (`ModelRosterEntry.config`) is the model's static manifest configuration surfaced read-only
 * for display (family, license, quant, engine, …): provider-shaped and sparse (a hosted model carries
 * none), pre-formatted main-side so a consumer renders it generically without knowing the fields.
 */
export interface ModelConfigField {
	label: string;
	value: string;
}

/**
 * One roster row — a descriptor joined with its live status, its tier prose (`doc`, the model's
 * connector self-description), and its static config sheet (`config`), all attached main-side. The
 * single shape the picker (descriptor fields), the context-window gauge (`status`), the Models config
 * surface (`doc`), and the session deck (`config`) read from ONE pull, so the renderer never
 * hand-joins a separate registry + server-state read again.
 */
export type ModelRosterEntry = ModelDescriptor & { status: ModelStatus; doc: string; config: ModelConfigField[] };

/**
 * The fallback model key. `Agent.create` / `fromSerialized` default to it
 * when none is set. A bare key STRING, not a model source — the live descriptor list now
 * lives in the main-side `ModelRegistry` (inline defaults + folder scan); this only names
 * the default to resolve against it. The folder model whose manifest declares this key is
 * what `local.gemma` resolves to.
 */
export const DEFAULT_MODEL_KEY = 'local.gemma';
