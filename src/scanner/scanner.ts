import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { KcdParse } from '../core/html/KcdParse';

export interface ScanOptions {
	filter?: string;
	/** Whitelist of top-level subdirectories to walk; an unlisted one is skipped whole. Root-level files
	 *  and everything below the first level are always walked. */
	includeDirs?: string[];
}

/** `.html` artifacts (the substrate) and `.js` utilities, whose metadata sits in a `/*--- … ---*\/` comment block. */
const SCAN_EXTS = [ '.html', '.js' ];

export interface RawLink {
	text: string;
	href: string;
}

export interface RawAddress {
	value: string;
	text: string;
}

export interface ScannedFile {
	path: string;
	/** Path relative to the scan root, forward-slashes. */
	relativePath: string;
	/** Parsed frontmatter ( from the HTML `<dl data-kcd-frontmatter>` or a `.js` comment block ). */
	frontmatter: Record<string, unknown>;
	/** All links found in the document — `<a href>` for HTML, `[text](href)` for `.js` comment bodies. */
	rawLinks: RawLink[];
	/** Addresses declared in the body ( protocol §1.1 ) — collected, never probed for occupancy. */
	rawAddresses: RawAddress[];
	/** The document body — inner HTML for an artifact, the post-frontmatter source for a `.js` file. */
	body: string;
}

// JS comment-frontmatter: /*---\n<yaml>\n---*/ — the canonical form for `.js` utilities (a tool
// carries its metadata in a leading block comment parsed exactly like Markdown frontmatter).
const JS_FRONTMATTER_RE = /^\/\*---\r?\n([\s\S]*?)\r?\n---\s*\*\/\r?\n?([\s\S]*)$/;

// Inline links in a `.js` comment body: [text](href). Deliberately simple.
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/** A scan, plus the files it had to drop to produce one. */
export interface ScanReport {
	files: ScannedFile[];
	/** Vault-relative paths of `.html` files that could not be parsed as artifacts, in walk order.
	 *  Absence from `files` reads as "no such document", so every drop is reported here. */
	faults: string[];
}

/** Every artifact under `root`, parsed. The drops are discarded — see `scanReport` to keep them. */
export function scan( root: string, docRoot: string, opts?: ScanOptions ): ScannedFile[] {
	return scanReport( root, docRoot, opts ).files;
}

/**
 * `scan`, reporting what it could not parse. One walk only: re-walking doubles the IO and covers a different set.
 * A `filter` narrows `files` and never `faults`: an unparseable file cannot be said to match or not.
 */
export function scanReport( root: string, docRoot: string, opts?: ScanOptions ): ScanReport {
	const absRoot = path.resolve( root );
	const topDirs = opts?.includeDirs ? new Set( opts.includeDirs ) : null;
	const walked  = walkFiles( absRoot, topDirs );

	const files:  ScannedFile[] = [];
	const faults: string[]      = [];

	for ( const absPath of walked ) {
		const parsed = parseFile( absPath, absRoot, docRoot );
		if ( !parsed ) {
			// Only `.html` can fault: a `.js` file's comment-frontmatter is best-effort, so a `.js` failure
			// must not be reported as an unreadable document.
			if ( /\.html?$/i.test( absPath ) )
				faults.push( path.relative( absRoot, absPath ).replace( /\\/g, '/' ) );
			continue;
		}
		if ( opts?.filter && !parsed.relativePath.includes( opts.filter ) ) continue;
		files.push( parsed );
	}

	return { files, faults };
}

/** `topDirs`, when non-null, gates ONLY the immediate subdirectories of the scan root ( `atRoot` ); an
 *  unlisted one is skipped entirely. Everything else is walked. */
function walkFiles( dir: string, topDirs: Set<string> | null, atRoot = true ): string[] {
	const results: string[] = [];
	let entries: fs.Dirent[];

	try {
		entries = fs.readdirSync( dir, { withFileTypes: true } );
	} catch {
		return results;
	}

	for ( const entry of entries ) {
		const fullPath = path.join( dir, entry.name );
		if ( entry.isDirectory() ) {
			if ( atRoot && topDirs && !topDirs.has( entry.name ) ) continue;
			results.push( ...walkFiles( fullPath, topDirs, false ) );
		} else if ( entry.isFile() && SCAN_EXTS.some( ext => entry.name.endsWith( ext ) ) ) {
			results.push( fullPath );
		}
	}

	return results;
}

/** An HTML file is parsed by the one HTML front end ( KcdParse ); a non-conforming HTML file is not
 *  a KCD artifact and drops out of the scan ( returns null ). A `.js` file keeps the comment path. */
function parseFile( absPath: string, absRoot: string, docRoot: string ): ScannedFile | null {
	const raw          = fs.readFileSync( absPath, 'utf-8' );
	const relativePath = path.relative( absRoot, absPath ).replace( /\\/g, '/' );

	if ( /\.html?$/i.test( absPath ) ) {
		const parsed = KcdParse.tryParse( raw, absPath, docRoot );
		if ( !parsed ) return null;
		return {
			path:        absPath,
			relativePath,
			frontmatter: parsed.frontmatter,
			rawLinks:    parsed.links.map( l => ( { text: l.text, href: l.href } ) ),
			rawAddresses: ( parsed.addresses ?? [] ).map( a => ( { value: a.value, text: a.text } ) ),
			body:        parsed.body,
		};
	}

	const { frontmatter, body } = parseJsFrontmatter( raw );
	return { path: absPath, relativePath, frontmatter, rawLinks: extractLinks( body ), rawAddresses: [], body };
}

function parseJsFrontmatter( content: string ): { frontmatter: Record<string, unknown>; body: string } {
	const match = content.match( JS_FRONTMATTER_RE );
	if ( !match ) return { frontmatter: {}, body: content };

	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = yaml.load( match[1] );
		if ( parsed && typeof parsed === 'object' && !Array.isArray( parsed ) ) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		// Unparseable comment-frontmatter — return empty rather than throwing. A `.js` utility is a
		// code file; its metadata is best-effort here, not a hard gate.
	}

	return { frontmatter, body: match[2] ?? '' };
}

function extractLinks( body: string ): RawLink[] {
	const links: RawLink[] = [];
	LINK_RE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ( ( match = LINK_RE.exec( body ) ) !== null ) {
		links.push( { text: match[1], href: match[2] } );
	}

	return links;
}
