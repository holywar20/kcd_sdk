/**
 * shape-report — REPORT-ONLY corpus pass for KcdShapes. Won't ship; disposable.
 *
 * Written 2026-08-04 for phase 1 of the structure-synthesis work. It enforces NOTHING: it walks every
 * KCD document under _Claude/, reads the sections each one actually carries, and audits them against
 * the declared shape for their type. The point is to size the damage BEFORE any gate is switched on —
 * a required-section rule that lights up thirty documents is a migration, not a check, and we want to
 * know which of the two we have while it is still free to find out.
 *
 * Delete once the gate is live and the numbers are in the plan record.
 */

import * as path from 'path'
import * as fs   from 'fs'
import { HtmlTree, KcdAddress, KcdShapes } from '../src/core/html'
import type { HtmlEl } from '../src/core/html'

const repoRoot  = path.resolve( __dirname, '../..' )
const claudeDir = path.join( repoRoot, '_Claude' )

const SKIP_DIR_NAMES = new Set( [ 'node_modules', '.git', '.obsidian' ] )

// Ephemeral space is not library space. work/ logs/ reports/ audits/ scratch/ hold drafts and machine
// output that were never meant to conform, and grading them would drown the signal — the same gate
// `VaultUtilities.health` already applies to its own sweep.
const EPHEMERAL = new Set( [ 'work', 'logs', 'reports', 'audits', 'scratch', 'dev-utilities' ] )

function walk( dir: string, out: string[] ): void {
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
		if ( SKIP_DIR_NAMES.has( entry.name ) ) continue
		const full = path.join( dir, entry.name )
		if ( entry.isDirectory() ) {
			if ( dir === claudeDir && EPHEMERAL.has( entry.name ) ) continue
			walk( full, out )
		}
		else if ( entry.isFile() && entry.name.toLowerCase().endsWith( '.html' ) ) out.push( full )
	}
}

const files: string[] = []
walk( claudeDir, files )

interface Row {
	file:       string
	type:       string
	known:      boolean
	missing:    string[]
	thin:       string[]
	unexpected: string[]
}

const rows: Row[] = []
let skipped = 0

for ( const f of files ) {
	const html = fs.readFileSync( f, 'utf-8' )
	if ( !/data-kcd/.test( html ) ) { skipped++; continue }

	let root: HtmlEl
	try { root = HtmlTree.parse( html ) }
	catch { skipped++; continue }

	const article = HtmlTree.collect( root, el => KcdAddress.isArticle( el ) )[ 0 ]
	if ( !article ) { skipped++; continue }

	const type = HtmlTree.get( article, 'data-kcd' ) ?? ''
	// Templates are scaffolds — placeholders and embedded target-type structure are expected, and the
	// validator exempts them for exactly this reason. Auditing them would report the scaffold as drift.
	if ( type === 'template' ) { skipped++; continue }

	const present = HtmlTree.collect( article, el => KcdAddress.isSection( el ) )
		.map( el => HtmlTree.get( el, 'data-kcd-section' ) )
		.filter( ( v ): v is string => !!v )

	const audit = KcdShapes.audit( type, present )
	rows.push( {
		file: path.relative( repoRoot, f ).replace( /\\/g, '/' ),
		type,
		known:      audit.known,
		missing:    audit.missing,
		thin:       audit.thin,
		unexpected: audit.unexpected,
	} )
}

const governed  = rows.filter( r => r.known )
const ungoverned = rows.filter( r => !r.known )
const withMissing    = governed.filter( r => r.missing.length )
const withThin       = governed.filter( r => r.thin.length )
const withUnexpected = governed.filter( r => r.unexpected.length )

// Per-type roll-up: the number that decides whether a tier can be promoted to an error.
const byType: Record<string, { total: number; clean: number; missing: number }> = {}
for ( const r of governed ) {
	const b = byType[ r.type ] ??= { total: 0, clean: 0, missing: 0 }
	b.total++
	if ( r.missing.length ) b.missing++; else b.clean++
}

console.log( `Scanned ${ rows.length } library documents under _Claude/  ( ${ skipped } skipped: non-document, template, or unparseable )\n` )

console.log( 'PER TYPE — required-section conformance' )
for ( const [ type, b ] of Object.entries( byType ).sort( ( a, b ) => b[ 1 ].total - a[ 1 ].total ) )
	console.log( `  ${ type.padEnd( 14 ) } ${ String( b.clean ).padStart( 3 ) } / ${ String( b.total ).padStart( 3 ) } clean` + ( b.missing ? `   (${ b.missing } would FAIL a strict gate)` : '' ) )

if ( ungoverned.length ) {
	const types = [ ...new Set( ungoverned.map( r => r.type ) ) ].join( ', ' )
	console.log( `\nUNGOVERNED — ${ ungoverned.length } documents whose type has no shape entry: ${ types }` )
}

if ( withMissing.length ) {
	console.log( `\nWOULD FAIL A STRICT GATE — ${ withMissing.length } documents missing a REQUIRED section:` )
	for ( const r of withMissing ) console.log( `  ${ r.file }  [${ r.type }]  missing: ${ r.missing.join( ', ' ) }` )
}

if ( withThin.length ) {
	console.log( `\nWARN TIER — ${ withThin.length } documents missing an EXPECTED section:` )
	for ( const r of withThin ) console.log( `  ${ r.file }  [${ r.type }]  thin: ${ r.thin.join( ', ' ) }` )
}

if ( withUnexpected.length ) {
	console.log( `\nUNDECLARED SECTIONS — ${ withUnexpected.length } documents ( closed types only ):` )
	for ( const r of withUnexpected ) console.log( `  ${ r.file }  [${ r.type }]  unexpected: ${ r.unexpected.join( ', ' ) }` )
}

const outPath = path.join( claudeDir, 'audits', 'kcd-shape-report.json' )
fs.mkdirSync( path.dirname( outPath ), { recursive: true } )
fs.writeFileSync( outPath, JSON.stringify( { total: rows.length, skipped, byType, rows }, null, '\t' ), 'utf-8' )
console.log( `\nReport written to ${ path.relative( repoRoot, outPath ).replace( /\\/g, '/' ) }` )
