import { describe, expect, it } from 'vitest';
import * as path from 'path';

import { PathText } from '../PathText';

/**
 * Path arithmetic on text — the module that let `LensObject` stop importing Node's `path` ( bug-report-13 ).
 *
 * The property that matters is the MIRROR: for the shapes the SDK actually produces, an absolute root and
 * a vault-relative href, or two absolute paths, this answers byte for byte what Node's own `path.win32`
 * and `path.posix` answer. The node layer compares the two ( `Vault.resolveHref` against `Vault.toAbs` ),
 * so a divergence would not throw; it would quietly break link healing and backlinks. Both of Node's
 * implementations are reachable from any platform, which is why the mirror cases name them explicitly
 * rather than reading off `path` for whichever machine runs the suite.
 */
describe( 'PathText', () => {

	describe( 'isAbsolute', () => {
		it( 'reads the style off the path, never off the host', () => {
			expect( PathText.isAbsolute( 'C:\\a' ) ).toBe( true );
			expect( PathText.isAbsolute( 'c:/a' ) ).toBe( true );
			expect( PathText.isAbsolute( '\\\\srv\\share' ) ).toBe( true );
			expect( PathText.isAbsolute( '/vault/x' ) ).toBe( true );
			expect( PathText.isAbsolute( '_Claude/lenses/x.html' ) ).toBe( false );
			expect( PathText.isAbsolute( '../x' ) ).toBe( false );
			expect( PathText.isAbsolute( 'C:' ) ).toBe( false );   // drive-relative — Node says no too
		} );
	} );

	describe( 'resolve, Windows style', () => {
		it( 'joins a vault-relative href onto a drive-rooted project root, backslashed', () => {
			expect( PathText.resolve( 'C:\\starmind_root', '_Claude/lenses/main/main.html' ) )
				.toBe( 'C:\\starmind_root\\_Claude\\lenses\\main\\main.html' );
		} );
		it( 'folds dot segments and drops a trailing separator', () => {
			expect( PathText.resolve( 'C:/a/b/../c/./d/' ) ).toBe( 'C:\\a\\c\\d' );
		} );
		it( 'lets a later absolute part win, device and all', () => {
			expect( PathText.resolve( 'C:\\a', 'D:\\b\\c' ) ).toBe( 'D:\\b\\c' );
		} );
		it( 'gives a rooted part the device to its left', () => {
			expect( PathText.resolve( 'C:\\a', '\\rooted\\x' ) ).toBe( 'C:\\rooted\\x' );
		} );
		it( 'keeps the drive letter as it was spelled', () => {
			expect( PathText.resolve( 'c:\\x', 'y' ) ).toBe( 'c:\\x\\y' );
		} );
		it( 'cannot climb above the root', () => {
			expect( PathText.resolve( 'C:\\a', '..\\..\\..\\b' ) ).toBe( 'C:\\b' );
			expect( PathText.resolve( 'C:\\a', '..' ) ).toBe( 'C:\\' );
		} );
		it( 'keeps a UNC share as the root, backslashed however it arrived', () => {
			expect( PathText.resolve( '\\\\srv\\share\\dir', '..\\x' ) ).toBe( '\\\\srv\\share\\x' );
			expect( PathText.resolve( '//srv/share/dir', 'x' ) ).toBe( '\\\\srv\\share\\dir\\x' );
		} );
	} );

	describe( 'resolve, posix style', () => {
		it( 'joins a vault-relative href onto a posix root', () => {
			expect( PathText.resolve( '/vault', '_Claude/x.html' ) ).toBe( '/vault/_Claude/x.html' );
		} );
		it( 'folds dot segments and drops a trailing separator', () => {
			expect( PathText.resolve( '/vault/', './a/../b/./c/' ) ).toBe( '/vault/b/c' );
		} );
		it( 'cannot climb above the root', () => {
			expect( PathText.resolve( '/a', '../../x' ) ).toBe( '/x' );
			expect( PathText.resolve( '/' ) ).toBe( '/' );
		} );
		it( 'treats a backslash as an ordinary character, as posix does', () => {
			expect( PathText.resolve( '/a', 'b\\c' ) ).toBe( '/a/b\\c' );
		} );
	} );

	describe( 'relative', () => {
		it( 'answers a vault-relative path under a Windows root, backslashed', () => {
			expect( PathText.relative( 'C:\\root', 'C:\\root\\_Claude\\x.html' ) ).toBe( '_Claude\\x.html' );
		} );
		it( 'compares Windows paths without regard to case and keeps the target spelling', () => {
			expect( PathText.relative( 'c:\\ROOT', 'C:\\root\\Sub\\a' ) ).toBe( 'Sub\\a' );
		} );
		it( 'climbs with .. and answers an empty string for the same path', () => {
			expect( PathText.relative( 'C:\\a\\b', 'C:\\a\\c' ) ).toBe( '..\\c' );
			expect( PathText.relative( 'C:\\a\\b', 'C:\\' ) ).toBe( '..\\..' );
			expect( PathText.relative( 'C:\\', 'C:\\a' ) ).toBe( 'a' );
			expect( PathText.relative( 'C:\\a\\b', 'C:\\a\\b' ) ).toBe( '' );
		} );
		it( 'answers a target on another device, or in the other style, absolute', () => {
			expect( PathText.relative( 'C:\\a', 'D:\\x' ) ).toBe( 'D:\\x' );
			expect( PathText.relative( '/a', 'C:\\x' ) ).toBe( 'C:\\x' );
		} );
		it( 'is case-sensitive under a posix root', () => {
			expect( PathText.relative( '/root', '/root/a/b' ) ).toBe( 'a/b' );
			expect( PathText.relative( '/Root', '/root/a' ) ).toBe( '../root/a' );
			expect( PathText.relative( '/', '/x' ) ).toBe( 'x' );
			expect( PathText.relative( '/a', '/a' ) ).toBe( '' );
		} );
	} );

	describe( 'the mirror', () => {
		const WIN_RESOLVE: string[][] = [
			[ 'C:\\starmind_root', '_Claude/lenses/main/main.html' ],
			[ 'C:/starmind_root/', './_Claude/../_Claude/x.html' ],
			[ 'C:\\a\\b', '..\\c' ],
			[ 'C:\\a', '..\\..\\..\\b' ],
			[ 'c:\\Mixed\\Case', 'sub/' ],
			[ 'C:\\a', 'D:\\b\\c' ],
			[ 'C:\\a', '\\rooted\\x' ],
			[ '\\\\srv\\share\\dir', '..\\x' ],
			[ '//srv/share/dir', 'x' ],
			[ '\\\\?\\C:\\a\\..\\b' ],
			[ 'C:\\' ],
		];
		const WIN_RELATIVE: [ string, string ][] = [
			[ 'C:\\root', 'C:\\root\\_Claude\\x.html' ],
			[ 'c:\\ROOT', 'C:\\root\\Sub\\a' ],
			[ 'C:\\a\\b', 'C:\\a\\c' ],
			[ 'C:\\a\\b', 'C:\\' ],
			[ 'C:\\', 'C:\\a' ],
			[ 'C:\\a', 'D:\\x' ],
			[ 'C:\\a\\b', 'C:\\a\\b' ],
			[ 'C:/root', 'C:\\root\\_Claude/x.html' ],
		];
		const POSIX_RESOLVE: string[][] = [
			[ '/vault', '_Claude/x.html' ],
			[ '/vault/', './a/../b/./c/' ],
			[ '/a', '/b' ],
			[ '/a', '../../x' ],
			[ '/a', 'b\\c' ],
			[ '/' ],
		];
		const POSIX_RELATIVE: [ string, string ][] = [
			[ '/root', '/root/a/b' ],
			[ '/Root', '/root/a' ],
			[ '/a/b', '/a/c' ],
			[ '/a', '/a' ],
			[ '/', '/x' ],
		];

		it( 'resolves exactly as path.win32 does', () => {
			for( const parts of WIN_RESOLVE ) expect( PathText.resolve( ...parts ), parts.join( ' + ' ) ).toBe( path.win32.resolve( ...parts ) );
		} );
		it( 'relativizes exactly as path.win32 does', () => {
			for( const [ from, to ] of WIN_RELATIVE ) expect( PathText.relative( from, to ), `${ from } -> ${ to }` ).toBe( path.win32.relative( from, to ) );
		} );
		it( 'resolves exactly as path.posix does', () => {
			for( const parts of POSIX_RESOLVE ) expect( PathText.resolve( ...parts ), parts.join( ' + ' ) ).toBe( path.posix.resolve( ...parts ) );
		} );
		it( 'relativizes exactly as path.posix does', () => {
			for( const [ from, to ] of POSIX_RELATIVE ) expect( PathText.relative( from, to ), `${ from } -> ${ to }` ).toBe( path.posix.relative( from, to ) );
		} );
	} );

	it( 'refuses a call with no absolute part, rather than guessing a working directory', () => {
		expect( () => PathText.resolve( '_Claude/x.html' ) ).toThrow( /no absolute part/ );
		expect( () => PathText.relative( 'a', '/b' ) ).toThrow( /no absolute part/ );
	} );
} );
