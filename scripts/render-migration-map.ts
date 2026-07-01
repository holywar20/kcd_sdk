import * as path from 'path'
import * as fs   from 'fs'

const repoRoot  = path.resolve( __dirname, '../..' )
const claudeDir = path.join( repoRoot, '_Claude' )

const mergedPath = path.join( claudeDir, 'audits', 'migration-status-merged.json' )
const merged = JSON.parse( fs.readFileSync( mergedPath, 'utf-8' ) )

interface Row {
	mdPath: string; htmlPath: string | null; htmlExists: boolean
	mdSize: number; htmlSize: number | null
	sizeStatus: 'missing' | 'anomaly' | 'ok'; sizeRatio: number | null
	protocolStatus: 'missing' | 'invalid' | 'valid' | 'not-checked'
	protocolErrorCodes: string[]; protocolNote: string | null
}

const rows: Row[] = merged.rows

function statusMarker( r: Row ): string {
	if ( !r.htmlExists ) return '⏳ PENDING'
	if ( r.sizeStatus === 'ok' && r.protocolStatus === 'valid' ) return '✅ CLEAN'
	const bad: string[] = []
	if ( r.sizeStatus === 'anomaly' ) bad.push( 'SIZE' )
	if ( r.protocolStatus === 'invalid' ) bad.push( 'PROTOCOL' )
	return `🔴 NEEDS FIX (${ bad.join( ' + ' ) })`
}

function notesFor( r: Row ): string {
	const parts: string[] = []
	if ( r.htmlExists && r.sizeStatus === 'anomaly' ) parts.push( `size ratio ${ r.sizeRatio }x (md ${ r.mdSize }b → html ${ r.htmlSize }b)` )
	if ( r.htmlExists && r.protocolStatus === 'invalid' ) parts.push( `protocol: ${ r.protocolErrorCodes.join( ', ' ) } — ${ r.protocolNote }` )
	if ( !r.htmlExists ) parts.push( `expected at ${ r.htmlPath }` )
	return parts.join( '<br>' ) || '—'
}

// group by top-level dir under _Claude/
function topGroup( mdPath: string ): string {
	const rel = mdPath.replace( /^_Claude\//, '' )
	const seg = rel.split( '/' )[ 0 ]
	return seg
}

const groups = new Map<string, Row[]>()
for ( const r of rows ) {
	const g = topGroup( r.mdPath )
	if ( !groups.has( g ) ) groups.set( g, [] )
	groups.get( g )!.push( r )
}

const groupOrder = [ 'kcd', 'lenses', 'habits', 'analyzers', 'contracts', 'generators', 'references', 'plans', 'work', 'utilities', 'nav-index.md' ]
const sortedGroupNames = [ ...groups.keys() ].sort( ( a, b ) => {
	const ai = groupOrder.indexOf( a ), bi = groupOrder.indexOf( b )
	if ( ai === -1 && bi === -1 ) return a.localeCompare( b )
	if ( ai === -1 ) return 1
	if ( bi === -1 ) return -1
	return ai - bi
} )

const s = merged.summary
let out = ''
out += '---\n'
out += 'name: migration-map\n'
out += 'description: File-by-file mapping of .md → .html migration status across _Claude/ — regenerated from live filesystem + validate-html-migration.ps1 (size) + kcd_sdk KcdValidate (protocol)\n'
out += 'type: reference\n'
out += 'status: active\n'
out += 'author: lens_crafter\n'
out += 'updated: 2026-07-01\n'
out += '---\n\n'
out += '# MD → HTML Migration Map\n\n'
out += 'Regenerated directly from the filesystem and two validators — not hand-maintained. Every row reflects\n'
out += 'ground truth as of the last run of `kcd_sdk/scripts/merge-migration-status.ts`, which combines:\n\n'
out += '- **Size validator** ([validate-html-migration.ps1](_Claude/work/validate-html-migration.ps1)) — flags a `.html` whose\n'
out += '  byte size falls outside a plausible range of its `.md` source (signal for dropped/summarized content).\n'
out += '- **Protocol validator** (`kcd_sdk`\'s `KcdValidate` — the real, binary, all-or-nothing enforcement of\n'
out += '  [kcd-document-protocol](_Claude/references/domain/kcd-document-protocol.md), not the deferred\n'
out += '  `_Claude/dev-utilities/kcd-validate.js` stub).\n\n'
out += 'This supersedes the previous hand/agent-maintained version of this file — no priority tiers, we are migrating\n'
out += 'everything. Regenerate by running, from `kcd_sdk/`:\n'
out += '`tsx scripts/validate-corpus.ts && tsx scripts/merge-migration-status.ts && tsx scripts/render-migration-map.ts`\n\n'
out += '> **Environment note:** if `kcd_sdk`\'s own `node_modules/.bin/tsx` fails with an esbuild module-resolution\n'
out += '> error, its local install is broken — invoke `starmind/node_modules/.bin/tsx` instead, still run from inside\n'
out += '> `kcd_sdk/` (relative imports resolve from the script\'s own path regardless of which `tsx` binary runs it).\n\n'
out += '---\n\n'
out += '## Legend\n\n'
out += '| Status | Meaning |\n|---|---|\n'
out += '| ✅ **CLEAN** | `.html` exists, size is plausible, and it validates against the protocol |\n'
out += '| 🔴 **NEEDS FIX** | `.html` exists but failed one or both validators — see Notes |\n'
out += '| ⏳ **PENDING** | no `.html` yet |\n\n'
out += '---\n\n'
out += '## Corpus summary\n\n'
out += '| Metric | Count |\n|---|---|\n'
out += `| Total .md files tracked | ${ s.total } |\n`
out += `| ⏳ Missing .html | ${ s.htmlMissing } |\n`
out += `| .html exists, size OK | ${ s.sizeOk } |\n`
out += `| .html exists, size ANOMALY | ${ s.sizeAnomaly } |\n`
out += `| Protocol-valid | ${ s.protocolValid } |\n`
out += `| Protocol-INVALID | ${ s.protocolInvalid } |\n`
out += `| **✅ Clean on BOTH validators** | **${ s.cleanBothValidators }** |\n\n`
out += '---\n\n'

for ( const g of sortedGroupNames ) {
	const grows = groups.get( g )!.sort( ( a, b ) => a.mdPath.localeCompare( b.mdPath ) )
	const gClean = grows.filter( r => r.htmlExists && r.sizeStatus === 'ok' && r.protocolStatus === 'valid' ).length
	out += `## \`${ g }/\` (${ grows.length } files, ${ gClean } clean)\n\n`
	out += '| MD File | Status | Notes |\n|---|---|---|\n'
	for ( const r of grows ) {
		const mdRel = r.mdPath.replace( /^_Claude\//, '' )
		out += `| \`${ mdRel }\` | ${ statusMarker( r ) } | ${ notesFor( r ) } |\n`
	}
	out += '\n---\n\n'
}

const outPath = path.join( claudeDir, 'work', 'lens_crafter', 'migration', 'migration-map.md' )
fs.writeFileSync( outPath, out, 'utf-8' )
console.log( `Regenerated ${ path.relative( repoRoot, outPath ) } — ${ rows.length } rows across ${ groups.size } groups.` )
