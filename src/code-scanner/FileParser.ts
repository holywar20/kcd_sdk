import * as fs   from 'fs'
import * as path from 'path'
import type { ManifestFile, ManifestExport, ManifestMember, ManifestType, LocalImport, ExternalImport, ExportKind } from './types'
import type { AliasResolver } from './AliasResolver'

/** Words that match the member regex but are not callable members. */
const FLOW_KEYWORDS = new Set( [
	'if', 'else', 'for', 'while', 'do', 'switch', 'return', 'try', 'catch',
	'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'yield',
	'await', 'delete', 'void', 'case', 'default', 'break', 'continue',
	'import', 'export', 'class', 'extends', 'implements', 'interface', 'super',
	'type', 'enum', 'namespace', 'module', 'declare', 'abstract', 'this',
	'public', 'private', 'protected', 'static', 'readonly', 'override',
	'get', 'set', 'async', 'from', 'as', 'const', 'let', 'var', 'function',
	'true', 'false', 'null', 'undefined', 'require', 'Object', 'Array',
	'Promise', 'Error', 'console', 'process',
] )

/** Captures a method/member name at the start of a trimmed line. */
const MEMBER_RE = /^(?:(?:public|private|protected|static|async|override|abstract|readonly|declare|get|set)\s+)*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[(<]/

/**
 * Parses a single TypeScript or Vue source file into a ManifestFile entry.
 * Handles: imports (alias + relative + external), exports (all kinds),
 * inline members (classes and const-objects), and unexported top-level types.
 */
export class FileParser {
	constructor(
		private readonly resolver: AliasResolver,
		private readonly repoRoot: string,
	) {}

	parse( absPath: string, cluster: string ): ManifestFile | null {
		let raw: string
		try {
			raw = fs.readFileSync( absPath, 'utf-8' )
		} catch {
			return null
		}

		let content = raw
		if ( absPath.endsWith( '.vue' ) ) {
			content = this._extractVueScript( raw )
			if ( !content.trim() ) return null
		}

		const lines   = content.split( /\r?\n/ )
		const file    = path.relative( this.repoRoot, absPath ).replace( /\\/g, '/' )
		const fileDir = path.dirname( absPath )

		const result: ManifestFile = {
			file,
			cluster,
			exports: [],
			imports: { local: [], external: [] },
			types:   [],
		}

		let depth          = 0
		let inBlockComment = false
		let importBuffer:  string[] = []
		let currentExport: ManifestExport | null = null
		let exportBodyDepth = -1

		for ( let i = 0; i < lines.length; i++ ) {
			const line    = lines[ i ]
			const lineNum = i + 1
			const trimmed = line.trimStart()

			// --- Block comment gate ---
			if ( inBlockComment ) {
				if ( line.includes( '*/' ) ) inBlockComment = false
				continue
			}
			if ( trimmed.startsWith( '/*' ) ) {
				if ( !line.includes( '*/' ) ) inBlockComment = true
				continue
			}
			// Lines inside a block comment that starts with ` * ` (JSDoc interior)
			if ( trimmed.startsWith( '* ' ) || trimmed === '*' ) continue
			if ( trimmed.startsWith( '//' ) ) continue

			// --- Multi-line import accumulation ---
			if ( importBuffer.length > 0 ) {
				importBuffer.push( line )
				const joined = importBuffer.join( ' ' )
				if ( /from\s+['"]/.test( joined ) ) {
					this._parseImport( joined, fileDir, result.imports )
					importBuffer = []
				}
				continue
			}

			if ( trimmed.startsWith( 'import ' ) ) {
				if ( /from\s+['"]/.test( line ) ) {
					this._parseImport( line, fileDir, result.imports )
				} else {
					importBuffer = [ line ]
				}
				continue
			}

			// Strip inline block comments before brace counting
			const stripped = line.replace( /\/\*.*?\*\//g, '' )
			const net      = this._countBraces( stripped )

			// --- Member collection (at the body level of the current export) ---
			if ( currentExport && depth === exportBodyDepth ) {
				const member = this._tryMember( trimmed, lineNum )
				if ( member ) {
					if ( !currentExport.members ) currentExport.members = []
					currentExport.members.push( member )
				}
			}

			// --- Export / type detection (top-level only) ---
			if ( depth === 0 ) {
				const exp = this._tryExport( trimmed, lineNum )
				if ( exp ) {
					result.exports.push( exp )
					if ( this._hasMemberBody( exp.kind ) && net > 0 ) {
						currentExport    = exp
						exportBodyDepth  = 1
					}
				} else {
					const typ = this._tryType( trimmed, lineNum )
					if ( typ ) result.types.push( typ )
				}
			}

			depth += net

			if ( currentExport && depth < exportBodyDepth ) {
				currentExport   = null
				exportBodyDepth = -1
			}
		}

		return result
	}

	// ---------------------------------------------------------------------------
	// Import parsing
	// ---------------------------------------------------------------------------

	private _parseImport(
		line:     string,
		fileDir:  string,
		imports:  ManifestFile[ 'imports' ],
	): void {
		const norm  = line.replace( /\s+/g, ' ' ).trim()
		const fromM = norm.match( /from\s+['"]([^'"]+)['"]/ )
		if ( !fromM ) return
		const from = fromM[ 1 ]

		const statementTypeOnly = /^import\s+type[\s{]/.test( norm )
		const names             = this._importNames( norm, statementTypeOnly )

		const aliased = this.resolver.resolve( from )

		if ( aliased !== null ) {
			for ( const { name, typeOnly } of names ) {
				const entry: LocalImport = { name, from, path: aliased }
				if ( typeOnly ) entry.typeOnly = true
				imports.local.push( entry )
			}
		} else if ( from.startsWith( '.' ) ) {
			const resolved = this._resolveRelative( from, fileDir )
			for ( const { name, typeOnly } of names ) {
				const entry: LocalImport = { name, from, path: resolved }
				if ( typeOnly ) entry.typeOnly = true
				imports.local.push( entry )
			}
		} else {
			for ( const { name, typeOnly } of names ) {
				const entry: ExternalImport = { name, from }
				if ( typeOnly ) entry.typeOnly = true
				imports.external.push( entry )
			}
		}
	}

	private _importNames(
		norm:                string,
		statementTypeOnly:   boolean,
	): Array<{ name: string; typeOnly: boolean }> {
		const names: Array<{ name: string; typeOnly: boolean }> = []

		// import * as X from '...'
		const nsM = norm.match( /import\s+(?:type\s+)?\*\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/ )
		if ( nsM ) {
			names.push( { name: nsM[ 1 ], typeOnly: statementTypeOnly } )
			return names
		}

		const beforeFrom = norm.slice( 0, norm.lastIndexOf( ' from ' ) )

		// Default import (with or without named siblings)
		const defM = beforeFrom.match( /import\s+(?:type\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:,|$)/ )
		if ( defM ) names.push( { name: defM[ 1 ], typeOnly: statementTypeOnly } )

		// Named imports: { A, type B, C as D }
		const namedM = beforeFrom.match( /\{([^}]+)\}/ )
		if ( namedM ) {
			for ( const part of namedM[ 1 ].split( ',' ) ) {
				const p = part.trim()
				if ( !p ) continue
				const typeOnly = statementTypeOnly || /^type\s+/.test( p )
				const nameRaw  = p.replace( /^type\s+/, '' ).split( /\s+as\s+/ ).at( -1 )!.trim()
				if ( nameRaw ) names.push( { name: nameRaw, typeOnly } )
			}
		}

		return names
	}

	private _resolveRelative( from: string, fileDir: string ): string {
		const base       = path.resolve( fileDir, from ).replace( /\\/g, '/' )
		const candidates = [ base, base + '.ts', base + '/index.ts', base + '.vue' ]
		for ( const c of candidates ) {
			if ( fs.existsSync( c ) ) return path.relative( this.repoRoot, c ).replace( /\\/g, '/' )
		}
		return path.relative( this.repoRoot, base + '.ts' ).replace( /\\/g, '/' )
	}

	// ---------------------------------------------------------------------------
	// Export / type / member detection
	// ---------------------------------------------------------------------------

	private _tryExport( trimmed: string, line: number ): ManifestExport | null {
		if ( !trimmed.startsWith( 'export ' ) ) return null

		// class
		let m = trimmed.match( /^export\s+(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'class', line, members: [] }

		// function
		m = trimmed.match( /^export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'function', line }

		// interface (exported — unexported interfaces handled by _tryType)
		m = trimmed.match( /^export\s+interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'interface', line }

		// type alias
		m = trimmed.match( /^export\s+type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=<{]/ )
		if ( m ) return { name: m[ 1 ], kind: 'type', line }

		// enum
		m = trimmed.match( /^export\s+(?:const\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'enum', line }

		// const — detect kind from rhs
		m = trimmed.match( /^export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::[^=]+?)?\s*=\s*(.+)/ )
		if ( m ) {
			const name = m[ 1 ]
			const rhs  = m[ 2 ].trimStart()
			let kind: ExportKind
			if ( rhs.startsWith( '{' ) ) {
				kind = 'const-object'
			} else if ( /^(?:async\s*)?\(/.test( rhs ) || /^async\s+[a-zA-Z_$]/.test( rhs ) ) {
				kind = 'const-function'
			} else {
				kind = 'const-value'
			}
			return { name, kind, line }
		}

		return null
	}

	private _tryType( trimmed: string, line: number ): ManifestType | null {
		// Only unexported types — exported ones are caught by _tryExport
		if ( trimmed.startsWith( 'export ' ) ) return null

		let m = trimmed.match( /^type\s+([A-Z][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'type', exported: false, line }

		m = trimmed.match( /^interface\s+([A-Z][a-zA-Z0-9_$]*)/ )
		if ( m ) return { name: m[ 1 ], kind: 'interface', exported: false, line }

		return null
	}

	private _tryMember( trimmed: string, line: number ): ManifestMember | null {
		if ( !trimmed ) return null
		if ( trimmed[ 0 ] === '}' || trimmed[ 0 ] === '/' || trimmed[ 0 ] === '*' ) return null

		const m = trimmed.match( MEMBER_RE )
		if ( !m ) return null

		const name = m[ 1 ]
		if ( FLOW_KEYWORDS.has( name ) ) return null

		return { name, kind: 'method', line }
	}

	private _hasMemberBody( kind: ExportKind ): boolean {
		return kind === 'class' || kind === 'const-object'
	}

	// ---------------------------------------------------------------------------
	// Brace counting
	// ---------------------------------------------------------------------------

	/** Net brace change for a line, ignoring braces inside string literals and line comments. */
	private _countBraces( line: string ): number {
		let count   = 0
		let inStr   = false
		let strChar = ''
		let i       = 0

		while ( i < line.length ) {
			const ch = line[ i ]

			if ( inStr ) {
				if ( ch === '\\' ) { i += 2; continue }   // skip escaped char
				if ( ch === strChar ) inStr = false
			} else {
				if ( ch === '"' || ch === "'" || ch === '`' ) {
					inStr   = true
					strChar = ch
				} else if ( ch === '/' && line[ i + 1 ] === '/' ) {
					break   // rest is a comment
				} else if ( ch === '{' ) {
					count++
				} else if ( ch === '}' ) {
					count--
				}
			}
			i++
		}

		return count
	}

	private _extractVueScript( content: string ): string {
		const m = content.match( /<script\b[^>]*>([\s\S]*?)<\/script>/ )
		return m?.[ 1 ] ?? ''
	}
}
