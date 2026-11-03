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

	/**
	 * THE THREE WILDCARDS THAT WERE ESCAPED INSTEAD OF HONOURED ( DEFECT-035 ). Each case below fails against
	 * the old chain, and the `?` pair fails in BOTH directions — it matched what it should not and missed what
	 * it should, which is why both halves are asserted rather than just the miss.
	 */
	describe( 'braces', () => {

		it( 'expands `{a,b}` into a choice — the reported case', () => {
			// Reported twice from real work: an agent hunting config writes this, gets "no match", and concludes
			// the files are absent. The pattern used to look for a name ending in the eleven characters `.{conf,ini}`.
			expect( Glob.matches( 'etc/nginx.conf', '**/*.{conf,ini}' ) ).toBe( true );
			expect( Glob.matches( 'etc/nginx.ini',  '**/*.{conf,ini}' ) ).toBe( true );
			expect( Glob.matches( 'etc/nginx.yaml', '**/*.{conf,ini}' ) ).toBe( false );
		} );

		it( 'takes a brace group anywhere in the segment, not only at the end', () => {
			// The live reproduction from the bug report, in miniature: the union of three plain globs.
			const pattern = '**/*{outreach,mail,calendar}*';
			expect( Glob.matches( 'main/services/MailService.ts', pattern ) ).toBe( false );
			expect( Glob.matches( 'main/services/mailService.ts', pattern ) ).toBe( true );
			expect( Glob.matches( 'studio/plugins/outreach.vue',  pattern ) ).toBe( true );
			expect( Glob.matches( 'calendar.ts',                  pattern ) ).toBe( true );
			expect( Glob.matches( 'studio/plugins/DocStudio.vue', pattern ) ).toBe( false );
		} );

		it( 'nests, rather than half-supporting it', () => {
			expect( Glob.matches( 'a.ts',  '{a,{b,c}}.ts' ) ).toBe( true );
			expect( Glob.matches( 'b.ts',  '{a,{b,c}}.ts' ) ).toBe( true );
			expect( Glob.matches( 'c.ts',  '{a,{b,c}}.ts' ) ).toBe( true );
			expect( Glob.matches( 'd.ts',  '{a,{b,c}}.ts' ) ).toBe( false );
		} );

		it( 'leaves a brace group with NO COMMA literal, because there is nothing to choose between', () => {
			// `{a}` and `a` must not be the same pattern. The decision is stated here because it is a decision.
			expect( Glob.matches( '{a}.ts', '{a}.ts' ) ).toBe( true );
			expect( Glob.matches( 'a.ts',   '{a}.ts' ) ).toBe( false );
		} );

		it( 'keeps an unclosed brace literal rather than compiling something else', () => {
			expect( Glob.matches( '{a,b.ts', '{a,b.ts' ) ).toBe( true );
			expect( Glob.matches( 'a.ts',    '{a,b.ts' ) ).toBe( false );
		} );

		it( 'lets a star inside a group stay a star, and the group stay inside its segment', () => {
			expect( Glob.matches( 'src/a.ts',   '{src,lib}/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'lib/a.ts',   '{src,lib}/*.ts' ) ).toBe( true );
			expect( Glob.matches( 'src/a/b.ts', '{src,lib}/*.ts' ) ).toBe( false );
		} );
	} );

	describe( '`?`', () => {

		it( 'matches EXACTLY ONE character — both halves, because it used to do the opposite of each', () => {
			// `note?.md` compiled to `^note?\.md$`: the `e` became optional. So it matched the shorter name and
			// missed the one glob's `?` is for. One character, two wrong answers.
			expect( Glob.matches( 'notes.md', 'note?.md' ) ).toBe( true );
			expect( Glob.matches( 'not.md',   'note?.md' ) ).toBe( false );
		} );

		it( 'does not cross a path separator', () => {
			// `?` is `*`'s single-character sibling and inherits the same boundary.
			expect( Glob.matches( 'a/b', 'a?b' ) ).toBe( false );
			expect( Glob.matches( 'axb', 'a?b' ) ).toBe( true );
		} );

		it( 'needs a character to be there at all', () => {
			expect( Glob.matches( 'ab',  'a?b' ) ).toBe( false );
			expect( Glob.matches( 'log', 'log?' ) ).toBe( false );
			expect( Glob.matches( 'log1', 'log?' ) ).toBe( true );
		} );
	} );

	describe( 'character classes — SUPPORTED, not refused', () => {

		it( 'takes a range', () => {
			expect( Glob.matches( 'log3.txt', 'log[0-9].txt' ) ).toBe( true );
			expect( Glob.matches( 'logx.txt', 'log[0-9].txt' ) ).toBe( false );
			// Exactly one character, like `?` — a class is not a wildcard.
			expect( Glob.matches( 'log12.txt', 'log[0-9].txt' ) ).toBe( false );
		} );

		it( 'takes a set', () => {
			expect( Glob.matches( 'a.ts', '[abc].ts' ) ).toBe( true );
			expect( Glob.matches( 'd.ts', '[abc].ts' ) ).toBe( false );
		} );

		it( 'negates with `!` or `^`, since shell writes one and regex the other', () => {
			expect( Glob.matches( 'd.ts', '[!abc].ts' ) ).toBe( true );
			expect( Glob.matches( 'a.ts', '[!abc].ts' ) ).toBe( false );
			expect( Glob.matches( 'd.ts', '[^abc].ts' ) ).toBe( true );
			expect( Glob.matches( 'a.ts', '[^abc].ts' ) ).toBe( false );
		} );

		it( 'does not let a NEGATED class swallow the separator', () => {
			// The hazard a negated class carries that a positive one does not: `[^a]` as plain regex matches `/`.
			expect( Glob.matches( 'a/b', 'a[!x]b' ) ).toBe( false );
		} );

		it( 'reads `*` and `?` inside a class as ordinary characters', () => {
			// The reason the scan claims `[` before any wildcard: a class body is not pattern text.
			expect( Glob.matches( 'a*b', 'a[*?]b' ) ).toBe( true );
			expect( Glob.matches( 'a?b', 'a[*?]b' ) ).toBe( true );
			expect( Glob.matches( 'axb', 'a[*?]b' ) ).toBe( false );
		} );

		it( 'keeps an unclosed bracket literal', () => {
			expect( Glob.matches( 'log[0-9.txt', 'log[0-9.txt' ) ).toBe( true );
			expect( Glob.matches( 'log3.txt',    'log[0-9.txt' ) ).toBe( false );
		} );
	} );

	/**
	 * THE HALF THAT MATTERS MOST. A glob has three ways to come back empty and they look identical: the files
	 * are not there, they are denied and dropped in silence, or the pattern was voided before it was matched
	 * against anything. This is what lets a reply tell the third from the other two.
	 */
	describe( 'Glob.unsupported', () => {

		it( 'says nothing about a pattern it fully honours', () => {
			expect( Glob.unsupported( '**/*.{conf,ini}' ) ).toEqual( [] );
			expect( Glob.unsupported( 'src/**/log[0-9]?.ts' ) ).toEqual( [] );
		} );

		it( 'names a literal brace, which is the mistake the reported case actually was', () => {
			const notes = Glob.unsupported( '**/*.{conf}' );
			expect( notes ).toHaveLength( 1 );
			expect( notes[ 0 ] ).toContain( '`{a,b}` is alternation' );
		} );

		it( 'names an unclosed bracket', () => {
			expect( Glob.unsupported( 'log[0-9.txt' ).join( ' ' ) ).toContain( 'never closed' );
		} );

		it( 'names extended glob, which is honoured in part and therefore means something else', () => {
			expect( Glob.unsupported( '!(a|b).ts' ).join( ' ' ) ).toContain( 'extended glob' );
			expect( Glob.unsupported( '+(a).ts'   ).join( ' ' ) ).toContain( 'extended glob' );
		} );

		it( 'names a backslash rather than letting it read as a separator', () => {
			expect( Glob.unsupported( 'src\\*.ts' ).join( ' ' ) ).toContain( 'literal character' );
		} );

		it( 'names a REFUSED pattern, and the matcher refuses it rather than voiding it quietly', () => {
			// Over the brace bound. The two facts have to agree: nothing matches, AND the reply can say why.
			const over = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}{s,t}{u,v}';
			expect( Glob.matches( 'acegikmoqsu', over ) ).toBe( false );
			expect( Glob.unsupported( over ).join( ' ' ) ).toContain( 'could not compile' );
		} );

		it( 'names a reversed range rather than throwing out of the walk that filtered on it', () => {
			// `new RegExp` throws on `[z-a]`. Every caller is a filter inside a directory walk, so a throw here
			// would take the whole walk down over one bad pattern.
			expect( () => Glob.matches( 'a.ts', '[z-a].ts' ) ).not.toThrow();
			expect( Glob.matches( 'a.ts', '[z-a].ts' ) ).toBe( false );
			expect( Glob.unsupported( '[z-a].ts' ).join( ' ' ) ).toContain( 'could not compile' );
		} );
	} );

	/** The deny-list and the test-gate allow-list run through this matcher, so widening it is a security edit. */
	describe( 'the patterns the security layer actually uses', () => {

		it( 'still matches every Blacklist default exactly as before', () => {
			// None of these holds `?`, `{` or `[`, which is what made the widening safe — the check, not the claim.
			expect( Glob.matches( 'src/.env',              '**/.env*' ) ).toBe( true );
			expect( Glob.matches( '.env.local',            '**/.env*' ) ).toBe( true );
			expect( Glob.matches( 'certs/server.pem',      '**/*.pem' ) ).toBe( true );
			expect( Glob.matches( '.ssh',                  '**/.ssh'  ) ).toBe( true );
			expect( Glob.matches( 'home/.ssh',             '**/.ssh'  ) ).toBe( true );
			expect( Glob.matches( 'a/dev-utilities/commands.json',   '**/dev-utilities/**/commands.json' ) ).toBe( true );
			expect( Glob.matches( 'a/dev-utilities/b/commands.json', '**/dev-utilities/**/commands.json' ) ).toBe( true );
			expect( Glob.matches( 'skills/x/SKILL.md',     '**/SKILL.md' ) ).toBe( true );
			expect( Glob.matches( 'SKILL.md',              '**/SKILL.md' ) ).toBe( true );
			expect( Glob.matches( 'notes.md',              '**/SKILL.md' ) ).toBe( false );
		} );
	} );
} );
