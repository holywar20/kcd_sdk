/**
 * backfill-slot-kind — census + (opt-in) stamp of an explicit `data-kcd-slot="<kind>"` onto every
 * slot in the KCD corpus, freezing slot identity into an explicit attribute the parser can trust.
 *
 * Authored: 2026-07-18 · Species: build (one-shot migration) · Revised 2026-07-19 (section-role law)
 * DEV-ONLY — does not ship. The package build strips scripts/ and tests; shipped src/** must never
 * import from here. An undated script predates this convention → treat as cullable.
 *
 * THE LAW ( ruled by Bryan 2026-07-19 ): a slot's kind is a pure function of the BLOCK it lives in —
 * "types are by position, not actual type." A habit-artifact linked from a references block is a
 * `reference`, not an accessible habit; it is only a habit if it sits in a habits block. So:
 *   · role blocks ( references · domains · domain · habits · contracts · tools · rules ) → their role
 *     ( domains fold into reference ). These are the ONLY dredge kinds.
 *   · any other block: a row carrying a link → `link` ( decoratable later ); a pure data row → `table-data`
 *     ( extracted + dumped when its region rides ). Neither is dredged.
 * `classifyRelPath(where)` is GONE from the slot path — the href never decides kind anymore.
 *
 * Edits are byte-span surgery on each slot element's opening tag ( via HtmlTree's recorded source
 * offsets ) — NEVER a re-serialize — so every other byte is untouched and a `data-kcd-slot` string in
 * prose / <code> can never be hit. Re-runnable: a slot already stamped with the correct kind is left
 * alone; a wrong/stale value is overwritten ( so this corrects the first, href-based pass in place ).
 *
 * Run ( DRY RUN — reports what it WOULD do, writes nothing but the audit ):
 *     cd kcd_sdk && npx tsx scripts/backfill-slot-kind.ts
 * Run ( APPLY — snapshots current state to a backup dir, then edits in place ):
 *     cd kcd_sdk && npx tsx scripts/backfill-slot-kind.ts --write
 * Flags: --write | --include-locked | --root <dir> | --json <file>
 */

import * as path from 'path';
import * as fs   from 'fs';
import { HtmlTree }   from '../src/core/html/HtmlTree';
import type { HtmlEl } from '../src/core/html/HtmlTree';
import { KcdAddress } from '../src/core/html/KcdAddress';

// ── The classification law ( the whole point — tune THIS if the role set changes ) ──────────────

/** Section name → the DREDGE ROLE the compiler acts on. Kind is a pure function of the block ( ruling:
 *  "types are by position, not actual type" ). Domains fold into reference — a domain is conceptual,
 *  its rows are reference links. These are the ONLY sections that produce a dredge kind. */
const ROLE: Record<string, string> = {
	references: 'reference',
	domains:    'reference',
	domain:     'reference',
	habits:     'habit',
	contracts:  'contract',
	tools:      'tool',
	rules:      'rule'
};

/** Roles that point at a routable target — a missing/empty `where` there is a broken link worth flagging
 *  ( tool / rule carry no href, so they are excluded ). */
const ROUTABLE = new Set( [ 'reference', 'habit', 'contract' ] );

interface SlotFacts {
	el:        HtmlEl;
	region:    string | undefined;
	section:   string | undefined;
	fieldKeys: string[];
	fields:    Record<string, string>;   // key → value ( where = href )
	mode:      string;
	existing:  string;                   // current data-kcd-slot VALUE ( '' when bare )
}

interface Classification { kind: string; source: string; brokenLink: boolean; }

function classify( s: SlotFacts ): Classification {
	const where = s.fields[ 'where' ] ?? '';
	const role  = s.section ? ROLE[ s.section ] : undefined;
	if ( role ) return { kind: role, source: 'section-role', brokenLink: ROUTABLE.has( role ) && where === '' };
	// Non-role block: a linked row is a `link`; a pure data row is `table-data`. Neither is dredged.
	if ( where !== '' ) return { kind: 'link',       source: 'nonrole+link', brokenLink: false };
	return             { kind: 'table-data', source: 'nonrole+data', brokenLink: false };
}

// ── Corpus walk ─────────────────────────────────────────────────────────────────────────────────

function htmlFilesUnder( root: string, includeLocked: boolean ): string[] {
	const out: string[] = [];
	const walk = ( dir: string ): void => {
		for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			const full = path.join( dir, entry.name );
			if ( entry.isDirectory() ) {
				if ( entry.name === 'node_modules' || entry.name === '.git' ) continue;
				if ( entry.name.startsWith( 'slot-kind-backup-' ) ) continue;   // never walk our own snapshots
				// _Claude/kcd is the LOCKED canonical substrate — never touched unless explicitly asked.
				if ( !includeLocked && full.replace( /\\/g, '/' ).includes( '/_Claude/kcd/' ) ) continue;
				walk( full );
			} else if ( entry.isFile() && entry.name.endsWith( '.html' ) ) {
				out.push( full );
			}
		}
	};
	walk( root );
	return out;
}

/** Every slot in a parsed tree WITH its section context + offsets, in document order. Mirrors
 *  KcdParse.scan's region/section threading so the section a slot is tagged with matches production. */
function gatherSlots( root: HtmlEl ): SlotFacts[] {
	const out: SlotFacts[] = [];
	const visit = ( el: HtmlEl, region: string | undefined, section: string | undefined ): void => {
		for ( const kid of el.kids ) {
			if ( !HtmlTree.isEl( kid ) ) continue;
			const reg  = KcdAddress.isRegion( kid )  ? ( HtmlTree.get( kid, 'data-kcd-region' )  || region )  : region;
			const sect = KcdAddress.isSection( kid ) ? ( HtmlTree.get( kid, 'data-kcd-section' ) || section ) : section;
			if ( KcdAddress.isSlot( kid ) ) out.push( readSlot( kid, reg, sect ) );
			visit( kid, reg, sect );
		}
	};
	visit( root, undefined, undefined );
	return out;
}

function readSlot( el: HtmlEl, region: string | undefined, section: string | undefined ): SlotFacts {
	const fields:    Record<string, string> = {};
	const fieldKeys: string[] = [];
	for ( const f of HtmlTree.collect( el, d => KcdAddress.isField( d ) ) ) {
		const { key, value } = KcdAddress.readField( f );
		if ( !key ) continue;
		fields[ key ] = value;
		if ( !fieldKeys.includes( key ) ) fieldKeys.push( key );
	}
	const rawMode = HtmlTree.get( el, 'data-kcd-mode' );
	return {
		el, region, section, fields, fieldKeys,
		mode:     ( rawMode === 'off' || rawMode === 'suggested' ) ? rawMode : 'on',
		existing: HtmlTree.get( el, 'data-kcd-slot' ) ?? ''
	};
}

// ── Byte-span edit ( the only thing that ever mutates a file ) ──────────────────────────────────
// Rewrite the slot's `data-kcd-slot` attribute ( bare OR already valued ) to `="<kind>"`, editing ONLY
// within the slot element's own opening-tag span. Nothing outside that span is read or written.

const SLOT_ATTR = /(\s)data-kcd-slot(?:="[^"]*")?(?=[\s/>])/;

interface Edit { start: number; from: string; to: string; }

function planEdit( html: string, s: SlotFacts, kind: string ): Edit | null {
	if ( s.el.start === undefined ) return null;
	const openEnd = HtmlTree.tagEnd( html, s.el.start );      // index of the opening tag's '>'
	const tag     = html.slice( s.el.start, openEnd + 1 );
	if ( !SLOT_ATTR.test( tag ) ) return null;
	const newTag = tag.replace( SLOT_ATTR, `$1data-kcd-slot="${ kind }"` );
	if ( newTag === tag ) return null;                        // already correct — no-op
	return { start: s.el.start, from: tag, to: newTag };
}

function applyEdits( html: string, edits: Edit[] ): string {
	for ( const e of [ ...edits ].sort( ( a, b ) => b.start - a.start ) ) {   // back-to-front keeps offsets valid
		html = html.slice( 0, e.start ) + e.to + html.slice( e.start + e.from.length );
	}
	return html;
}

// ── Driver ──────────────────────────────────────────────────────────────────────────────────────

function stamp( ts: number ): string {
	const d = new Date( ts ), p = ( n: number ) => String( n ).padStart( 2, '0' );
	return `${ d.getFullYear() }${ p( d.getMonth() + 1 ) }${ p( d.getDate() ) }-${ p( d.getHours() ) }${ p( d.getMinutes() ) }${ p( d.getSeconds() ) }`;
}

function main(): void {
	const argv          = process.argv.slice( 2 );
	const write         = argv.includes( '--write' );
	const includeLocked = argv.includes( '--include-locked' );
	const repoRoot      = path.resolve( __dirname, '../..' );
	const rootArg       = argv[ argv.indexOf( '--root' ) + 1 ];
	const corpusRoot    = argv.includes( '--root' ) && rootArg ? path.resolve( rootArg ) : path.join( repoRoot, '_Claude' );
	const jsonArg       = argv[ argv.indexOf( '--json' ) + 1 ];
	const reportPath    = argv.includes( '--json' ) && jsonArg ? path.resolve( jsonArg ) : path.join( repoRoot, '_Claude/audits/slot-kind-backfill.json' );

	const files       = htmlFilesUnder( corpusRoot, includeLocked );
	const backupDir   = path.join( repoRoot, '_Claude/audits', `slot-kind-backup-${ stamp( Date.now() ) }` );

	const kindCount:   Record<string, number> = {};
	const sectionKind: Record<string, Record<string, number>> = {};
	const flips:       { file: string; section: string; from: string; to: string; what: string }[] = [];
	const brokenLinks: { file: string; section: string; what: string; why: string }[] = [];
	const perFile:     { file: string; edits: { at: number; was: string; to: string; kind: string; section: string }[] }[] = [];

	let totalSlots = 0, wouldEdit = 0, unchanged = 0, filesTouched = 0;

	for ( const file of files ) {
		let html: string;
		try { html = fs.readFileSync( file, 'utf-8' ); } catch { continue; }
		const slots = gatherSlots( HtmlTree.parse( html ) );
		if ( !slots.length ) continue;

		const rel   = path.relative( repoRoot, file ).replace( /\\/g, '/' );
		const edits: Edit[] = [];
		const fileEdits: { at: number; was: string; to: string; kind: string; section: string }[] = [];

		for ( const s of slots ) {
			totalSlots++;
			const c    = classify( s );
			const sect = s.section ?? '(none)';
			kindCount[ c.kind ] = ( kindCount[ c.kind ] ?? 0 ) + 1;
			( sectionKind[ sect ] ??= {} )[ c.kind ] = ( sectionKind[ sect ][ c.kind ] ?? 0 ) + 1;
			if ( c.brokenLink ) brokenLinks.push( { file: rel, section: sect, what: s.fields[ 'what' ] ?? '', why: s.fields[ 'why' ] ?? '' } );

			if ( s.existing === c.kind ) { unchanged++; continue; }          // idempotent — already correct
			const edit = planEdit( html, s, c.kind );
			if ( !edit ) continue;
			edits.push( edit );
			fileEdits.push( { at: edit.start, was: s.existing || '(bare)', to: edit.to, kind: c.kind, section: sect } );
			if ( s.existing ) flips.push( { file: rel, section: sect, from: s.existing, to: c.kind, what: s.fields[ 'what' ] ?? '' } );
			wouldEdit++;
		}

		if ( !fileEdits.length ) continue;
		filesTouched++;
		perFile.push( { file: rel, edits: fileEdits } );

		if ( write ) {
			const dest = path.join( backupDir, rel );
			fs.mkdirSync( path.dirname( dest ), { recursive: true } );
			fs.writeFileSync( dest, html, 'utf-8' );                         // snapshot current state ( no git safety net )
			fs.writeFileSync( file, applyEdits( html, edits ), 'utf-8' );
		}
	}

	// ── Report ────────────────────────────────────────────────────────────────────────────────
	const report = { mode: write ? 'WRITE' : 'DRY-RUN', corpusRoot: path.relative( repoRoot, corpusRoot ), includeLocked, filesScanned: files.length, filesTouched, totalSlots, wouldEdit, unchanged, kindCount, sectionKind, flips, brokenLinks, perFile };
	fs.mkdirSync( path.dirname( reportPath ), { recursive: true } );
	fs.writeFileSync( reportPath, JSON.stringify( report, null, '\t' ), 'utf-8' );

	const bar = '─'.repeat( 62 );
	console.log( `\n${ write ? '⚠  WRITE MODE — files edited in place' : '✓  DRY RUN — nothing written but the audit' }` );
	console.log( bar );
	console.log( `Corpus      ${ report.corpusRoot }${ includeLocked ? ' ( incl. locked kcd/ )' : '' }` );
	console.log( `Files       ${ files.length } scanned · ${ filesTouched } with pending changes` );
	console.log( `Slots       ${ totalSlots } total · ${ wouldEdit } to (re)stamp · ${ unchanged } already correct` );
	console.log( bar );
	console.log( `Kind distribution ( final, section-role law ):` );
	for ( const [ k, n ] of Object.entries( kindCount ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ) ) console.log( `   ${ String( n ).padStart( 4 ) }  ${ k }` );
	console.log( bar );
	console.log( `Flips ( existing stamp → corrected ) — ${ flips.length } total:` );
	const flipPairs: Record<string, number> = {};
	for ( const f of flips ) flipPairs[ `${ f.from } → ${ f.to }` ] = ( flipPairs[ `${ f.from } → ${ f.to }` ] ?? 0 ) + 1;
	for ( const [ pair, n ] of Object.entries( flipPairs ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ) ) console.log( `   ${ String( n ).padStart( 4 ) }  ${ pair }` );
	console.log( bar );
	console.log( `Broken links ( routable role slot, no href ) — ${ brokenLinks.length }:` );
	for ( const b of brokenLinks ) console.log( `   ${ b.file }  ·  "${ b.what }" — ${ b.why }` );
	console.log( `\nFull report → ${ path.relative( repoRoot, reportPath ).replace( /\\/g, '/' ) }` );
	if ( !write && wouldEdit ) console.log( `Re-run with --write to apply ( current state snapshotted to _Claude/audits/slot-kind-backup-<ts>/ first ).` );
	console.log();
}

main();
