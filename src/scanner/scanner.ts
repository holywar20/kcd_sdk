import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { KcdParse } from '../core/html/KcdParse';

export interface ScanOptions {
	/** Substring filter applied to relativePath. Omit to return all scanned files. */
	filter?: string;
}

/** The file extensions the scanner indexes — HTML artifacts ( the substrate ) plus `.js` utilities
 *  ( the canonical registered-tool form, metadata in a `/*--- … ---*\/` comment block ). Markdown is
 *  gone: HTML is the sole document substrate. */
const SCAN_EXTS = [ '.html', '.js' ];

export interface RawLink {
	text: string;
	href: string;
}

export interface ScannedFile {
	/** Absolute path to the file. */
	path: string;
	/** Path relative to the scan root, forward-slashes. */
	relativePath: string;
	/** Parsed frontmatter ( from the HTML `<dl data-kcd-frontmatter>` or a `.js` comment block ). */
	frontmatter: Record<string, unknown>;
	/** All links found in the document — `<a href>` for HTML, `[text](href)` for `.js` comment bodies. */
	rawLinks: RawLink[];
	/** The document body — inner HTML for an artifact, the post-frontmatter source for a `.js` file. */
	body: string;
}

// JS comment-frontmatter: /*---\n<yaml>\n---*/ — the canonical form for `.js` utilities (a tool
// carries its metadata in a leading block comment parsed exactly like the old markdown frontmatter).
const JS_FRONTMATTER_RE = /^\/\*---\r?\n([\s\S]*?)\r?\n---\s*\*\/\r?\n?([\s\S]*)$/;

// Inline links in a `.js` comment body: [text](href). Deliberately simple.
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function scan( root: string, opts?: ScanOptions ): ScannedFile[] {
	const absRoot = path.resolve( root );
	const files   = walkFiles( absRoot );

	return files
		.map( absPath => parseFile( absPath, absRoot ) )
		.filter( ( f ): f is ScannedFile => f !== null )
		.filter( f => !opts?.filter || f.relativePath.includes( opts.filter ) );
}

function walkFiles( dir: string ): string[] {
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
			results.push( ...walkFiles( fullPath ) );
		} else if ( entry.isFile() && SCAN_EXTS.some( ext => entry.name.endsWith( ext ) ) ) {
			results.push( fullPath );
		}
	}

	return results;
}

/** An HTML file is parsed by the one HTML front end ( KcdParse ); a non-conforming HTML file is not
 *  a KCD artifact and drops out of the scan ( returns null ). A `.js` file keeps the comment path. */
function parseFile( absPath: string, absRoot: string ): ScannedFile | null {
	const raw          = fs.readFileSync( absPath, 'utf-8' );
	const relativePath = path.relative( absRoot, absPath ).replace( /\\/g, '/' );

	if ( /\.html?$/i.test( absPath ) ) {
		const parsed = KcdParse.tryParse( raw, absPath );
		if ( !parsed ) return null;
		return {
			path:        absPath,
			relativePath,
			frontmatter: parsed.frontmatter,
			rawLinks:    parsed.links.map( l => ( { text: l.text, href: l.href } ) ),
			body:        parsed.body,
		};
	}

	const { frontmatter, body } = parseJsFrontmatter( raw );
	return { path: absPath, relativePath, frontmatter, rawLinks: extractLinks( body ), body };
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
