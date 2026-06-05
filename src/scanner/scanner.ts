import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ScanOptions {
	/** Substring filter applied to relativePath. Omit to return all .md files. */
	filter?: string;
}

export interface RawLink {
	text: string;
	href: string;
}

export interface ScannedFile {
	/** Absolute path to the file. */
	path: string;
	/** Path relative to the scan root, forward-slashes. */
	relativePath: string;
	/** Parsed YAML frontmatter. Empty object if none present. */
	frontmatter: Record<string, unknown>;
	/** All [text](href) inline links found in the document body. */
	rawLinks: RawLink[];
	/** Everything after the closing frontmatter delimiter. */
	body: string;
}

// Matches ---\n<yaml>\n--- at the start of a file, capturing yaml and body.
// \r? throughout so it works on Windows CRLF files.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Inline markdown links: [text](href)
// Deliberately simple — KCD files don't use nested brackets or parens in links.
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function scan(root: string, opts?: ScanOptions): ScannedFile[] {
	const absRoot = path.resolve(root);
	const files = walkMd(absRoot);

	return files
		.map(absPath => parseFile(absPath, absRoot))
		.filter(f => !opts?.filter || f.relativePath.includes(opts.filter));
}

function walkMd(dir: string): string[] {
	const results: string[] = [];
	let entries: fs.Dirent[];

	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkMd(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			results.push(fullPath);
		}
	}

	return results;
}

function parseFile(absPath: string, absRoot: string): ScannedFile {
	const raw = fs.readFileSync(absPath, 'utf-8');
	const relativePath = path.relative(absRoot, absPath).replace(/\\/g, '/');
	const { frontmatter, body } = parseFrontmatter(raw);
	const rawLinks = extractLinks(body);

	return { path: absPath, relativePath, frontmatter, rawLinks, body };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = content.match(FRONTMATTER_RE);

	if (!match) {
		return { frontmatter: {}, body: content };
	}

	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = yaml.load(match[1]);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		// Unparseable frontmatter — return empty rather than throwing.
		// The KCD object layer will throw if it needs a valid frontmatter field.
	}

	return { frontmatter, body: match[2] ?? '' };
}

function extractLinks(body: string): RawLink[] {
	const links: RawLink[] = [];
	LINK_RE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = LINK_RE.exec(body)) !== null) {
		links.push({ text: match[1], href: match[2] });
	}

	return links;
}
