import type { FileEntry } from './FileTypes'

/**
 * EsCsv — parses voidtools' `es.exe -csv -no-header` output into FileEntry[]. Pure, Node-free
 * (no fs, no child_process): hoisted out of SdkFileAccess so the parsing logic — the part most
 * worth getting exactly right — is testable with plain strings, no process spawning required.
 * See SdkFileAccess.search's ES fast path (search-all-files.html, Phase 5).
 */
export class EsCsv {

	/** Column order is FIXED by the exact flag order SdkFileAccess._esArgs passes to es.exe: Name,
	 *  Filename (the FULL absolute path — es.exe's naming, not ours), Attributes ('D' present iff
	 *  it's a directory), Size, Date Modified (ISO-8601 UTC, via -date-format 3). A row that doesn't
	 *  parse into 5 columns is skipped, not fatal — one bad line never drops the rest. */
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

	/** One RFC4180 CSV line -> its fields. Windows paths routinely contain commas — seen LIVE on the
	 *  dev machine ( "…Packages\CoreEditorFonts,version=17.7.40001.1,productarch=neutral\_package.json" )
	 *  — which es.exe correctly quotes; a naive split(',') would silently corrupt those rows. Handles
	 *  quoted fields and "" as an escaped quote inside one. */
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
