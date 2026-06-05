import * as path from 'path';
import type { ScannedFile } from '../scanner';
import { KCDValidationError } from './errors';
import { KCDPrimitive, clampDepth, classifyHref } from './KCDPrimitive';
import { registerType, createByType } from './factory';
import { classifyByPath, defaultReader, inferProjectRoot, resolveHref } from './io';
import type { PolicyEntry, SerializedArtifact } from './types';

const LENS_DEFAULT_DEPTH = 2;
const ROW_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/;

export interface LensLoadOptions {
	projectRoot?: string;
	depth?: number;
}

/**
 * A lens is the spine: it owns its projectRoot, reads files (via the overridable
 * `readFile` seam), orchestrates its own dredge, and assembles the loaded nodes
 * into an AI context blob. Ask a lens — instantiate with a path and it does the rest.
 */
export class LensObject extends KCDPrimitive {

	protected policy: PolicyEntry[] = [];

	// Spine state — only a dredge root carries these
	protected nodes: KCDPrimitive[] = [];
	protected projectRoot?: string;
	protected dredgeDepth = LENS_DEFAULT_DEPTH;

	protected constructor(path: string) {
		super(path, 'lens');
	}

	// ── Static entry points ──────────────────────────────────────────────────

	/**
	 * Load a lens from disk and dredge its `always`-children server-side.
	 * "Init with a path, it works" — projectRoot is inferred from the path.
	 */
	static load(lensPath: string, opts?: LensLoadOptions): LensObject {
		const abs = path.resolve(lensPath);
		const lens = new LensObject(abs);
		lens.projectRoot = opts?.projectRoot ?? inferProjectRoot(lensPath);
		lens.runInit(lens.readFile(abs));

		const depth = clampDepth(opts?.depth ?? lens.dredgeDepth);
		lens.nodes = lens.dredgeFrom(lens, depth, new Set([abs]));
		return lens;
	}

	static parse(markdown: string, filePath: string): LensObject {
		const obj = new LensObject(filePath);
		obj.runInit(markdown);
		return obj;
	}

	static fromScanned(scanned: ScannedFile): LensObject {
		const obj = new LensObject(scanned.path);
		obj.runInitFromScanned(scanned);
		return obj;
	}

	static fromSerialized(json: SerializedArtifact): LensObject {
		const obj = new LensObject(json.path);
		obj.frontmatter = { ...json.frontmatter };
		obj.sections = { ...json.sections };
		obj.body = json.body;
		obj.links = [...json.links];
		obj.policy = obj.parseKnowPolicy();
		return obj;
	}

	// ── Dredge orchestration (owned by the spine) ─────────────────────────────

	/**
	 * Read raw file content. The single I/O seam — override in a subclass to read
	 * from a virtual FS (UI) or fixtures (tests) without injecting a reader.
	 */
	protected readFile(absPath: string): string {
		return defaultReader(absPath);
	}

	/**
	 * Recursively load `always`-flagged children of `node`, returning a flat list
	 * of every loaded node (node + descendants). `remaining` is a ceiling that
	 * decrements per level; at 1 the node loads but dredges no children. A visited
	 * set breaks cycles and protects already-loaded (possibly edited) nodes.
	 */
	private dredgeFrom(node: KCDPrimitive, remaining: number, visited: Set<string>): KCDPrimitive[] {
		const out: KCDPrimitive[] = [node];
		if (remaining <= 1) return out;

		for (const entry of node.getPolicy()) {
			if (!entry.always || entry.type !== 'internal') continue;

			const childAbs = resolveHref(entry.href, this.projectRoot!);
			if (visited.has(childAbs)) continue;
			visited.add(childAbs);

			let child: KCDPrimitive;
			try {
				const markdown = this.readFile(childAbs);
				child = createByType(classifyByPath(childAbs, this.projectRoot!), markdown, childAbs);
			} catch {
				// Missing or unreadable child — leave it as a stub. kcd_health surfaces
				// broken links later; the dredge does not throw on them.
				continue;
			}

			out.push(...this.dredgeFrom(child, remaining - 1, visited));
		}

		return out;
	}

	// ── Parsing ───────────────────────────────────────────────────────────────

	protected parseBody(body: string): void {
		super.parseBody(body);
		this.policy = this.parseKnowPolicy();
	}

	/**
	 * Parse the Know section's What | Where | Why tables into policy entries.
	 * A row qualifies only if its Where cell contains a markdown link, which
	 * naturally skips the header and separator rows.
	 */
	private parseKnowPolicy(): PolicyEntry[] {
		const know = this.sections['Know'];
		if (!know) return [];

		const entries: PolicyEntry[] = [];
		for (const line of know.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('|')) continue;

			const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
			if (cells.length < 3) continue;

			const [what, where, why] = cells;
			const link = where.match(ROW_LINK_RE);
			if (!link) continue; // header / separator / non-link row

			const href = link[2];
			entries.push({
				what,
				href,
				why,
				always: /^always\b/i.test(why),
				type: classifyHref(href),
				section: 'Know',
			});
		}
		return entries;
	}

	getPolicy(): PolicyEntry[] {
		return [...this.policy];
	}

	getNodes(): KCDPrimitive[] {
		return [...this.nodes];
	}

	// ── Context assembly ───────────────────────────────────────────────────────

	/**
	 * Assemble the AI context blob. Each loaded node renders its own block; the
	 * lens's unloaded policy entries trail as a What | Where | Why table the agent
	 * can request on demand. Server-side operation — requires a loaded projectRoot.
	 *
	 * First-cut ordering is load order; section-aware ordering comes later.
	 */
	serializeForContext(): string {
		if (!this.projectRoot) {
			throw new Error('serializeForContext requires a loaded lens (no projectRoot)');
		}

		const list = this.nodes.length ? this.nodes : [this];
		const loadedPaths = new Set(list.map(n => n.getPath()));
		const out = list.map(n => n.toContextBlock());

		const stubs = this.policy.filter(
			e => e.type === 'internal' && !loadedPaths.has(resolveHref(e.href, this.projectRoot!))
		);
		if (stubs.length) {
			const rows = stubs.map(e => `| ${e.what} | ${e.href} | ${e.why} |`).join('\n');
			out.push(`# Available on request\n\n| What | Where | Why |\n|---|---|---|\n${rows}`);
		}

		return out.join('\n\n---\n\n');
	}

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if (this.frontmatter['type'] !== 'lens') {
			throw new KCDValidationError(
				`LensObject: frontmatter.type must be "lens"`,
				this.path,
				'"lens"',
				String(this.frontmatter['type'] ?? null),
				{ field: 'type' }
			);
		}

		if (!this.frontmatter['command']) {
			throw new KCDValidationError(
				`LensObject: frontmatter.command is required`,
				this.path,
				'command field present',
				null,
				{ field: 'command' }
			);
		}
	}

	protected validateStructure(): void {
		for (const section of ['Know', 'Care', 'Do']) {
			if (!this.sections[section]) {
				throw new KCDValidationError(
					`LensObject: required section "${section}" is missing`,
					this.path,
					`## ${section} section`,
					null,
					{ section }
				);
			}
		}
	}
}

registerType('lens', (markdown, absPath) => LensObject.parse(markdown, absPath));
