/**
 * PathText — path arithmetic on TEXT. The two operations the SDK core needs from a path module,
 * `resolve` and `relative`, done on strings alone: no `fs`, no working directory, no platform module.
 * It lives in @kcd/core so it imports on either side of the bridge; Node's `path` used to reach the
 * browser bundle through the ONE core file that imported it, `LensObject` ( bug-report-13 ).
 *
 * A path's STYLE is read off the path, never off the host. A drive letter or a UNC prefix means
 * Windows: `\` separators, case-insensitive comparison. A leading `/` with no device means posix.
 * Either style comes out spelled the way Node's own `path.win32` / `path.posix` would spell it, and
 * that is load-bearing rather than cosmetic: the node layer compares what this module resolves against
 * what Node resolved ( `Vault.resolveHref` beside `Vault.toAbs` ), and link healing and backlink
 * queries ride that equality. The test file pins the mirror against both of Node's implementations.
 *
 * What it will NOT do is resolve a relative path against the working directory. Core cannot see one,
 * and a vault path was never relative to it. A relative part resolves against the absolute part before
 * it, and a call with no absolute part at all throws, because any answer would be a guess.
 */

type Style = 'win32' | 'posix'

/** A Windows DEVICE at the head of a path: a drive ( `C:` ) or a UNC share ( `\\server\share` ), the
 *  extended-length prefix included ( `\\?\C:` reads as a share named `C:` on a server named `?`, which
 *  is how Node reads it too ). Either separator, as Node accepts. */
const DEVICE = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/

export class PathText {

	/** Absolute in either style: a UNC share, a drive followed by a separator, a rooted `\x`, or a posix `/x`. */
	static isAbsolute( p: string ): boolean {
		const device = PathText._device( p )
		if( device.startsWith( '\\\\' ) || device.startsWith( '//' ) ) return true
		return /^[\\/]/.test( p.slice( device.length ) )
	}

	/**
	 * Resolve right to left, as Node does: the rightmost rooted part is the base, the parts after it are
	 * appended, `.` and `..` fold, and nothing climbs above the root. A part rooted without a device
	 * ( `\x` ) takes the device of the nearest device-carrying part to its left.
	 */
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

	/**
	 * `to` as seen from `from`, both resolved first. Equal paths give `''`; a target on another device, or
	 * in the other style, comes back absolute, as Node answers it. Windows compares without regard to
	 * case and answers with the target's own spelling.
	 */
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
