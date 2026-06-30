/**
 * The KCD role of an artifact — determines which context dock it belongs to in the UI.
 * Lens is composite (Know + Care + Do); all others are either informational or procedural.
 */
export type KCDRole = 'know' | 'do' | 'lens';

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
	| 'generator'
	| 'analyzer'
	| 'pipeline'
	| 'utility'
	| 'habit'
	| 'contract'
	| 'template'
	| 'framework'
	| 'nav-index'
	// `index` is the pre-vocab-alignment name for `nav-index`, kept until the type union is
	// reconciled against the locked HTML vocab ( pipeline/utility also pending ). See 05-sub plan.
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
 * A dredge-policy row parsed from a What | Where | Why table.
 * The table format IS the policy language: `always` in the Why cell = auto-dredge.
 */
export interface PolicyEntry {
	what: string;
	href: string;
	why: string;
	always: boolean;
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
}

/** Flat map of path → artifact. Only dirty objects contribute. Atomic unit for kcd_save. */
export type WriteMap = Record<string, SerializedArtifact>;

export interface ArtifactRef {
	path: string;
	type: ArtifactType;
	/** frontmatter.name if present, otherwise the filename stem. */
	name: string;
}
