import type { ContextBlock } from '../core/html/KcdContext';

/**
 * The KCD role of an artifact — determines which context dock it belongs to in the UI.
 * Lens is composite (Know + Care + Do); all others are either informational or procedural.
 */
export type KCDRole = 'know' | 'do' | 'lens';

/**
 * Where a block's ARTIFACT sits in the dredge graph. Specificity runs `injected > agent > lens`, so an agent's habit
 * choice can outrank the lens's in a slot. A Constellation layer between injected and agent stays unrealized.
 */
export type SourceLayer = 'lens' | 'injected' | 'agent';

/** A `ContextBlock` plus the facts `ContextAssembler` and `SlotResolver` reason across artifacts with. Bookkeeping
 *  only: none of it rides into the rendered output. */
export interface TaggedBlock extends ContextBlock {
	sourceLayer: SourceLayer;
	path: string;
	artifactType: ArtifactType;
	/** The artifact's `habit-class` (protocol §6); `null` for classless, additive content. */
	habitClass: string | null;
}

/**
 * One block of an assembled request, by source. `tokens` is the model's own count, filled at run time, or `null`
 * when uncounted; no estimate is ever substituted. `source` is a plain string, so a new artifact type needs no change.
 */
export interface ContextSegment {
	source: string;
	label:  string;          // human label — the artifact name, or the lens path
	text:   string;          // the actual content that went into the request
	tokens: number | null;   // real model-tokenizer count, filled at run; null = uncounted / uncountable
}

/**
 * Where one compiled block files in the per-source breakdown: the folder and label a reader finds it under.
 * `Agent.segmentKey` returns `null` for a structural block, a divider or band heading, which joins the segment it opens.
 */
export interface SegmentKey {
	source: string;
	label:  string;
}

/**
 * A single issue returned by KCDPrimitive.typeCheck().
 * Non-throwing equivalent of the constructor validation errors.
 */
export interface TypeCheckIssue {
	severity: 'error' | 'warn';
	message: string;
	field?: string;
	section?: string;
}

export type ArtifactType =
	| 'lens'
	| 'plan'
	// `reference` covers the whole knowledge store. The folder is the category; a type per folder would only restate it.
	| 'reference'
	| 'generator'
	| 'analyzer'
	// `audit` is retired: an audit is a searchable note, not a document, and `reports/` now carries `unknown`.
	// EPHEMERAL: a verified report is deleted at the monthly sweep. Its fields are the task board's; see BugReportObject.
	| 'bug-report'
	| 'utility'
	| 'habit'
	| 'contract'
	| 'template'
	// Reusable prompt wording a human fills in (see PromptPartialObject). A type, because it is consumed, not read.
	// Not `prompt` or `template`: `template` already names the authoring stencils under `kcd/`.
	| 'prompt-partial'
	| 'framework'
	| 'nav-index'
	// `index` is the pre-vocab-alignment name for `nav-index`, kept until the type union is
	// reconciled against the locked HTML vocab ( utility also pending ). See 05-sub plan.
	| 'index'
	| 'unknown';

export type LinkType = 'internal' | 'external' | 'anchor';

export interface LinkEntry {
	text: string;
	href: string;
	/** internal = vault-root-relative path; external = http(s) URL; anchor = #fragment */
	type: LinkType;
	/** H2 section the link was found in; undefined if in preamble before first H2. */
	section?: string;
}

/**
 * A location that may or may not be occupied (protocol §1.1). Unlike a `LinkEntry`, an address asserts nothing is there,
 * so vacancy is legal and nothing here is validated for existence.
 */
export interface AddressEntry {
	/** The address itself — an artifact `name` slug, or a project-root-relative path. */
	value: string;
	/** The visible prose. Equal to `value` unless the attribute carried the address separately. */
	text: string;
	/** H2 section the address was found in; undefined if in preamble before first H2. */
	section?: string;
}

/**
 * A slot's wire mode, the same for every artifact a slot points at. For tools it is a source vocabulary only: an agent
 * carries `Policy` and `Surface`, and a lens still authors this three-state. `off` excludes, `on` is a routing row, `load` rides inline.
 */
export const SLOT_MODES = [ 'off', 'on', 'load' ] as const;
export type SlotMode = typeof SLOT_MODES[number];

/**
 * A dredge-policy row parsed from a What | Where | Why table.
 * The table format IS the policy language: `data-kcd-mode` on the slot IS the auto-dredge gate.
 */
export interface PolicyEntry {
	what: string;
	href: string;
	why: string;
	mode: SlotMode;
	type: LinkType;
	section?: string;
}

/** Reads raw file content for an absolute path. Throws `PendingRead` for a document it does not have yet;
 *  any other throw means the document is not there. Never crosses the MCP boundary. */
export type ReaderFn = (absPath: string) => string;

export interface SerializedArtifact {
	path: string;
	type: ArtifactType;
	frontmatter: Record<string, unknown>;
	sections: Record<string, string>;
	body: string;
	links: LinkEntry[];
	/** Addresses declared in the body — locations that may or may not be occupied ( protocol §1.1 ). */
	addresses?: AddressEntry[];
	/** Tuned state: whether this artifact contributes to the outbound request.
	 *  Absent = included (the default). Runtime tuning — never written to disk markdown. */
	included?: boolean;
	/** Dredge policy, parsed once at the HTML front end so the receiver never re-derives it. Absent on the md path
	 *  and non-lens artifacts, which re-derive it. */
	policy?: PolicyEntry[];
}

/**
 * The wire form of a dredged lens: its own SerializedArtifact plus its dredged children, each serialized.
 * LensObject.fromSerialized rebuilds it, recursing into each child's own hydrator.
 */
export interface SerializedLens extends SerializedArtifact {
	nodes: SerializedArtifact[];
	/** Know context dropped onto the agent at session time. Never written to disk markdown; absent when nothing was injected. */
	injected?: SerializedArtifact[];
	/** The lens's own per-tool three-state, from its Tools table; the composition baseline the agent's maps override.
	 *  Rides here, not in `nodes`, because a tool is not a dredged node. */
	toolModes?: Record<string, SlotMode>;
	/** Set on a lens that crosses as its RECORD alone — no content and no nodes, only what a reader needs to read
	 *  it on access. The receiver rebuilds it with `LensObject.lazy` and hands it a reader. */
	lazy?: boolean;
	/** The vault root a record's lens reads against, and that vault's folder name — see `LensLoadOptions`. */
	projectRoot?: string;
	docRoot?: string;
}

/** Flat map of path → artifact. Only dirty objects contribute. Atomic unit for save_doc. */
export type WriteMap = Record<string, SerializedArtifact>;

export interface ArtifactRef {
	path: string;
	type: ArtifactType;
	/** frontmatter.name if present, otherwise the filename stem. */
	name: string;
}
