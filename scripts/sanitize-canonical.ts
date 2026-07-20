/**
 * sanitize-canonical — re-sync the KCD canonical library (`_Claude/kcd/`) from the current deployed
 * standard while keeping it GENERIC: no link ever reaches out of canonical into a specific deployment.
 *
 * Authored: 2026-07-19 · Species: build (canonical-sync) · Revised 2026-07-19 (apply→preview + validate)
 * DEV-ONLY — does not ship. An undated script predates this convention → treat as cullable.
 *
 * MODEL ( ruled by Bryan 2026-07-19 ): canonical = generic + about USING a capability; docs/links about
 * EDITING Starmind ( `starmind/` source, its subsystems, dev plans ) are not canonical. Link rule:
 * canonical must never link OUT to noncanonical; a stripped link inside a slot removes the row.
 *
 * SAFETY: the risky transform ( strip rows, rewrite links, stamp, css-fix, re-sync from the deployed twin )
 * is written to a PREVIEW TREE ( `_Claude/audits/canonical-preview/` ), NEVER in place, and every output is
 * re-validated as conforming KCD before it is kept. Review/diff the preview, then `--apply` copies it into
 * `_Claude/kcd/`. No git net here, so nothing touches the real tree until you say so.
 *
 * Hand-handled OUT of this tool ( flagged, never auto-touched ): the 3 deployed-pointing nav-indexes
 * ( references/ · lenses/ · root — rebuilt to index canonical ), `_lens_base`'s Starmind tools section
 * ( DP-2 ), and prose ( inline ) strips. Templates are stamped/css-fixed but NEVER link-stripped ( their
 * links are illustrative placeholders ).
 *
 * Run ( PREVIEW — writes only the preview tree + audit ):  cd kcd_sdk && npx tsx scripts/sanitize-canonical.ts
 * Run ( APPLY   — copies validated preview into _Claude/kcd/, backup first ):  … --apply
 */

import * as path from 'path';
import * as fs   from 'fs';
import { HtmlTree }    from '../src/core/html/HtmlTree';
import type { HtmlEl } from '../src/core/html/HtmlTree';
import { KcdAddress }  from '../src/core/html/KcdAddress';
import { KcdValidate } from '../src/core/html/KcdValidate';

const repoRoot    = path.resolve( __dirname, '../..' );
const KCD_REL     = '_Claude/kcd';
const PREVIEW_REL = '_Claude/audits/canonical-preview';

const ROLE: Record<string, string> = { references: 'reference', domains: 'reference', domain: 'reference', habits: 'habit', contracts: 'contract', tools: 'tool', rules: 'rule' };
const slotKind = ( section: string | undefined, where: string ): string => ( section && ROLE[ section ] ) || ( where ? 'link' : 'table-data' );

const PROMOTE: Record<string, string> = {
	'_Claude/plans/starmind_insight/examples/sample.sig':     '_Claude/kcd/references/insight/examples/sample.sig',
	'_Claude/work/lens_crafter/html-proposal/lens.html':      '_Claude/kcd/templates/exemplars/lens.html',
	'_Claude/work/lens_crafter/html-proposal/plan.html':      '_Claude/kcd/templates/exemplars/plan.html',
	'_Claude/work/lens_crafter/html-proposal/contract.html':  '_Claude/kcd/templates/exemplars/contract.html',
	'_Claude/work/lens_crafter/html-proposal/reference.html': '_Claude/kcd/templates/exemplars/reference.html'
};

/** Rebuilt by hand ( index deployed content → must become canonical-only ) — this tool skips them. */
const EXCLUDE = new Set( [ 'nav-index.html', 'lenses/nav-index.html', 'references/nav-index.html' ] );

type Action = 'keep' | 'rewrite' | 'promote' | 'strip';
interface Verdict { action: Action; target?: string; reason: string; }

const canonExists = ( p: string ): boolean => fs.existsSync( path.join( repoRoot, p ) );

function verdict( H: string ): Verdict {
	if ( PROMOTE[ H ] )                                            return { action: 'promote', target: PROMOTE[ H ], reason: 'user-facing → canonical' };
	if ( H === '' || H.startsWith( '#' ) )                        return { action: 'keep', reason: 'anchor' };
	if ( H.startsWith( 'http://' ) || H.startsWith( 'https://' ) ) return { action: 'keep', reason: 'external' };
	if ( H.startsWith( '_Claude/kcd/' ) )                         return { action: 'keep', reason: 'already canonical' };
	if ( H.startsWith( 'starmind/' ) )                            return { action: 'strip', reason: 'edit-Starmind source' };
	if ( /^_Claude\/(plans|work|audits|dev-utilities)\//.test( H ) ) return { action: 'strip', reason: 'project-specific' };
	if ( H.startsWith( '_Claude/reports/' ) || H.startsWith( '_Claude/logs/' ) ) return { action: 'keep', reason: 'generic runtime path' };
	if ( H.startsWith( '_Claude/' ) ) {
		const twin = H.replace( '_Claude/', '_Claude/kcd/' );
		if ( canonExists( twin ) )                                return { action: 'rewrite', target: twin, reason: 'canonical twin exists' };
		return { action: 'strip', reason: 'deployed-only — no canonical twin' };
	}
	return { action: 'keep', reason: 'relative/other' };
}

// ── Transform ( offset edits on the source, output re-validated ) ───────────────────────────────
interface Edit { start: number; end: number; text: string; }
const tagEnd = ( html: string, start: number ): number => HtmlTree.tagEnd( html, start ) + 1;

/** An attr-value replacement edit within an element's opening tag, or null if the attr isn't there. */
function attrEdit( html: string, el: HtmlEl, re: RegExp, text: string ): Edit | null {
	if ( el.start === undefined ) return null;
	const s = el.start, e = tagEnd( html, s ), tag = html.slice( s, e ), m = re.exec( tag );
	if ( !m ) return null;
	return { start: s + m.index, end: s + m.index + m[ 0 ].length, text };
}

/** Remove an element's whole span plus its line's leading indent + one trailing newline ( clean row delete ). */
function removeSpan( html: string, el: HtmlEl ): Edit | null {
	if ( el.start === undefined || el.end === undefined ) return null;
	let s = el.start; while ( s > 0 && ( html[ s - 1 ] === '\t' || html[ s - 1 ] === ' ' ) ) s--;
	let e = el.end; if ( html[ e ] === '\r' ) e++; if ( html[ e ] === '\n' ) e++;
	return { start: s, end: e, text: '' };
}

interface Result { rel: string; source: string; content: string | null; valid: boolean; err: string; rewrites: number; rows: number; stamps: number; css: boolean; proseStrips: any[]; emptied: string[]; skipped?: string; }

function sanitize( rel: string ): Result {
	const abs = path.join( repoRoot, KCD_REL, rel );
	const twinAbs = path.join( repoRoot, '_Claude', rel );
	const hasTwin = fs.existsSync( twinAbs );
	const srcAbs = hasTwin ? twinAbs : abs;
	const isTemplate = rel.startsWith( 'templates/' );
	const base: Result = { rel, source: hasTwin ? 'deployed-twin' : 'self', content: null, valid: false, err: '', rewrites: 0, rows: 0, stamps: 0, css: false, proseStrips: [], emptied: [] };

	let html: string; try { html = fs.readFileSync( srcAbs, 'utf-8' ); } catch { return { ...base, err: 'read failed' }; }
	const root = HtmlTree.parse( html );
	const edits: Edit[] = [];
	const removed: [ number, number ][] = [];
	const inRemoved = ( p: number ): boolean => removed.some( ( [ a, b ] ) => p >= a && p < b );

	// css relative-path fix ( canonical depth )
	const depth = rel.split( '/' ).length - 1;
	const wantCss = ( depth ? '../'.repeat( depth ) : '' ) + 'kcd.css';
	const link = HtmlTree.first( root, el => el.tag === 'link' && ( HtmlTree.get( el, 'href' ) ?? '' ).endsWith( 'kcd.css' ) );
	if ( link && HtmlTree.get( link, 'href' ) !== wantCss ) { const e = attrEdit( html, link, /href="[^"]*"/, `href="${ wantCss }"` ); if ( e ) { edits.push( e ); base.css = true; } }

	// walk: decide row removals first ( a slot whose where-link strips → remove the row )
	const emptying: Record<string, { t: number; r: number }> = {};
	const visit1 = ( el: HtmlEl, section: string | undefined ): void => {
		for ( const kid of el.kids ) {
			if ( !HtmlTree.isEl( kid ) ) continue;
			const sect = KcdAddress.isSection( kid ) ? ( HtmlTree.get( kid, 'data-kcd-section' ) || section ) : section;
			if ( KcdAddress.isSlot( kid ) ) {
				const k = sect ?? '(none)'; ( emptying[ k ] ??= { t: 0, r: 0 } ).t++;
				let where = '';
				for ( const f of HtmlTree.collect( kid, d => KcdAddress.isField( d ) ) ) { const rf = KcdAddress.readField( f ); if ( rf.key === 'where' ) where = rf.value; }
				if ( !isTemplate && where && verdict( where ).action === 'strip' ) {
					const rm = removeSpan( html, kid ); if ( rm ) { edits.push( rm ); removed.push( [ rm.start, rm.end ] ); base.rows++; emptying[ k ].r++; }
				}
			}
			visit1( kid, sect );
		}
	};
	visit1( root, undefined );

	// second pass: link rewrites/promotes ( skip inside removed rows; prose strips are flagged, not auto-removed )
	const visit2 = ( el: HtmlEl, section: string | undefined, inSlot: boolean ): void => {
		for ( const kid of el.kids ) {
			if ( !HtmlTree.isEl( kid ) ) continue;
			const sect = KcdAddress.isSection( kid ) ? ( HtmlTree.get( kid, 'data-kcd-section' ) || section ) : section;
			const slot = inSlot || KcdAddress.isSlot( kid );
			if ( kid.tag === 'a' && HtmlTree.has( kid, 'href' ) && kid.start !== undefined && !inRemoved( kid.start ) ) {
				const H = HtmlTree.get( kid, 'href' )!, v = verdict( H );
				if ( v.action === 'rewrite' || v.action === 'promote' ) { const e = attrEdit( html, kid, /href="[^"]*"/, `href="${ v.target }"` ); if ( e ) { edits.push( e ); base.rewrites++; } }
				else if ( v.action === 'strip' && !isTemplate && !slot ) base.proseStrips.push( { href: H, text: HtmlTree.textOf( kid ).trim().slice( 0, 40 ) } );
			}
			// slot kind stamp ( skip removed rows )
			if ( KcdAddress.isSlot( kid ) && kid.start !== undefined && !inRemoved( kid.start ) ) {
				let where = ''; for ( const f of HtmlTree.collect( kid, d => KcdAddress.isField( d ) ) ) { const rf = KcdAddress.readField( f ); if ( rf.key === 'where' ) where = rf.value; }
				const want = slotKind( sect, where );
				if ( ( HtmlTree.get( kid, 'data-kcd-slot' ) ?? '' ) !== want ) { const e = attrEdit( html, kid, /data-kcd-slot(?:="[^"]*")?/, `data-kcd-slot="${ want }"` ); if ( e ) { edits.push( e ); base.stamps++; } }
			}
			visit2( kid, sect, slot );
		}
	};
	visit2( root, undefined, false );

	base.emptied = Object.entries( emptying ).filter( ( [ , v ] ) => v.t > 0 && v.r >= v.t ).map( ( [ k ] ) => k );

	// apply back-to-front
	let out = html;
	for ( const e of edits.sort( ( a, b ) => b.start - a.start ) ) out = out.slice( 0, e.start ) + e.text + out.slice( e.end );

	const report = KcdValidate.validate( out );
	return { ...base, content: out, valid: report.ok, err: report.ok ? '' : `${ report.errors[ 0 ]?.code } — ${ report.errors[ 0 ]?.msg }` };
}

function canonicalFiles(): string[] {
	const out: string[] = [];
	const walk = ( dir: string ): void => { for ( const e of fs.readdirSync( dir, { withFileTypes: true } ) ) { const f = path.join( dir, e.name ); if ( e.isDirectory() ) { if ( e.name.startsWith( 'slot-kind-backup-' ) || e.name === 'node_modules' ) continue; walk( f ); } else if ( e.isFile() && e.name.endsWith( '.html' ) ) out.push( f ); } };
	walk( path.join( repoRoot, KCD_REL ) );
	return out;
}

function main(): void {
	const apply = process.argv.includes( '--apply' );
	const previewRoot = path.join( repoRoot, PREVIEW_REL );
	const results: Result[] = [];
	for ( const abs of canonicalFiles() ) {
		const rel = path.relative( path.join( repoRoot, KCD_REL ), abs ).replace( /\\/g, '/' );
		if ( EXCLUDE.has( rel ) ) { results.push( { rel, source: 'EXCLUDED', content: null, valid: true, err: '', rewrites: 0, rows: 0, stamps: 0, css: false, proseStrips: [], emptied: [], skipped: 'hand-rebuild nav-index' } ); continue; }
		const r = sanitize( rel );
		results.push( r );
		if ( r.content && r.valid ) { const dest = path.join( previewRoot, rel ); fs.mkdirSync( path.dirname( dest ), { recursive: true } ); fs.writeFileSync( dest, r.content, 'utf-8' ); }
	}

	const changed = results.filter( r => !r.skipped && ( r.rewrites || r.rows || r.stamps || r.css ) );
	const invalid = results.filter( r => r.content && !r.valid );
	const proseFiles = results.filter( r => r.proseStrips.length );
	const emptiedFiles = results.filter( r => r.emptied.length );

	// promotes: copy the 5 source artifacts into canonical ( on --apply )
	const promoteCopies = Object.entries( PROMOTE ).filter( ( [ src ] ) => fs.existsSync( path.join( repoRoot, src ) ) );

	fs.writeFileSync( path.join( repoRoot, '_Claude/audits/sanitize-canonical-proposal.json' ), JSON.stringify( { apply, results, promoteCopies }, null, '\t' ), 'utf-8' );

	const bar = '─'.repeat( 64 );
	console.log( `\n${ apply ? '⚠  APPLY — copying validated preview into _Claude/kcd/' : '✓  PREVIEW — sanitized files written to the preview tree, validated' }` );
	console.log( bar );
	console.log( `Files            ${ results.length }  ·  changed ${ changed.length }  ·  excluded ${ results.filter( r => r.skipped ).length }` );
	console.log( `Edits            rewrite ${ changed.reduce( ( s, r ) => s + r.rewrites, 0 ) }  ·  strip-row ${ changed.reduce( ( s, r ) => s + r.rows, 0 ) }  ·  stamp ${ changed.reduce( ( s, r ) => s + r.stamps, 0 ) }  ·  css ${ changed.filter( r => r.css ).length }` );
	console.log( `Validation       ${ results.filter( r => r.content && r.valid ).length } OK  ·  ${ invalid.length } FAILED` );
	console.log( bar );
	if ( invalid.length ) { console.log( `!!! VALIDATION FAILURES ( NOT written to preview — need a look ):` ); for ( const r of invalid ) console.log( `   ${ r.rel }  —  ${ r.err }` ); console.log( bar ); }
	console.log( `EXCLUDED ( hand-rebuild ): ${ results.filter( r => r.skipped ).map( r => r.rel ).join( ', ' ) }` );
	console.log( `SECTIONS EMPTIED BY STRIPS ( review — may want removal or rebuild ):` );
	for ( const r of emptiedFiles ) console.log( `   ${ r.rel }  →  ${ r.emptied.join( ', ' ) }` );
	console.log( `PROSE STRIPS ( inline, left in place — hand-edit ):` );
	for ( const r of proseFiles ) for ( const p of r.proseStrips ) console.log( `   ${ r.rel }  ·  "${ p.text }" → ${ p.href }` );
	console.log( `PROMOTES ( ${ promoteCopies.length } files to copy into canonical ):` );
	for ( const [ s, d ] of promoteCopies ) console.log( `   ${ s } → ${ d.replace( '_Claude/kcd/', 'kcd/' ) }` );
	console.log( bar );

	if ( apply ) {
		const backup = path.join( repoRoot, '_Claude/audits', `canonical-backup-${ Date.now() }` );
		let wrote = 0;
		for ( const r of results ) {
			if ( r.skipped || !r.content || !r.valid ) continue;
			const dest = path.join( repoRoot, KCD_REL, r.rel ), bak = path.join( backup, r.rel );
			fs.mkdirSync( path.dirname( bak ), { recursive: true } ); if ( fs.existsSync( dest ) ) fs.copyFileSync( dest, bak );
			fs.writeFileSync( dest, r.content, 'utf-8' ); wrote++;
		}
		for ( const [ s, d ] of promoteCopies ) { const dst = path.join( repoRoot, d ); fs.mkdirSync( path.dirname( dst ), { recursive: true } ); fs.copyFileSync( path.join( repoRoot, s ), dst ); }
		console.log( `Applied ${ wrote } files ( originals → ${ path.relative( repoRoot, backup ).replace( /\\/g, '/' ) } ); promoted ${ promoteCopies.length }.` );
	} else {
		console.log( `Preview tree → ${ PREVIEW_REL }/   ·   diff it against _Claude/kcd/, then re-run with --apply` );
	}
	console.log();
}

main();
