import * as fs   from 'fs'
import * as path from 'path'

interface AliasEntry {
	prefix:   string    // "@shared/" for wildcards, "@kcd" for exact
	wildcard: boolean
	targets:  string[]  // absolute paths (forward slashes)
}

/**
 * Loads tsconfig `compilerOptions.paths` and resolves alias imports to
 * repo-relative paths. Call `loadTsconfig()` once per config before scanning.
 */
export class AliasResolver {
	private readonly entries:   AliasEntry[] = []
	private readonly repoRoot:  string

	constructor( repoRoot: string ) {
		this.repoRoot = path.resolve( repoRoot ).replace( /\\/g, '/' )
	}

	loadTsconfig( tsconfigPath: string ): this {
		let raw: string
		try {
			raw = fs.readFileSync( path.resolve( tsconfigPath ), 'utf-8' )
		} catch {
			return this
		}

		let cfg: unknown
		try {
			cfg = JSON.parse( raw )
		} catch {
			return this
		}

		const paths = ( cfg as any )?.compilerOptions?.paths as Record<string, string[]> | undefined
		if ( !paths ) return this

		const dir = path.dirname( path.resolve( tsconfigPath ) )

		for ( const [ pattern, rawTargets ] of Object.entries( paths ) ) {
			const wildcard = pattern.endsWith( '/*' )
			const prefix   = wildcard ? pattern.slice( 0, -1 ) : pattern
			const targets  = rawTargets.map( t =>
				path.resolve( dir, t ).replace( /\\/g, '/' )
			)
			this.entries.push( { prefix, wildcard, targets } )
		}

		return this
	}

	/**
	 * Returns a repo-relative path if `importStr` matches a known alias.
	 * Returns null for relative imports (starting with `.`) and unknown externals.
	 */
	resolve( importStr: string ): string | null {
		for ( const entry of this.entries ) {
			if ( entry.wildcard ) {
				if ( !importStr.startsWith( entry.prefix ) ) continue
				const tail = importStr.slice( entry.prefix.length )
				for ( const target of entry.targets ) {
					const base  = target.endsWith( '*' ) ? target.slice( 0, -1 ) + tail : target + tail
					const found = this._probe( base )
					if ( found ) return this._relative( found )
				}
			} else {
				if ( importStr !== entry.prefix ) continue
				for ( const target of entry.targets ) {
					const found = this._probe( target )
					if ( found ) return this._relative( found )
				}
			}
		}
		return null
	}

	private _probe( base: string ): string | null {
		const candidates = [ base, base + '.ts', base + '/index.ts', base + '.vue' ]
		for ( const c of candidates ) {
			if ( fs.existsSync( c ) ) return c
		}
		return null
	}

	private _relative( absPath: string ): string {
		return path.relative( this.repoRoot, absPath ).replace( /\\/g, '/' )
	}
}
