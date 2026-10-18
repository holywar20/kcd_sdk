import { describe, expect, it } from 'vitest';

import { Glob } from '../Glob';

/**
 * The shared glob matcher. Every reader that globs goes through here — the vault query, the disk walk and
 * the blacklist — so a wrong answer in this file is a wrong answer everywhere at once.
 */
describe( 'Glob.matches', () => {

	describe( 'the `**/` regression', () => {

		it( 'matches a file sitting DIRECTLY in the search root', () => {
			// `**/` once compiled to `.*/`, which needs a literal slash, so a root-level file never matched.
			expect( Glob.matches( 'ToolIdentities.ts', '**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'ToolIdentities.ts', '**/*' ) ).toBe( true );
		} );

		it( 'still matches at every depth, which is what it was always right about', () => {
			expect( Glob.matches( 'permissions/ToolIdentities.ts', '**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'a/b/c/deep.ts',                 '**/*.ts' ) ).toBe( true );
		} );

		it( 'matches zero directories after a literal prefix too', () => {
			// `src/**/*.ts` must cover `src/index.ts`: the same defect one segment along.
			expect( Glob.matches( 'src/index.ts',     'src/**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'src/core/Glob.ts', 'src/**/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'other/index.ts',   'src/**/*.ts' ) ).toBe( false );
		} );

		it( 'does not let the widened form match across the wrong extension or a sibling root', () => {
			// The widening may only ever match more, and it stays anchored: this pins that it is not a wildcard.
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
			// Metacharacters are literal text: read as regex, they would quietly match the wrong files.
			expect( Glob.matches( 'a.b.ts',    'a.b.ts'   ) ).toBe( true );
			expect( Glob.matches( 'axbxts',    'a.b.ts'   ) ).toBe( false );
			expect( Glob.matches( 'note(1).md', 'note(1).md' ) ).toBe( true );
		} );

		it( 'matches an exact path with no wildcards at all', () => {
			expect( Glob.matches( 'habits/run-command/run-command-judge.html',
			                      'habits/run-command/run-command-judge.html' ) ).toBe( true );
		} );
	} );
} );
