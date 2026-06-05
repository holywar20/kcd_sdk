import * as yaml from 'js-yaml';
import type { ScannedFile } from '../scanner';
import { KCDParseError } from './errors';
import type { ArtifactType, LinkEntry, LinkType, PolicyEntry, SerializedArtifact, WriteMap } from './types';
import { registerFallback } from './factory';

export const DREDGE_MAX = 4;

/** Clamp a requested dredge depth into the legal [1, DREDGE_MAX] range. */
export function clampDepth(depth: number): number {
	return Math.max(1, Math.min(DREDGE_MAX, Math.floor(depth)));
}

const H2_RE = /^## (.+)$/gm;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Base artifact: data + the parse chain + working stubs.
 *
 * Everything here works with no configuration. `getPolicy()` returns [], so a
 * bare primitive is a leaf that dredges to `[this]`. Subclasses override the
 * stubs (`validateFrontmatter`, `validateStructure`, `parseBody`, `getPolicy`,
 * `toContextBlock`) to add type-specific behavior. Spine concerns (the flat node
 * list, the reader, the dredge budget) live on the root subclass, not here.
 */
export class KCDPrimitive {

	protected path: string;
	protected type: ArtifactType;

	// Data
	protected body: string;
	protected links: LinkEntry[];
	protected sections: Record<string, string>;
	protected frontmatter: Record<string, unknown>;

	protected isDirty: boolean;

	protected constructor(path: string, type: ArtifactType) {
		this.path = path;
		this.type = type;

		this.body = '';
		this.links = [];
		this.sections = {};
		this.frontmatter = {};

		this.isDirty = false;
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/** Parse raw markdown into a base primitive. Subclasses shadow with a typed return. */
	static parse(markdown: string, filePath: string): KCDPrimitive {
		const obj = new KCDPrimitive(filePath, 'unknown');
		obj.runInit(markdown);
		return obj;
	}

	/** Promote a ScannedFile (raw scanner output) into a primitive — no frontmatter re-parse. */
	static fromScanned(scanned: ScannedFile): KCDPrimitive {
		const obj = new KCDPrimitive(scanned.path, 'unknown');
		obj.runInitFromScanned(scanned);
		return obj;
	}

	/** Build a base primitive of a given type. Used as the factory fallback for unregistered types. */
	static createBase(markdown: string, absPath: string, type: ArtifactType): KCDPrimitive {
		const obj = new KCDPrimitive(absPath, type);
		obj.runInit(markdown);
		return obj;
	}

	/** Hydrate from a SerializedArtifact (MCP wire format) — trusts the state as already valid. */
	static fromSerialized(json: SerializedArtifact): KCDPrimitive {
		const obj = new KCDPrimitive(json.path, json.type);
		obj.frontmatter = { ...json.frontmatter };
		obj.sections = { ...json.sections };
		obj.body = json.body;
		obj.links = [...json.links];
		return obj;
	}

	/** Collect dirty objects into a flat WriteMap. Only dirty objects contribute. */
	static collectWrites(objects: KCDPrimitive[]): WriteMap {
		const writes: WriteMap = {};
		for (const obj of objects) {
			if (obj.isDirty) {
				writes[obj.path] = obj.serialize();
			}
		}
		return writes;
	}

	// ── Pipeline runners ─────────────────────────────────────────────────────

	protected runInit(markdown: string): void {
		const { frontmatter, body } = this.splitFrontmatter(markdown);
		this.frontmatter = frontmatter;
		this.validateFrontmatter();
		this.parseBody(body);
		this.validateStructure();
		this.extractLinks();
	}

	protected runInitFromScanned(scanned: ScannedFile): void {
		this.frontmatter = { ...scanned.frontmatter };
		this.validateFrontmatter();
		this.parseBody(scanned.body);
		this.validateStructure();
		this.extractLinks();
	}

	private splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
		const match = markdown.match(FRONTMATTER_RE);
		if (!match) {
			return { frontmatter: {}, body: markdown };
		}

		let frontmatter: Record<string, unknown> = {};
		try {
			const parsed = yaml.load(match[1]);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch (e) {
			throw new KCDParseError(
				`Frontmatter YAML parse failed: ${e instanceof Error ? e.message : String(e)}`,
				this.path,
				match[1]
			);
		}

		return { frontmatter, body: match[2] ?? '' };
	}

	// ── Overridable hooks (working stubs) ─────────────────────────────────────

	/** Base: no required fields. Subclasses add type-specific checks and call super(). */
	protected validateFrontmatter(): void {}

	/** Base: split the body into H2 sections. Subclasses call super() then extend. */
	protected parseBody(body: string): void {
		this.body = body;
		this.sections = {};

		// Split on H2 headers. parts[0] is the preamble (H1 + intro before first H2).
		const parts = body.split(/^## /m);
		for (let i = 1; i < parts.length; i++) {
			const nl = parts[i].indexOf('\n');
			if (nl === -1) {
				this.sections[parts[i].trim()] = '';
			} else {
				const name = parts[i].slice(0, nl).trim();
				const content = parts[i].slice(nl + 1).trim();
				this.sections[name] = content;
			}
		}
	}

	/** Base: no required sections. Subclasses check for type-specific required sections. */
	protected validateStructure(): void {}

	/** Extract inline links from the body, tagged with their type and H2 section. */
	protected extractLinks(): void {
		this.links = [];

		const boundaries: Array<{ name: string; start: number }> = [];
		H2_RE.lastIndex = 0;
		let h2: RegExpExecArray | null;
		while ((h2 = H2_RE.exec(this.body)) !== null) {
			boundaries.push({ name: h2[1].trim(), start: h2.index });
		}

		const sectionAt = (pos: number): string | undefined => {
			let current: string | undefined;
			for (const b of boundaries) {
				if (b.start <= pos) current = b.name;
				else break;
			}
			return current;
		};

		LINK_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = LINK_RE.exec(this.body)) !== null) {
			this.links.push({
				text: m[1],
				href: m[2],
				type: classifyHref(m[2]),
				section: sectionAt(m.index),
			});
		}
	}

	/**
	 * The dredge policy: which links are eligible, and which are flagged `always`.
	 * Base is a leaf — returns []. Subclasses carrying a What|Where|Why table override.
	 * Public so the spine (LensObject) can ask any node for its targets during a dredge.
	 */
	getPolicy(): PolicyEntry[] {
		return [];
	}

	// ── Serialization ────────────────────────────────────────────────────────

	toMarkdown(): string {
		const fm = yaml.dump(this.frontmatter, { lineWidth: -1 }).trimEnd();
		return `---\n${fm}\n---\n\n${this.body}`;
	}

	serialize(): SerializedArtifact {
		return {
			path: this.path,
			type: this.type,
			frontmatter: { ...this.frontmatter },
			sections: { ...this.sections },
			body: this.body,
			links: [...this.links],
		};
	}

	/** One node's content block for the AI context blob. Subclasses may override ordering. */
	toContextBlock(): string {
		return `# [${this.type}] ${this.path}\n\n${this.body.trim()}`;
	}

	// ── Getters ──────────────────────────────────────────────────────────────

	getPath(): string { return this.path; }
	getType(): ArtifactType { return this.type; }
	getFrontmatter(): Record<string, unknown> { return { ...this.frontmatter }; }
	getSections(): Record<string, string> { return { ...this.sections }; }
	getLinks(): LinkEntry[] { return [...this.links]; }
	get dirty(): boolean { return this.isDirty; }
}

export function classifyHref(href: string): LinkType {
	if (href.startsWith('#')) return 'anchor';
	if (href.startsWith('http://') || href.startsWith('https://')) return 'external';
	return 'internal';
}

// Base primitive is the fallback for any unregistered type (reference, framework, index, …).
registerFallback((markdown, absPath, type) => KCDPrimitive.createBase(markdown, absPath, type));
