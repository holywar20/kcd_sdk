/**
 * The model an agent runs on, as data. Pure description — the connector binding
 * (which descriptor routes to which API client) lives main-side, where connectors live.
 *
 * Deliberately minimal: local-vs-remote differentiation and per-client API encoding
 * are deferred to the driver project (see the Agent+Orchestrator plan, Phase 1 notes).
 */
export type Tier = 'local' | 'remote' | 'frontier';

/** Every effort stop any model offers — the DECLARATION vocabulary, not a wire format. Five names across two
 *  unrelated dials; never substitute this for a connector's narrower wire union (openai-compat stays THREE). */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The five stops LEAST-first — the only place one effort is ranked above another. A union carries no order,
 *  so anything asking for "the highest" must read it from this list. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [ 'low', 'medium', 'high', 'xhigh', 'max' ];

/** Clamp a stated effort to what the model declares — down, never up, never to the middle: the stop itself,
 *  else the highest declared below it, else the lowest. A model declaring none passes the value through. */
export function clampReasoningEffort( want: ReasoningEffort, declared: readonly ReasoningEffort[] | undefined ): ReasoningEffort {
	if( !declared?.length ) return want;
	if( declared.includes( want ) ) return want;
	const ranked = REASONING_EFFORTS.filter( ( e ) => declared.includes( e ) );
	if( !ranked.length ) return want;   // declared holds nothing this build knows as a stop
	const ceiling = REASONING_EFFORTS.indexOf( want );
	const below   = ranked.filter( ( e ) => REASONING_EFFORTS.indexOf( e ) < ceiling );
	return below.length ? below[ below.length - 1 ]! : ranked[ 0 ]!;
}

export interface ModelDescriptor {
	/** Registry key — the value stored on a SerializedAgent. */
	key: string;
	/** UI display name. */
	label: string;
	/** Which connector family serves this model. */
	provider: 'anthropic' | 'test' | 'local' | 'remote' | 'laguna' | 'claude_code_max';
	/** The wire id sent to the provider's API. */
	modelId: string;
	maxTokens: number;
	/** The family this model was minted from, when its connector serves one: the picker shows one row for it.
	 *  Identifies the CONNECTOR ENTRY, never the vendor; grouping across connectors was rejected. */
	family?: {
		/** The seed key — the stable id of the family, matching the first segment of every member's key. */
		key:   string;
		/** The family's display name; the label the collapsed picker row shows. */
		label: string;
	};
	/** How a turn is paid for, orthogonal to `price`. `'subscription'` draws a flat-rate plan paid outside
	 *  Starmind: its absent price is prepaid, and must never read as "free" in the UI. */
	billing?: 'subscription' | 'metered';
	/** Who owns the conversation: `'managed'` means the provider assembles, caches and keeps the transcript; absent
	 *  or `'owned'` is the safe default. Not `tier`: the metered Anthropic connector is frontier yet still owned. */
	conversation?: 'managed' | 'owned';
	/** Names the component that draws this model's account reading, declared by the connector since the same model
	 *  can sit behind two accounts. Absent, or a name the surface does not recognise, renders nothing. */
	usagePanel?: string;
	/** Working tier — how heavy the model is and where it runs; declared, never derived from provider. Optional so a
	 *  hand-edit cannot crash dispatch; a real non-test model without one warns at boot. The test brain carries none. */
	tier?: Tier;
	/** What the model takes in and how large its window is. Optional and partial: a missing field is unknown, never
	 *  a crash. The file-injection filter reads `multimodal` to refuse a binary to a non-multimodal model. */
	capabilities?: {
		multimodal?:    boolean;
		contextLength?: number;
		/** Absent or true streams. `false` forces a plain batch POST, because some hosted OpenAI shims 500 on a
		 *  streaming body. An opt-out, so every normal model streams untouched. */
		streaming?:     boolean;
		/** Reasoning support, read by the connector, the composer controls and the info chip alike. Absent means no
		 *  reasoning surface: controls hidden, and no `reasoning_effort` is ever sent. */
		reasoning?: {
			/** The stops this model accepts, least first: a declaration, not a wire format. Absent or empty means no
			 *  dial, so no effort is sent. The openai-compat wire union stays at three stops on purpose. */
			effort?: ReasoningEffort[];
			/** How reasoning comes back: `readable` streams the words, `measured` gives a token count with the text
			 *  redacted, `none` means no thinking. Drives whether the thinking box and its control appear. */
			channel?: 'readable' | 'measured' | 'none';
		};
	};
	/** Per-million-token USD, input and output split. Drives the run cost meter; absent reads as zero cost, never a
	 *  crash. Frontier rates are declared on the cloud fixtures. */
	price?: {
		inputPerMTok:  number;
		outputPerMTok: number;
	};
}

/** A model's live hookup: whether a turn can land on it right now. Only a `local` model has a process we manage;
 *  `unmanaged` is a hosted URL or cloud API with no server of ours. */
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

/** One display-ready config fact: a label over an already-formatted value, formatted main-side so a consumer
 *  renders it without knowing the fields. Sparse by provider. */
export interface ModelConfigField {
	label: string;
	value: string;
}

/** One roster row: a descriptor joined with its live status, `doc` and `config`, read in one pull. `visible` is a
 *  flag, not a drop: hiding governs the pickers, never the binding, so a bound hidden model must still resolve. */
export type ModelRosterEntry = ModelDescriptor & { status: ModelStatus; doc: string; config: ModelConfigField[]; visible: boolean };

/** The one model key every resolution path terminates on, and the only one allowed to be hard-wired: the built-in
 *  test brain, always present, so no fallback chain can dead-end. The main-side roster keys its Test Brain entry off it. */
export const DEFAULT_MODEL_KEY = 'test.lorem';

/** The reserved id for connectors that need no account (Local, Laguna, the test brain): a category, never a null,
 *  since a null binding forces a branch every reader may forget. No stored account may claim it. */
export const ACCOUNTLESS_ACCOUNT_ID = 'accountless';
