import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * Heal by canonical path, not by graph: the text pass reaches what the parse graph cannot (markdown
 * todos, `data-kcd-address`, the project-root CLAUDE.md, files that fail to parse).
 *
 * EVERY CASE HERE PINS A POSITIVE NUMBER OR A CONCRETE STRING ON DISK. A heal that did not throw proves
 * nothing: the old behaviour did not throw either, it just never looked.
 */

let root = '';
const vaultOf = () => new Vault( root, '_Claude' );

/** A minimal valid KCD artifact. `body` is dropped in verbatim, so a case can plant whatever it needs. */
const doc = ( name: string, body: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n${ body }\n</article>\n</body></html>\n`;

const TARGET     = 'references/patterns/alpha.html';
const TARGET_REF = '_Claude/references/patterns/alpha.html';
const MOVED      = 'references/domain/alpha.html';
const MOVED_REF  = '_Claude/references/domain/alpha.html';

const put = ( rel: string, content: string ) => {
	const abs = join( root, rel );
	mkdirSync( join( abs, '..' ), { recursive: true } );
	writeFileSync( abs, content );
	return abs;
};
const readAt = ( rel: string ) => readFileSync( join( root, rel ), 'utf-8' );

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-heal-' ) );
	put( `_Claude/${ TARGET }`, doc( 'alpha', '<p>The target.</p>' ) );
	mkdirSync( join( root, '_Claude', 'references', 'domain' ), { recursive: true } );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'Vault heal — the TEXT pass reaches what the graph cannot', () => {

	it( 'heals a markdown todo, which is not an artifact and never enters the scan', () => {
		put( '_Claude/logs/driver/todo/todo.md', `- [ ] see [alpha](${ TARGET_REF }) about this\n` );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 1 );
		expect( plan.edits[ 0 ]!.file ).toBe( 'logs/driver/todo/todo.md' );
		expect( readAt( '_Claude/logs/driver/todo/todo.md' ) ).toContain( MOVED_REF );
	} );

	/**
	 * A document that fails to parse is dropped by `scan()`, so the graph pass sees no reference in it.
	 * A malformed file is the one whose links nobody else maintains.
	 */
	it( 'heals a document that fails to parse, which the graph pass drops entirely', () => {
		put( '_Claude/references/patterns/broken.html',
			`<!DOCTYPE html><html><body><p>no article root — <a href="${ TARGET_REF }">alpha</a></p></body></html>\n` );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.map( e => e.file ) ).toContain( 'references/patterns/broken.html' );
		expect( readAt( '_Claude/references/patterns/broken.html' ) ).toContain( MOVED_REF );
	} );

	it( 'heals CLAUDE.md at the PROJECT root, which is outside the vault and outside the scan', () => {
		writeFileSync( join( root, 'CLAUDE.md' ), `Read the [layout](${ TARGET_REF }) first.\n` );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.map( e => e.file ) ).toContain( '../CLAUDE.md' );
		expect( readFileSync( join( root, 'CLAUDE.md' ), 'utf-8' ) ).toContain( MOVED_REF );
	} );

	/**
	 * The path sits in the opening tag of the `<code>` element, not its content. Classing a match inside a
	 * code element as quoted speech would leave every address in the corpus unhealed.
	 */
	it( 'heals a data-kcd-address, and does NOT mistake it for the <code> element it lives on', () => {
		put( '_Claude/references/patterns/beta.html',
			doc( 'beta', `<p>Lives at <code data-kcd-address="${ TARGET_REF }">alpha</code>.</p>` ) );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.reported.length ).toBe( 0 );
		expect( plan.edits.map( e => e.file ) ).toContain( 'references/patterns/beta.html' );
		expect( readAt( '_Claude/references/patterns/beta.html' ) ).toContain( `data-kcd-address="${ MOVED_REF }"` );
	} );
} );

describe( 'Vault heal — quoted speech is REPORTED, never rewritten', () => {

	it( 'leaves an href sitting in <code> CONTENT alone, and says so rather than silently skipping it', () => {
		put( '_Claude/habits/quoting.html',
			doc( 'quoting', `<p>Write it as <code>&lt;a href="${ TARGET_REF }"&gt;alpha&lt;/a&gt;</code> exactly.</p>` ) );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 0 );
		expect( plan.reported.length ).toBe( 1 );
		expect( plan.reported[ 0 ]!.untouched ).toBe( 'quoted' );
		// The lesson still teaches the same thing it taught before the move.
		expect( readAt( '_Claude/habits/quoting.html' ) ).toContain( TARGET_REF );
	} );

	/**
	 * Known limit, pinned: the quoted-speech rule applies per FILE, so a document holding both a live link
	 * and a quoted sample of the same href has the sample swapped too. Per-occurrence needs positional
	 * surgery on the write path. The reference is in `edits`, not `reported`, because the file was touched.
	 */
	it( 'a file holding BOTH a live link and a quoted sample has the sample swapped too', () => {
		put( '_Claude/references/patterns/beta.html', doc( 'beta',
			`<p>See <a href="${ TARGET_REF }">alpha</a>. Write it as `
			+ `<code>&lt;a href="${ TARGET_REF }"&gt;a&lt;/a&gt;</code>.</p>` ) );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 1 );
		expect( plan.reported.length ).toBe( 0 );
		expect( readAt( '_Claude/references/patterns/beta.html' ) ).not.toContain( TARGET_REF );
	} );

	it( 'leaves a markdown fenced block alone', () => {
		put( '_Claude/logs/driver/todo/todo.md', '- [ ] run it\n\n```\n[alpha](' + TARGET_REF + ')\n```\n' );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 0 );
		expect( plan.reported.map( e => e.untouched ) ).toEqual( [ 'quoted' ] );
		expect( readAt( '_Claude/logs/driver/todo/todo.md' ) ).toContain( TARGET_REF );
	} );
} );

describe( 'Vault heal — the ruled scope, as a whitelist', () => {

	it( 'heals logs/*/todo/ but NOT session.md or completed/ — those are historical records', () => {
		put( '_Claude/logs/driver/todo/todo.md',           `- [ ] live: [a](${ TARGET_REF })\n` );
		put( '_Claude/logs/driver/completed/completed.md', `- [x] 2026-08-01 did [a](${ TARGET_REF })\n` );
		put( '_Claude/logs/session.md',                    `2026-08-01 — touched [a](${ TARGET_REF })\n` );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.map( e => e.file ) ).toEqual( [ 'logs/driver/todo/todo.md' ] );
		expect( readAt( '_Claude/logs/driver/completed/completed.md' ) ).toContain( TARGET_REF );
		expect( readAt( '_Claude/logs/session.md' ) ).toContain( TARGET_REF );
	} );

	it( 'does not walk the project tree at large — only the named host entry files', () => {
		writeFileSync( join( root, 'README.md' ), `See [a](${ TARGET_REF }).\n` );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 0 );
		expect( readFileSync( join( root, 'README.md' ), 'utf-8' ) ).toContain( TARGET_REF );
	} );
} );

describe( 'Vault heal — the count means referrers', () => {

	it( 'reports a link both passes see exactly once', () => {
		put( '_Claude/references/patterns/beta.html',
			doc( 'beta', `<p>See <a href="${ TARGET_REF }">alpha</a>.</p>` ) );

		const found = vaultOf().healOccurrences( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ) );

		expect( found.graph.length ).toBe( 1 );
		expect( found.text.length ).toBe( 0 );      // the graph already claimed it
		expect( found.quoted.length ).toBe( 0 );
	} );

	/**
	 * One edit is one (referrer, href) swap: `rewriteHref` replaces every occurrence. Counting per link would
	 * list identical no-op edits for a document naming the target three times.
	 */
	it( 'counts a referrer once however many times it names the target, and still rewrites all of them', () => {
		put( '_Claude/references/patterns/beta.html', doc( 'beta',
			`<p><a href="${ TARGET_REF }">a</a> <a href="${ TARGET_REF }">b</a> <a href="${ TARGET_REF }">c</a></p>` ) );

		const plan = vaultOf().move( TARGET, MOVED );

		expect( plan.edits.length ).toBe( 1 );
		const after = readAt( '_Claude/references/patterns/beta.html' );
		expect( after.split( MOVED_REF ).length - 1 ).toBe( 3 );
		expect( after ).not.toContain( TARGET_REF );
	} );
} );

describe( 'Vault heal — delete reports what it cannot excise instead of failing after the fact', () => {

	/**
	 * Excision is parse-and-splice, so it reaches parsed HTML and `.js` only. A markdown reference cannot be
	 * cut span-precisely, and rewriting prose is not a delete's job, so it is named as one that will dangle.
	 */
	it( 'names a markdown reference as not-excisable rather than excising or ignoring it', () => {
		put( '_Claude/logs/driver/todo/todo.md', `- [ ] see [alpha](${ TARGET_REF })\n` );

		const plan = vaultOf().delete( TARGET );

		expect( plan.edits.length ).toBe( 0 );
		expect( plan.reported.length ).toBe( 1 );
		expect( plan.reported[ 0 ]!.untouched ).toBe( 'not-excisable' );
		expect( plan.reported[ 0 ]!.file ).toBe( 'logs/driver/todo/todo.md' );
	} );
} );

/**
 * A move must also re-express the moved document's own stylesheet href, which is depth-relative (protocol
 * §8.1). It fails silently: the page still parses and renders plain, so every case pins the href on disk.
 */
describe( 'Vault move — the moved document\'s OWN stylesheet link', () => {

	/** The fixture with a head that carries a link, at whatever depth the case needs it written for. */
	const linked = ( name: string, href: string ) =>
		doc( name, '<p>The target.</p>' ).replace( '</head>', `<link rel="stylesheet" href="${ href }">\n</head>` );

	const hrefIn = ( rel: string ) => /<link\s+rel="stylesheet"\s+href="([^"]+)"/.exec( readAt( rel ) )?.[ 1 ] ?? null;

	it( 'restamps the href when the move changes depth', () => {
		put( `_Claude/${ TARGET }`, linked( 'alpha', '../../kcd.css' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( hrefIn( '_Claude/plans/alpha.html' ) ).toBe( '../kcd.css' );
	} );

	/**
	 * Attribute order is not significant: a hand-edited head with `href` before `rel` was once skipped without
	 * a report. These two cases stop that returning; the others use the emitter's order.
	 */
	const linkedRaw = ( name: string, tag: string ) =>
		doc( name, '<p>The target.</p>' ).replace( '</head>', `${ tag }
</head>` );

	const anyHrefIn = ( rel: string ) => /<link\b[^>]*\bhref\s*=\s*"([^"]*)"/.exec( readAt( rel ) )?.[ 1 ] ?? null;

	it( 'restamps a link whose href comes BEFORE rel', () => {
		put( `_Claude/${ TARGET }`, linkedRaw( 'alpha', '<link href="../../kcd.css" rel="stylesheet">' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( anyHrefIn( '_Claude/plans/alpha.html' ) ).toBe( '../kcd.css' );
	} );

	it( 'restamps a link carrying an extra attribute', () => {
		put( `_Claude/${ TARGET }`, linkedRaw( 'alpha', '<link rel="stylesheet" type="text/css" href="../../kcd.css" />' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( anyHrefIn( '_Claude/plans/alpha.html' ) ).toBe( '../kcd.css' );
	} );

	it( 'leaves the href alone when the depth is unchanged', () => {
		put( `_Claude/${ TARGET }`, linked( 'alpha', '../../kcd.css' ) );

		vaultOf().move( TARGET, MOVED );

		expect( hrefIn( `_Claude/${ MOVED }` ) ).toBe( '../../kcd.css' );
	} );

	/** A legacy vault keeps the stylesheet under `kcd/`. The target is read back off the document, so
	 *  this is correct for free rather than needing `Vault` to learn where `kcd.css` lives. */
	it( 'preserves a stylesheet that does not sit at the vault root', () => {
		put( `_Claude/${ TARGET }`, linked( 'alpha', '../../kcd/kcd.css' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( hrefIn( '_Claude/plans/alpha.html' ) ).toBe( '../kcd/kcd.css' );
	} );

	/** Self-healing, and it is the point rather than a side effect: the stale href names the right
	 *  target, so re-expressing it fixes the link instead of carrying the error to the new path. */
	it( 'corrects an href that was ALREADY wrong for its old location', () => {
		put( `_Claude/${ TARGET }`, linked( 'alpha', '../../../../kcd.css' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( hrefIn( '_Claude/plans/alpha.html' ) ).toBe( '../kcd.css' );
	} );

	/** A machine-bound absolute href is a separate repair with its own ruling, so a mover leaves it alone. */
	it( 'declines to rewrite a machine-bound absolute href', () => {
		put( `_Claude/${ TARGET }`, linked( 'alpha', 'file:///C:/vault/kcd.css' ) );

		vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( hrefIn( '_Claude/plans/alpha.html' ) ).toBe( 'file:///C:/vault/kcd.css' );
	} );

	/** Best-effort by construction: healing the graph is the operation's contract, and a cosmetic link
	 *  must never cost a caller a completed move. */
	it( 'completes the move and its link healing when there is no stylesheet at all', () => {
		put( `_Claude/${ TARGET }`, doc( 'alpha', '<p>The target.</p>' ) );
		put( '_Claude/logs/driver/todo/todo.md', `- [ ] see [alpha](${ TARGET_REF }) about this\n` );

		const plan = vaultOf().move( TARGET, 'plans/alpha.html' );

		expect( plan.edits.length ).toBe( 1 );
		expect( readAt( '_Claude/logs/driver/todo/todo.md' ) ).toContain( '_Claude/plans/alpha.html' );
		expect( hrefIn( '_Claude/plans/alpha.html' ) ).toBeNull();
	} );
} );
