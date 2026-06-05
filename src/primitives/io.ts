import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactType, ReaderFn } from './types';

export const DEFAULT_DOC_ROOT = '_Claude';

/** Default server-side reader. Reads UTF-8 file content. */
export const defaultReader: ReaderFn = (absPath: string): string => {
	return fs.readFileSync(absPath, 'utf-8');
};

/**
 * Infer projectRoot from any path inside the project by walking up to the
 * first ancestor directory that contains docRoot (e.g. `_Claude`).
 * Throws if no such ancestor exists.
 */
export function inferProjectRoot(startPath: string, docRoot = DEFAULT_DOC_ROOT): string {
	let dir = path.dirname(path.resolve(startPath));
	while (true) {
		if (fs.existsSync(path.join(dir, docRoot))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break; // hit filesystem root
		dir = parent;
	}
	throw new Error(`Could not infer projectRoot from "${startPath}" — no ancestor contains "${docRoot}"`);
}

/**
 * Resolve a vault-root-relative href (e.g. `_Claude/kcd/x.md` or `CLAUDE.md`)
 * to an absolute path under projectRoot.
 */
export function resolveHref(href: string, projectRoot: string): string {
	return path.resolve(projectRoot, href);
}

/**
 * Classify an artifact by directory convention. Directory wins over frontmatter.
 * Prefixes are matched relative to docRoot; anything outside docRoot is `unknown`.
 */
export function classifyByPath(absPath: string, projectRoot: string, docRoot = DEFAULT_DOC_ROOT): ArtifactType {
	const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');

	if (!rel.startsWith(docRoot + '/')) {
		return 'unknown'; // e.g. CLAUDE.md at the project root
	}

	const sub = rel.slice(docRoot.length + 1);

	if (sub.startsWith('lenses/')) return 'lens';
	if (sub.startsWith('plans_complete/')) return 'plan';
	if (sub.startsWith('plans/')) return 'plan';
	if (sub.startsWith('references/')) return 'reference';
	if (sub.startsWith('generators/')) return 'generator';
	if (sub.startsWith('analyzers/')) return 'analyzer';
	if (sub.startsWith('pipelines/')) return 'pipeline';
	if (sub.startsWith('habits/')) return 'habit';
	if (sub.startsWith('contracts/')) return 'contract';
	if (sub.startsWith('kcd/templates/')) return 'template';
	if (sub.startsWith('kcd/')) return 'framework';

	return 'unknown';
}
