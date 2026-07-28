/**
 * The model an agent runs on, as data. Pure description — the connector binding
 * (which descriptor routes to which API client) lives main-side, where connectors live.
 *
 * Deliberately minimal: local-vs-remote differentiation and per-client API encoding
 * are deferred to the driver project (see the Agent+Orchestrator plan, Phase 1 notes).
 */
export type Tier = 'local' | 'remote' | 'frontier';

/**
 * Every effort stop any model in the system offers — the DECLARATION vocabulary, not a wire format.
 *
 * Five names spanning TWO unrelated dials that merely share their first three: gpt-oss / harmony's
 * `reasoning_effort` (three stops) and Claude Code's `--effort` (all five). A model declares the subset it
 * accepts (`capabilities.reasoning.effort`) and each connector maps that to its own wire form — so the
 * narrow wire union in `openai-compat.ts` stays THREE on purpose, and this type must never be substituted
 * for it. Sending `xhigh` to a llama-server that can't parse it is the exact 400 the declaration prevents.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelDescriptor {
	/** Registry key — the value stored on a SerializedAgent. */
	key: string;
	/** UI display name. */
	label: string;
	/**
	 * The persona NAME this model answers to ( "Winston" for the local / GB10 stack, "Claude" for the
	 * Anthropic / Claude-Code models ) — the human name the user keeps their agents straight by,
	 * distinct from the lens ( its worldview / focus ) and from `label` ( the technical model name ).
	 * Hardcoded on the descriptor for now and surfaced to the renderer, so a prompt template can inject
	 * `{name}`. Optional: absent → a consumer falls back ( e.g. to the lens / agent name ).
	 */
	persona?: string;
	/** Which connector family serves this model. */
	provider: 'anthropic' | 'test' | 'local' | 'remote' | 'claude_code_max';
	/** The wire id sent to the provider's API. */
	modelId: string;
	maxTokens: number;
	/**
	 * The FAMILY this model was minted from, when its connector serves a family rather than a single
	 * model. Absent on every hand-authored single (a local folder model, a remote endpoint, the test
	 * brain) — those are top-level entries and nothing groups them.
	 *
	 * Present means the picker shows ONE row for `label` and offers this model inside it, which is the
	 * whole point: a connector stays one registered entry no matter how many models it can reach, and a
	 * twenty-model dropdown never happens. It is also the hook for family-specific handling — anything
	 * true of "Claude on the subscription" rather than of one Claude model keys off this.
	 *
	 * NOT a vendor field. Two connectors reaching the same vendor stay two independent families with two
	 * separate rows; this identifies which registered CONNECTOR ENTRY produced the model, never who makes
	 * it. Grouping across connectors was considered and rejected.
	 */
	family?: {
		/** The seed key — the stable id of the family, matching the first segment of every member's key. */
		key:   string;
		/** The family's display name; the label the collapsed picker row shows. */
		label: string;
	};
	/**
	 * How a turn on this model is actually paid for — orthogonal to `price` (which is the
	 * per-token rate WHEN metered). `'subscription'` means the turn draws against a flat-rate
	 * plan the user already pays for outside Starmind (e.g. a Claude Max login) — `price` is
	 * absent/zero for these, but that must never read as "free" in the UI: it's prepaid, not
	 * costless. Absent for every existing provider (local/remote/test have no billing model
	 * worth naming; anthropic is the metered default) — only a subscription-backed tier
	 * declares this.
	 */
	billing?: 'subscription' | 'metered';
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
		/**
		 * Whether this model's endpoint handles a STREAMING request. Absent/true → stream ( the default: the
		 * orchestrator hands the connector a live sink ). `false` → the connector must NOT stream ( no sink →
		 * a plain batch POST ): some hosted OpenAI shims ( Google's Gemma endpoint ) 500 on a streaming body
		 * a self-hosted llama-server handles fine. An opt-OUT flag, so every normal model streams untouched.
		 */
		streaming?:     boolean;
		/**
		 * Reasoning / thinking support — the ONE place three consumers read from: the connector (what it
		 * may put on the wire), the composer controls (which reasoning controls to show), and the info chip
		 * (which flags to report). Absent → the model exposes NO reasoning surface: controls hidden, and no
		 * `reasoning_effort` is ever sent. This is the seam that turns implicit per-model behaviour (the
		 * kind that let a blind `reasoning_effort` 400 Google's Gemma shim) into queryable data.
		 */
		reasoning?: {
			/**
			 * The effort dial's levels, in order — a DECLARATION of what this model accepts, not a wire
			 * format. Absent/empty → the model has NO effort dial: no effort value is ever sent (Google's
			 * Gemma shim 400s on an unsupported `reasoning_effort`; a self-hosted llama-server merely
			 * ignores it) and the composer hides the slider.
			 *
			 * The five levels span TWO unrelated dials that happen to share their first three names, so
			 * read this as "which stops does this model offer" and let each connector map it to its own
			 * wire form:
			 *   - gpt-oss / harmony `reasoning_effort` → `['low','medium','high']` (three only; the wire
			 *     union in `openai-compat.ts` is deliberately NOT widened past them — sending `xhigh` to a
			 *     llama-server that can't take it is exactly the 400 this field exists to prevent).
			 *   - Claude Code's `--effort` → all five, `low` through `max`.
			 * A budget-based reasoner that exposes no dial at all (metered Anthropic thinking) carries none.
			 */
			effort?: ReasoningEffort[];
			/**
			 * How the reasoning comes back: `readable` (the words stream into the thinking box), `measured`
			 * (a token count only, text redacted — the headless-frontier shape), or `none` (no thinking).
			 * Drives whether the thinking box and the reasoning-mode control appear at all.
			 */
			channel?: 'readable' | 'measured' | 'none';
		};
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
	/**
	 * The root-context artifact bound 1:1 to THIS model — a project-root-relative path to a KCD
	 * HTML doc (e.g. `Starmind.html`). When present, the orchestrator injects that doc's text as the
	 * system-above-lens layer for every turn on this model, and NO other model receives it. Absent on
	 * every model but the one that declares it: the binding lives on the thing, not in a side table, so
	 * "which model gets which root context" is read straight off the descriptor. The resolved TEXT is
	 * not carried here (the descriptor stays pure/path-only) — it is read + emitted main-side and
	 * surfaced on `ModelRosterEntry.rootContextText`.
	 */
	rootContext?: string;
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
 *
 * `visible` is whether the user wants this model OFFERED — false only for a family member they have
 * unchecked on the Models panel. It is a FLAG on a row that is still present, deliberately, rather than
 * the row being dropped main-side: the roster is also what names a model (`labelFor`), sizes the context
 * gauge, and fills the inspector, so an agent already bound to a hidden model must still find its
 * descriptor here. Hiding governs the pickers, never the binding — the surfaces that OFFER a choice
 * (the model store's `menuFor`, the renderer Registry's model catalog) are what skip an invisible row.
 */
export type ModelRosterEntry = ModelDescriptor & { status: ModelStatus; doc: string; config: ModelConfigField[]; rootContextText: string | null; visible: boolean };

/**
 * The fallback model key — the ONE model every resolution path terminates on, and the only model key
 * allowed to be hard-wired anywhere. `Agent.create` / `fromSerialized` default to it when none is set,
 * and the constellation's navigator / evaluator / artifact steps fall back to it when no operational
 * model threads through.
 *
 * It is the built-in TEST BRAIN, deliberately: a scripted generator with no external dependency, which
 * always exists and always answers. Model availability is contingent on things outside our control — a
 * local runtime installed, a remote host reachable, a credential present — so the terminal step of every
 * fallback chain has to be something that cannot be absent. That lets a user exercise a project's
 * machinery before configuring any real brain, and keeps a malformed snapshot or an unstaffed node from
 * dead-ending a run.
 *
 * It was previously `local.gemma`, which defeated the purpose: it names a specific local model that most
 * installs will not have, so the "safe" fallback could itself fail to resolve.
 *
 * A bare key STRING, not a model source — the live descriptor list lives in the main-side
 * `ModelRegistry` (inline defaults + folder scan); this only names the default to resolve against it,
 * and that roster keys its Test Brain entry off this constant so the two cannot disagree.
 */
export const DEFAULT_MODEL_KEY = 'test.lorem';
