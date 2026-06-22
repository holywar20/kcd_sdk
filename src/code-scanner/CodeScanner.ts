import * as fs   from 'fs'
import * as path from 'path'
import type { CodeManifest, ManifestFile } from './types'
import { AliasResolver } from './AliasResolver'
import { FileParser }    from './FileParser'

const SKIP_DIRS    = new Set( [ 'node_modules', 'dist', '__tests__', '.git', 'unused' ] )
const SKIP_ENDINGS = [ '.d.ts', '.test.ts', '.spec.ts', '.test.vue', '.spec.vue' ]

/**
 * Walks one or more source directories and produces a CodeManifest.
 * Alias resolution is seeded from tsconfig path mappings; relative imports
 * are resolved file-by-file. Each file is assigned a cluster based on its
 * directory path with the /src/ segment stripped.
 */
export class CodeScanner {
	private readonly resolver: AliasResolver
	private readonly parser:   FileParser
	private readonly repoRoot: string

	constructor( repoRoot: string, tsconfigPaths: string[] ) {
		this.repoRoot = path.resolve( repoRoot )
		this.resolver = new AliasResolver( repoRoot )
		for ( const p of tsconfigPaths ) this.resolver.loadTsconfig( p )
		this.parser = new FileParser( this.resolver, this.repoRoot )
	}

	scan( sourceDirs: string[] ): CodeManifest {
		const files: ManifestFile[] = []

		for ( const dir of sourceDirs ) {
			for ( const absPath of this._walk( path.resolve( dir ) ) ) {
				const cluster = this._cluster( absPath )
				const entry   = this.parser.parse( absPath, cluster )
				if ( entry ) files.push( entry )
			}
		}

		return {
			generated: new Date().toISOString(),
			root:      path.relative( process.cwd(), this.repoRoot ) || '.',
			files,
		}
	}

	private _walk( dir: string ): string[] {
		const results: string[] = []
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync( dir, { withFileTypes: true } )
		} catch {
			return results
		}

		for ( const entry of entries ) {
			if ( entry.isDirectory() ) {
				if ( !SKIP_DIRS.has( entry.name ) ) results.push( ...this._walk( path.join( dir, entry.name ) ) )
				continue
			}
			if ( !entry.isFile() ) continue
			const name = entry.name
			if ( !name.endsWith( '.ts' ) && !name.endsWith( '.vue' ) ) continue
			if ( SKIP_ENDINGS.some( s => name.endsWith( s ) ) ) continue
			results.push( path.join( dir, name ) )
		}

		return results
	}

	/** Directory-based cluster: repo-relative path to the file's folder, /src/ stripped. */
	private _cluster( absPath: string ): string {
		const rel   = path.relative( this.repoRoot, absPath ).replace( /\\/g, '/' )
		const parts = rel.split( '/' )
		parts.pop()   // remove filename
		return parts.filter( p => p !== 'src' ).join( '/' )
	}
}
