import * as path from 'path'
import * as fs   from 'fs'
import { KcdValidate } from '../src/core/html'

const repoRoot  = path.resolve( __dirname, '../..' )
const claudeDir = path.join( repoRoot, '_Claude' )

const SKIP_DIR_NAMES = new Set( [ 'node_modules', '.git', '.obsidian' ] )

function walk( dir: string, out: string[] ): void {
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
		if ( SKIP_DIR_NAMES.has( entry.name ) ) continue
		const full = path.join( dir, entry.name )
		if ( entry.isDirectory() ) walk( full, out )
		else if ( entry.isFile() && entry.name.toLowerCase().endsWith( '.html' ) ) out.push( full )
	}
}

const files: string[] = []
walk( claudeDir, files )

interface Row { file: string; ok: boolean; type: string | null; name: string | null; errorCodes: string[]; errors: { where: string; msg: string }[] }
const rows: Row[] = []

// A KCD document announces itself with at least one `data-kcd*` marker. Files with none are
// not documents at all ( interactive mockups, prototypes, hand-authored HTML apps ) — they are
// not the validator's concern. A truncated document that lost its <article> still carries
// data-kcd-* remnants, so this skip does not mask a real botched migration.
const NON_DOCUMENT = ( html: string ) => !/data-kcd/.test( html )

for ( const f of files ) {
	const html = fs.readFileSync( f, 'utf-8' )
	if ( NON_DOCUMENT( html ) ) continue
	let report
	try {
		report = KcdValidate.validate( html )
	} catch ( e: any ) {
		rows.push( { file: f, ok: false, type: null, name: null, errorCodes: [ 'exception' ], errors: [ { where: 'validate()', msg: String( e?.message ?? e ) } ] } )
		continue
	}
	rows.push( {
		file: path.relative( repoRoot, f ).replace( /\\/g, '/' ),
		ok: report.ok,
		type: report.type,
		name: report.name,
		errorCodes: report.errors.map( e => e.code ),
		errors: report.errors.map( e => ( { where: e.where, msg: e.msg } ) ),
	} )
}

const valid   = rows.filter( r => r.ok )
const invalid = rows.filter( r => !r.ok )

const outPath = path.join( claudeDir, 'audits', 'kcd-validate-report.json' )
fs.mkdirSync( path.dirname( outPath ), { recursive: true } )
fs.writeFileSync( outPath, JSON.stringify( { scannedAt: 'manual-run', total: rows.length, valid: valid.length, invalid: invalid.length, rows }, null, '\t' ), 'utf-8' )

console.log( `Scanned ${ rows.length } .html files under _Claude/` )
console.log( `  valid:   ${ valid.length }` )
console.log( `  invalid: ${ invalid.length }` )
console.log( `Report written to ${ path.relative( repoRoot, outPath ) }` )
if ( invalid.length ) {
	console.log( '\nINVALID FILES:' )
	for ( const r of invalid ) console.log( `  ${ r.file }  [${ r.errorCodes.join( ', ' ) }]` )
}
