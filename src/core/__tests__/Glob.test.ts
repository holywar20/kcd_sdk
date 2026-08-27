import { describe, expect, it } from 'vitest';

import { Glob } from '../Glob';

/**
 * The shared glob matcher.
 *
 * IT HAD NO TESTS UNTIL 2026-08-25, which is how `**​/*` shipped unable to match a file in the root
 * of its own search path. Every reader that globs goes through here — the vault query, the disk
 * walk, and the blacklist — so a wrong answer in this file is a wrong answer everywhere at once.
 */
describe( 'Glob.matches', () => {

	describe( 'the `**/` regression', () => {

		it( 'matches a file sitting DIRECTLY in the search root', () => {
			// THE BUG, in one assertion. `**​/` compiled to `.*​/`, which requires a literal slash, so a
			// root-level file could never match. Measured live before the fix: a directory of 7 .ts files
			// answered 7 to `*`, 7 to `*.ts`, and 0 to `**​/*`.
			expect( Glob.matches( 'ToolIdentities.ts', '**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'ToolIdentities.ts', '**/*' ) ).toBe( true );
		} );

		it( 'still matches at every depth, which is what it was always right about', () => {
			expect( Glob.matches( 'permissions/ToolIdentities.ts', '**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'a/b/c/deep.ts',                 '**/*.ts' ) ).toBe( true );
		} );

		it( 'matches zero directories after a literal prefix too', () => {
			// `src/**​/*.ts` must cover `src/index.ts`. This is the same defect one segment along, and the
			// form most likely to be written by hand.
			expect( Glob.matches( 'src/index.ts',     'src/**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'src/core/Glob.ts', 'src/**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'other/index.ts',   'src/**/*.ts' ) ).toBe( false );
		} );

		it( 'does not let the widened form match across the wrong extension or a sibling root', () => {
			// The fix may only ever match MORE. That is safe precisely because it stays ANCHORED — this is
			// the assertion that says the widening did not become a wildcard.
			expect( Glob.matches( 'ToolIdentities.tsx', '**/*.ts' ) ).toBe( false );
			expect( Glob.matches( 'notes.md',           '**/*.ts' ) ).toBe( false );
		} );
	} );

	describe( 'the segment rules the fix must not disturb', () => {

		it( 'keeps `*` inside one segment', () => {
			expect( Glob.matches( 'Glob.ts',      '*.ts' ) ).toBe( true );
			// The whole point of a single star: it must NOT leap a directory boundary.
			expect( Glob.matches( 'core/Glob.ts', '*.ts' ) ).toBe( false );
		} );

		it( 'lets a bare `**` cross segments', () => {
			expect( Glob.matches( 'a/b/c',  '**'   ) ).toBe( true );
			expect( Glob.matches( 'a',      '**'   ) ).toBe( true );
			expect( Glob.matches( 'a/b.ts', 'a/**' ) ).toBe( true );
		} );

		it( 'anchors the whole string rather than matching a substring', () => {
			expect( Glob.matches( 'xGlob.tsx', '*.ts'    ) ).toBe( false );
			expect( Glob.matches( 'a/b',       'a'       ) ).toBe( false );
			expect( Glob.matches( 'ab',        'a'       ) ).toBe( false );
		} );

		it( 'treats regex metacharacters in a pattern as literal text', () => {
			// A filename containing a dot or parentheses is ordinary; a matcher that read them as regex
			// would quietly match the wrong files rather than failing.
			expect( Glob.matches( 'a.b.ts',    'a.b.ts'   ) ).toBe( true );
			expect( Glob.matches( 'axbxts',    'a.b.ts'   ) ).toBe( false );
			expect( Glob.matches( 'note(1).md', 'note(1).md' ) ).toBe( true );
		} );

		it( 'matches an exact path with no wildcards at all', () => {
			expect( Glob.matches( 'habits/run-command/run-command-list.html',
			                      'habits/run-command/run-command-list.html' ) ).toBe( true );
		} );
	} );
} );
