/**
 * PathText — path arithmetic on TEXT (`resolve`, `relative`), with no `fs`, no cwd and no platform module, so it
 * imports on either side of the bridge. Style is read off the path, never the host; output is spelled as Node's
 * `path.win32` / `path.posix` would spell it, because the node layer compares against Node's own resolution.
 *
 * It never resolves against the working directory. A relative part resolves against the absolute part before it;
 * a call with no absolute part at all throws, because any answer would be a guess.
 */

type Style = 'win32' | 'posix'

/** A Windows DEVICE at the head of a path: a drive or a UNC share, the extended-length prefix included. `\\?\C:`
 *  reads as a share named `C:` on a server named `?`, which is how Node reads it too. */
const DEVICE = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/

export class PathText {

	/** Absolute in either style: a UNC share, a drive followed by a separator, a rooted `\x`, or a posix `/x`. */
	static isAbsolute( p: string ): boolean {
		const device = PathText._device( p )
		if( device.startsWith( '\\\\' ) || device.startsWith( '//' ) ) return true
		return /^[\\/]/.test( p.slice( device.length ) )
	}

	/** Right to left, as Node does: the rightmost rooted part is the base. A part rooted without a device
	 *  ( `\x` ) takes the device of the nearest device-carrying part to its left. */
	static resolve( ...parts: string[] ): string {
		let device  = ''
		let rooted  = false
		let rootSep = ''
		const tail: string[] = []
		for( let i = parts.length - 1; i >= 0; i-- ) {
			const part = parts[ i ]
			if( !part ) continue
			const dev  = PathText._device( part )
			const rest = part.slice( dev.length )
			if( !rooted ) {
				tail.unshift( rest )
				if( /^[\\/]/.test( rest ) ) { rooted = true; rootSep = rest[ 0 ]! }
			}
			if( dev && !device ) device = dev
			if( rooted && device ) break
		}
		if( !rooted ) throw new Error( `PathText.resolve: no absolute part among ( ${ parts.map( ( p ) => `'${ p }'` ).join( ', ' ) } )` )
		const style: Style = device || rootSep === '\\' ? 'win32' : 'posix'
		const segments = PathText._fold( tail.flatMap( ( t ) => PathText._split( t, style ) ) )
		return PathText._join( device, segments, style )
	}

	/** `to` as seen from `from`, both resolved first. A target on another device, or in the other style, comes back
	 *  absolute, as Node answers it. Windows compares case-insensitively and answers in the target's own spelling. */
	static relative( from: string, to: string ): string {
		const f = PathText.resolve( from )
		const t = PathText.resolve( to )
		const style = PathText._styleOf( f )
		if( style !== PathText._styleOf( t ) ) return t
		const same = style === 'win32'
			? ( a: string, b: string ): boolean => a.toLowerCase() === b.toLowerCase()
			: ( a: string, b: string ): boolean => a === b
		const fDev = PathText._device( f )
		const tDev = PathText._device( t )
		if( !same( fDev, tDev ) ) return t
		const fSeg = PathText._split( f.slice( fDev.length ), style ).filter( Boolean )
		const tSeg = PathText._split( t.slice( tDev.length ), style ).filter( Boolean )
		let i = 0
		while( i < fSeg.length && i < tSeg.length && same( fSeg[ i ]!, tSeg[ i ]! ) ) i++
		const sep = style === 'win32' ? '\\' : '/'
		return [ ...new Array<string>( fSeg.length - i ).fill( '..' ), ...tSeg.slice( i ) ].join( sep )
	}

	// ── Pieces ────────────────────────────────────────────────────────────────

	private static _device( p: string ): string {
		return DEVICE.exec( p )?.[ 0 ] ?? ''
	}

	/** The style of a RESOLVED path: a device or a leading backslash is Windows, a leading slash is posix. */
	private static _styleOf( resolved: string ): Style {
		return PathText._device( resolved ) || resolved.startsWith( '\\' ) ? 'win32' : 'posix'
	}

	/** Windows splits on either separator; posix on `/` alone, a backslash being an ordinary character there. */
	private static _split( text: string, style: Style ): string[] {
		return text.split( style === 'win32' ? /[\\/]+/ : /\/+/ )
	}

	/** Drop empties and `.`; let `..` pop, and at the root let it drop, which is how an absolute path stays below its root. */
	private static _fold( segments: string[] ): string[] {
		const out: string[] = []
		for( const s of segments ) {
			if( !s || s === '.' ) continue
			if( s === '..' ) { out.pop(); continue }
			out.push( s )
		}
		return out
	}

	/** Spell it: the device ( backslashed on Windows ), the root separator, the segments. No trailing separator past the root. */
	private static _join( device: string, segments: string[], style: Style ): string {
		const sep  = style === 'win32' ? '\\' : '/'
		const head = style === 'win32' ? device.replace( /\//g, '\\' ) : device
		return head + sep + segments.join( sep )
	}
}
