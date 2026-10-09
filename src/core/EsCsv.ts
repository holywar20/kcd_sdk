import type { FileEntry } from './FileTypes'

/**
 * EsCsv parses voidtools' `es.exe -csv -no-header` output into FileEntry[]. Pure and Node-free, so the parsing
 * is testable with plain strings and no process spawning.
 */
export class EsCsv {

	/** Column order is fixed by the flags SdkFileAccess._esArgs passes to es.exe, and the path column is the
	 *  full absolute path. A row with fewer than five columns is skipped; it is never fatal. */
	static parse( text: string ): FileEntry[] {
		const out: FileEntry[] = []
		for( const line of text.split( /\r?\n/ ) ) {
			if( !line ) continue
			const cols = EsCsv._row( line )
			if( cols.length < 5 ) continue
			const [ name, path, attrs, sizeStr, dateStr ] = cols
			const isDir = attrs.includes( 'D' )
			const mtime = Date.parse( dateStr )
			out.push( {
				name, path, isDir,
				size:  Number( sizeStr ) || 0,
				ext:   isDir ? '' : EsCsv._ext( name ),
				mtime: Number.isFinite( mtime ) ? mtime : 0
			} )
		}
		return out
	}

	/** One RFC4180 line into fields. Paths contain commas and es.exe quotes them, so a naive split(',') would corrupt rows. */
	private static _row( line: string ): string[] {
		const out: string[] = []
		let field = ''
		let inQuotes = false
		for( let i = 0; i < line.length; i += 1 ) {
			const c = line[ i ]
			if( inQuotes ) {
				if( c === '"' ) {
					if( line[ i + 1 ] === '"' ) { field += '"'; i += 1 }
					else inQuotes = false
				} else field += c
			} else if( c === '"' ) {
				inQuotes = true
			} else if( c === ',' ) {
				out.push( field ); field = ''
			} else {
				field += c
			}
		}
		out.push( field )
		return out
	}

	private static _ext( name: string ): string {
		const dot = name.lastIndexOf( '.' )
		return dot > 0 ? name.slice( dot + 1 ).toLowerCase() : ''
	}
}
