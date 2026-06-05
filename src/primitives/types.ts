export type ArtifactType =
	| 'lens'
	| 'plan'
	| 'reference'
	| 'generator'
	| 'analyzer'
	| 'pipeline'
	| 'habit'
	| 'contract'
	| 'template'
	| 'framework'
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
}

/** Flat map of path → artifact. Only dirty objects contribute. Atomic unit for kcd_save. */
export type WriteMap = Record<string, SerializedArtifact>;

export interface ArtifactRef {
	path: string;
	type: ArtifactType;
	/** frontmatter.name if present, otherwise the filename stem. */
	name: string;
}
