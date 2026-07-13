import type { ContextBlock } from '../core/html/KcdContext';

/**
 * The KCD role of an artifact — determines which context dock it belongs to in the UI.
 * Lens is composite (Know + Care + Do); all others are either informational or procedural.
 */
export type KCDRole = 'know' | 'do' | 'lens';

/**
 * Where a block's ARTIFACT sits relative to the dredge graph — not the artifact's own
 * Know/Care/Do region. The specificity hierarchy is `injected > agent > lens`: a session-dropped
 * node is most specific, then a component the AGENT bolts on itself ( `base*` — its own habit/reference
 * choices ), then what a lens contributes. `agent` is what lets an agent's habit choice OUTRANK the
 * lens's in a slot ( the composability of behaviour ). The plan's full hierarchy also names a
 * Constellation layer between injected and agent; that stays unrealized ( no distinct Constellation
 * source tag exists yet ). `SlotResolver.RANK` reads through this type, so adding the last layer later
 * is a rank-map edit, not a redesign.
 */
export type SourceLayer = 'lens' | 'injected' | 'agent';

/** A `ContextBlock` plus the facts `ContextAssembler`/`SlotResolver` need to reason ACROSS
 *  artifacts — where in the dredge graph it came from, which artifact it came from, that artifact's
 *  own type, and its `habit-class` (if any). Bookkeeping only; the wire text stays source-blind,
 *  none of these ride into the rendered output. `artifactType` is what lets a merge group resolve
 *  "lens leads" (`ContextAssembler.merge`); `habitClass` is what lets `SlotResolver` find contending
 *  blocks in the first place. */
export interface TaggedBlock extends ContextBlock {
	sourceLayer: SourceLayer;
	path: string;
	artifactType: ArtifactType;
	/** This block's artifact's own `habit-class` frontmatter field (protocol §6), or `null` for
	 *  classless (additive) content — the default for everything that isn't a classed habit. */
	habitClass: string | null;
}

/**
 * ContextSegment — one block of an assembled request's context, broken out by SOURCE for inspection.
 * The flat system string a model sees is `Σ` of these joined; kept structured so the telemetry/transcript
 * can show WHAT each source contributed and what it COST.
 *
 *  - `source` — the bucket: `'system'` (the agent's systemPrompt / above-lens layer), `'lens'` (a lens
 *    header block), an artifact type (`'reference' | 'plan' | 'habit' | 'index' | …`), or `'instruction'`
 *    (the task body). Drives the per-source grouping + colour. A plain string (not a tight union) — a new
 *    artifact type slots in without a type change at this glue seam.
 *  - `tokens` — the REAL count from the model's own tokenizer, filled at RUN time (main-side, where the
 *    connector lives). `null` when not yet counted or the connector can't count — no estimate is ever
 *    substituted (the ruling: real values, never guesses).
 */
export interface ContextSegment {
	source: string;
	label:  string;          // human label — the artifact name, or the lens path
	text:   string;          // the actual content that went into the request
	tokens: number | null;   // real model-tokenizer count, filled at run; null = uncounted / uncountable
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
	| 'reference'
	| 'note'
	| 'how-to'
	| 'generator'
	| 'analyzer'
	| 'utility'
	| 'habit'
	| 'contract'
	| 'template'
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
 * A slot's wire mode — the SAME idiom for every artifact a slot can point at (reference, habit,
 * contract, plan, MCP tool, anything else routable). No per-artifact-type special casing. Mirrors
 * `ToolMode` (kcd_sdk/src/agent/ToolMode.ts) — same three values, same off→on→suggested framing;
 * kept as its own type rather than importing ToolMode here since `agent` depends on `primitives`,
 * not the other way around, but the UI layer is free to treat them interchangeably.
 *   off       — excluded entirely; not dredged, not even shown as a routing row.
 *   on        — the default. Routing row only (what/where/why) — the agent looks it up when its
 *               When/trigger fires. Cheap: never fetched into the context-assembly graph.
 *   suggested — the target's full text is dredged and rides inline, no lookup required.
 */
export const SLOT_MODES = [ 'off', 'on', 'suggested' ] as const;
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

/** Reads raw file content for an absolute path. Server-side only; never crosses the MCP boundary. */
export type ReaderFn = (absPath: string) => string;

export interface SerializedArtifact {
	path: string;
	type: ArtifactType;
	frontmatter: Record<string, unknown>;
	sections: Record<string, string>;
	body: string;
	links: LinkEntry[];
	/** Tuned state: whether this artifact contributes to the outbound request.
	 *  Absent = included (the default). Runtime tuning — never written to disk markdown. */
	included?: boolean;
	/** Dredge policy, parsed once at the HTML front end and carried across the bridge so the
	 *  receiver never re-derives it. Absent on the md path / non-lens artifacts (LensObject
	 *  re-derives from its Know table). The parser owns policy; this is where it rides. */
	policy?: PolicyEntry[];
}

/**
 * The wire form of a dredged lens: the lens's own SerializedArtifact plus its dredged
 * children (NOT the lens itself), each serialized. Crosses the bridge whole; the receiver
 * rebuilds it with LensObject.fromSerialized, which recurses each child's own hydrator.
 */
export interface SerializedLens extends SerializedArtifact {
	nodes: SerializedArtifact[];
	/** Dynamically injected Know context — references/plans dropped onto the agent at
	 *  session time (the GUI equivalent of pasting context into a chat window). Rides
	 *  the wire and contributes as always-loaded Know; never written to disk markdown.
	 *  Absent on a lens that has had nothing injected. */
	injected?: SerializedArtifact[];
	/** Per-tool three-state inclusion the LENS itself contributes ( tool name → mode ), parsed from
	 *  the lens's Tools table ( `data-kcd-section="tools"` — where-less slots, MCP tool names, not
	 *  path artifacts ). The composition BASELINE an agent's own `toolModes` overrides per-tool
	 *  ( Agent.effectiveToolModes ). Absent on a lens with no Tools table. Unlike references/habits,
	 *  a tool is not a dredged node, so it rides here rather than in `nodes`. */
	toolModes?: Record<string, SlotMode>;
}

/** Flat map of path → artifact. Only dirty objects contribute. Atomic unit for kcd_save. */
export type WriteMap = Record<string, SerializedArtifact>;

export interface ArtifactRef {
	path: string;
	type: ArtifactType;
	/** frontmatter.name if present, otherwise the filename stem. */
	name: string;
}
