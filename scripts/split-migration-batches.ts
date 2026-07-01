import * as path from 'path'
import * as fs   from 'fs'

const repoRoot  = path.resolve( __dirname, '../..' )
const claudeDir = path.join( repoRoot, '_Claude' )
const migDir    = path.join( claudeDir, 'work', 'lens_crafter', 'migration' )

const merged = JSON.parse( fs.readFileSync( path.join( claudeDir, 'audits', 'migration-status-merged.json' ), 'utf-8' ) )

interface Row {
	mdPath: string; htmlPath: string | null; htmlExists: boolean
	mdSize: number; htmlSize: number | null
	sizeStatus: 'missing' | 'anomaly' | 'ok'; sizeRatio: number | null
	protocolStatus: 'missing' | 'invalid' | 'valid' | 'not-checked'
	protocolErrorCodes: string[]; protocolNote: string | null
}

const rows: Row[] = merged.rows
const needsWork = rows
	.filter( r => !( r.htmlExists && r.sizeStatus === 'ok' && r.protocolStatus === 'valid' ) )
	.sort( ( a, b ) => a.mdPath.localeCompare( b.mdPath ) )

const AGENTS = [ 'Winston', 'Marie', 'Ebon', 'Valarie' ]
const n = needsWork.length
const base = Math.floor( n / AGENTS.length )
const rem  = n % AGENTS.length   // first `rem` agents get one extra

const chunks: Row[][] = []
let idx = 0
for ( let i = 0; i < AGENTS.length; i++ ) {
	const size = base + ( i < rem ? 1 : 0 )
	chunks.push( needsWork.slice( idx, idx + size ) )
	idx += size
}

function statusMarker( r: Row ): string {
	if ( !r.htmlExists ) return '⏳ PENDING'
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

function renderBatch( agent: string, batchRows: Row[] ): string {
	let out = ''
	out += `# Migration Batch — ${ agent }\n\n`
	out += `**Agent: ${ agent }.** This file is yours alone — ${ batchRows.length } files, assigned so no other\n`
	out += `agent touches them. Do not pick up files outside this list, and do not edit the other three batch\n`
	out += `files (\`migration-batch-*.md\`) in this folder.\n\n`
	out += '---\n\n'
	out += '## Before you start\n\n'
	out += '1. Read [subagent-migration-instructions.md](_Claude/work/lens_crafter/migration/subagent-migration-instructions.md)\n'
	out += '   in full — the rules, the model requirement, the self-check, the two validators. Everything in\n'
	out += '   this batch file assumes you already did.\n'
	out += '2. Read [kcd-document-protocol.md](_Claude/references/domain/kcd-document-protocol.md) — the\n'
	out += '   locked spec the protocol validator enforces exactly.\n'
	out += '3. This is a lossless format transcription, not a summary. See\n'
	out += '   [widget-library.html](_Claude/references/domain/widget-library.html) for a worked correct\n'
	out += '   example if you want a concrete reference point.\n\n'
	out += '## Your files\n\n'
	out += 'Work them in any order. For each: if ⏳ PENDING, migrate fresh from the `.md`. If 🔴 NEEDS FIX,\n'
	out += 're-migrate it from the `.md` source with the same rigor — the existing `.html` is wrong, don\'t\n'
	out += 'patch around it. A file isn\'t done until it passes both validators — re-run\n'
	out += '`validate-html-migration.ps1` and `kcd_sdk`\'s `validate-corpus.ts` on it before moving on.\n\n'
	out += '| MD File | Status | Notes |\n|---|---|---|\n'
	for ( const r of batchRows ) {
		const mdRel = r.mdPath.replace( /^_Claude\//, '' )
		out += `| \`${ mdRel }\` | ${ statusMarker( r ) } | ${ notesFor( r ) } |\n`
	}
	out += '\n---\n\n'
	out += `## When you finish\n\n`
	out += `Log any drift you hit in [migration-drift-notes.md](_Claude/work/lens_crafter/migration/migration-drift-notes.md).\n`
	out += `If you find yourself making the same judgment call on more than one file, flag it as a candidate\n`
	out += `for a new Rule in \`subagent-migration-instructions.md\` §2 rather than deciding it silently — say\n`
	out += `so in the room rather than picking a convention on your own, since Marie/Ebon/Winston/Valarie may\n`
	out += `hit the same case differently.\n`
	return out
}

for ( let i = 0; i < AGENTS.length; i++ ) {
	const agent = AGENTS[ i ]
	const content = renderBatch( agent, chunks[ i ] )
	const outPath = path.join( migDir, `migration-batch-${ agent.toLowerCase() }.md` )
	fs.writeFileSync( outPath, content, 'utf-8' )
	console.log( `${ agent }: ${ chunks[ i ].length } files → ${ path.relative( repoRoot, outPath ) }` )
}
