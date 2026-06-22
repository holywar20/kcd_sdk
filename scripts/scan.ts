import * as path from 'path'
import * as fs   from 'fs'
import { CodeScanner } from '../src/code-scanner'

const repoRoot = path.resolve( __dirname, '../..' )

const scanner = new CodeScanner( repoRoot, [
	path.join( repoRoot, 'starmind/tsconfig.node.json' ),
	path.join( repoRoot, 'starmind/tsconfig.web.json' ),
] )

const manifest = scanner.scan( [
	path.join( repoRoot, 'starmind/src' ),
	path.join( repoRoot, 'kcd_sdk/src' ),
] )

const outPath = path.join( repoRoot, '_Claude/audits/code-manifest.json' )
fs.mkdirSync( path.dirname( outPath ), { recursive: true } )
fs.writeFileSync( outPath, JSON.stringify( manifest, null, '\t' ), 'utf-8' )

const rel = path.relative( process.cwd(), outPath )
console.log( `Scanned ${ manifest.files.length } files → ${ rel }` )
