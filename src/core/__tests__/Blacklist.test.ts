import { describe, expect, it } from 'vitest';

import { Blacklist, DEFAULT_BLACKLIST, foldsCase } from '../Blacklist';

/**
 * The deny-list's matching rule and its defaults. The defaults are UNCONDITIONAL (a config can add patterns,
 * never drop one), and matching is SUBTREE-shaped and PURE: by pattern alone, never a stat, so a refusal can
 * name the rule without revealing whether the file exists. No disk here; every path is a string.
 */
describe( 'Blacklist.patterns — defaults are unconditional', () => {

	it( 'carries every default when given nothing', () => {
		expect( Blacklist.patterns() ).toEqual( DEFAULT_BLACKLIST );
	} );

	it( 'puts a caller\'s patterns AFTER the defaults, never instead of them', () => {
		expect( Blacklist.patterns( [ '**/vault/**' ] ) ).toEqual( [ ...DEFAULT_BLACKLIST, '**/vault/**' ] );
	} );

	it( 'still refuses a default-listed path when the config omits it entirely', () => {
		// A config is the one input a caller controls. If it could drop a default,
		// every protection here would be one setting away from gone.
		const config = Blacklist.patterns( [ '**/something-else/**' ] );

		expect( Blacklist.excludes( 'C:/proj/.env', config ) ).toBe( true );
		expect( Blacklist.excludes( 'C:/proj/_Claude/dev-utilities/commands.json', config ) ).toBe( true );
	} );

	it( 'drops a non-string row rather than carrying it into the matcher', () => {
		const junk = [ 42, null, '**/vault/**', { path: 'x' } ] as unknown as string[];

		expect( Blacklist.patterns( junk ) ).toEqual( [ ...DEFAULT_BLACKLIST, '**/vault/**' ] );
	} );
} );


describe( 'Blacklist.excludes — subtree semantics', () => {

	const deny = Blacklist.patterns();

	it( 'denies a whole subtree from one directory pattern', () => {
		// Why there is no second `**​/.ssh/**` entry: an ancestor match is a match.
		expect( Blacklist.excludes( '/home/b/.ssh/id_ed25519', deny ) ).toBe( true );
		expect( Blacklist.excludes( '/home/b/.ssh', deny ) ).toBe( true );
	} );

	it( 'normalizes Windows separators, so a backslash path meets the same `/`-shaped globs', () => {
		expect( Blacklist.excludes( 'C:\\proj\\certs\\server.pem', deny ) ).toBe( true );
	} );

	it( 'answers false for an empty pattern set rather than denying by default', () => {
		expect( Blacklist.excludes( 'C:/proj/.env', [] ) ).toBe( false );
	} );
} );

describe( 'case folding — the filesystem decides, not the pattern', () => {

	const deny = Blacklist.patterns();

	/** Secrets whose real names carry capitals. `fold` is passed explicitly, so the test pins a
	 *  platform rather than the host it runs on. */
	const capitalised = [
		'C:/proj/.ENV',
		'C:/proj/.Env.local',
		'C:/proj/secrets/ID_RSA',
		'C:/proj/cert.PFX',
		'C:/proj/Server.KEY',
		'C:/proj/.Git/config',
		'C:/proj/.SSH/config',
		'C:/proj/certs/Server.PEM',
	];

	it( 'denies a pattern\'s upper-case twin when the host folds ( win32, darwin )', () => {
		for( const path of capitalised ) {
			expect( Blacklist.excludes( path, deny, true ), path ).toBe( true );
		}
	} );

	it( 'leaves two case-distinct paths distinct when the host does NOT fold ( linux )', () => {
		// NOT a weaker rule — a correct one. On linux `.ENV` and `.env` really are two files, and
		// denying the first because the second is a secret refuses a file nobody protected.
		for( const path of capitalised ) {
			expect( Blacklist.excludes( path, deny, false ), path ).toBe( false );
		}
	} );

	it( 'still denies the real lower-case name under either rule', () => {
		// FENCE: folding may only ever ADD coverage. If one of these ever goes false, the fold broke
		// the eight patterns it was added to strengthen.
		for( const path of [ 'C:/proj/.env', 'C:/proj/cert.pfx', '/home/b/.ssh/id_rsa' ] ) {
			expect( Blacklist.excludes( path, deny, true ), path ).toBe( true );
			expect( Blacklist.excludes( path, deny, false ), path ).toBe( true );
		}
	} );

	it( 'folds the PATTERN as well as the path, so a config row\'s casing cannot weaken it', () => {
		// A user's extra pattern is the one row in here nobody authored in lower case. Folding only the
		// subject would make the rule depend on how the row happened to be typed.
		const config = Blacklist.patterns( [ '**/Secrets/**' ] );

		expect( Blacklist.excludes( 'C:/proj/secrets/token.txt', config, true ) ).toBe( true );
		expect( Blacklist.excludes( 'C:/proj/SECRETS/token.txt', config, true ) ).toBe( true );
		expect( Blacklist.excludes( 'C:/proj/secrets/token.txt', config, false ) ).toBe( false );
	} );

	it( 'folds on win32 and darwin, and on nothing else', () => {
		// The platform check IS the correctness. Taken as a string rather than read off `process` so
		// both branches are reachable from any host the suite happens to run on.
		expect( foldsCase( 'win32' ) ).toBe( true );
		expect( foldsCase( 'darwin' ) ).toBe( true );
		expect( foldsCase( 'linux' ) ).toBe( false );
		expect( foldsCase( 'freebsd' ) ).toBe( false );
	} );

	it( 'defaults to the host\'s own rule when no caller says otherwise', () => {
		// The five call sites pass nothing, deliberately: a forgotten argument must not be able to
		// hand back the weaker rule. So the default has to agree with the host, and this is that.
		expect( Blacklist.excludes( 'C:/proj/.ENV', deny ) ).toBe( foldsCase( process.platform ) );
	} );
} );

describe( 'the Command Deck roster — the one entry protecting an instruction', () => {

	const deny = Blacklist.patterns();

	it( 'denies the deck folder\'s OWN roster', () => {
		// The middle `**​/` matches zero directories, which is the whole reason one pattern suffices.
		expect( Blacklist.excludes( 'C:/starmind_root/_Claude/dev-utilities/commands.json', deny ) ).toBe( true );
	} );

	it( 'denies a category subfolder\'s roster', () => {
		// Every subfolder of the deck root carrying one is a category, and each is just as clickable.
		expect( Blacklist.excludes( 'C:/starmind_root/_Claude/dev-utilities/Sync/commands.json', deny ) ).toBe( true );
	} );

	it( 'denies it under a vault called something other than `_Claude`', () => {
		// The deck folder is `<project root>/<project docRoot>/dev-utilities` — the docRoot half comes from
		// the project record, so the pattern must not assume the vault's name.
		expect( Blacklist.excludes( 'D:/other/my-vault/dev-utilities/commands.json', deny ) ).toBe( true );
	} );

	it( 'does NOT deny the dev-utilities folder itself, nor the scripts in it', () => {
		// Scope ruling (Bryan): the roster only, not the dev-utilities tree.
		// Poisoning a script still runs through an unchanged button; if the tree is ever covered, change this loudly.
		expect( Blacklist.excludes( 'C:/starmind_root/_Claude/dev-utilities', deny ) ).toBe( false );
		expect( Blacklist.excludes( 'C:/starmind_root/_Claude/dev-utilities/git-ops.js', deny ) ).toBe( false );
		expect( Blacklist.excludes( 'C:/starmind_root/_Claude/dev-utilities/registry.json', deny ) ).toBe( false );
	} );

	it( 'does not deny a `commands.json` outside a dev-utilities folder', () => {
		// The pattern is anchored on the deck convention rather than on the filename, so an unrelated file
		// that happens to share the name stays readable. A bare `**​/commands.json` would not.
		expect( Blacklist.excludes( 'C:/starmind_root/starmind/src/commands.json', deny ) ).toBe( false );
	} );

	it( 'leaves the blacklist mechanism itself readable and writable', () => {
		// EXPLICIT RULING, not an oversight: "modifications to how the blacklist file WORKS needs to be
		// allowed — by definition." What is protected is the data, never the mechanism.
		expect( Blacklist.excludes( 'C:/starmind_root/kcd_sdk/src/core/Blacklist.ts', deny ) ).toBe( false );
	} );
} );

describe( 'the skill manifest — the other entry protecting an instruction', () => {

	const deny = Blacklist.patterns();

	it( 'denies a manifest on the shelf, wherever the shelf happens to sit', () => {
		// Anchored on the filename, not the shelf path: the same file also lives in project trees and copies.
		expect( Blacklist.excludes( 'C:/Users/b/AppData/Roaming/Starmind/skills/some-skill/SKILL.md', deny ) ).toBe( true );
		expect( Blacklist.excludes( '/home/b/.claude/skills/some-skill/SKILL.md', deny ) ).toBe( true );
		expect( Blacklist.excludes( 'C:/starmind_root/odysseus/integrations/claude/skills/odysseus/SKILL.md', deny ) ).toBe( true );
	} );

	it( 'denies it case-folded on a folding host, since `skill.md` is the same file there', () => {
		expect( Blacklist.excludes( 'C:/skills/s/skill.md', deny, true ) ).toBe( true );
		expect( Blacklist.excludes( 'C:/skills/s/skill.md', deny, false ) ).toBe( false );
	} );

	it( 'does NOT deny the skill FOLDER, nor the prose and scripts inside it', () => {
		// Scope is the manifest, not the folder: a skill must be able to tidy its own artifacts.
		// Accepted residual: a `references/` file the skill body tells an agent to read is still poisonable.
		const skill = 'C:/Users/b/AppData/Roaming/Starmind/skills/some-skill';
		expect( Blacklist.excludes( skill, deny ) ).toBe( false );
		expect( Blacklist.excludes( `${ skill }/references/api.md`, deny ) ).toBe( false );
		expect( Blacklist.excludes( `${ skill }/scripts/run.js`, deny ) ).toBe( false );
		expect( Blacklist.excludes( `${ skill }/output/draft.md`, deny ) ).toBe( false );
	} );

	it( 'does not deny a differently named markdown file beside it', () => {
		// One filename, not every manifest-ish name. `README.md` in a skill folder is ordinary prose.
		expect( Blacklist.excludes( 'C:/skills/some-skill/README.md', deny ) ).toBe( false );
		expect( Blacklist.excludes( 'C:/skills/some-skill/SKILLS.md', deny ) ).toBe( false );
	} );

	it( 'still refuses when a configured blacklist omits it — the default is unconditional', () => {
		// Same property the roster entry rests on, asserted for this entry too: a config is additive, so
		// supplying one cannot drop this and cannot drop the eight credential patterns beside it.
		const config = Blacklist.patterns( [ '**/something-else/**' ] );
		expect( Blacklist.excludes( 'C:/skills/s/SKILL.md', config ) ).toBe( true );
	} );

	it( 'leaves the skill READER itself readable and writable', () => {
		// The roster entry's ruling, applied here: what is protected is the DATA, never the mechanism. An
		// agent maintaining `SkillFolder.ts` must be able to read and write it.
		expect( Blacklist.excludes( 'C:/starmind_root/starmind/src/main/services/SkillFolder.ts', deny ) ).toBe( false );
	} );
} );

describe( 'the credential patterns', () => {

	const deny = Blacklist.patterns();

	it( 'holds all eight, unreordered, with the two instruction entries added after them', () => {
		// FENCE: these eight hold with zero config. Pinned as a literal so a reshuffle fails the test
		// rather than silently changing what a fresh install protects.
		expect( DEFAULT_BLACKLIST ).toEqual( [
			'**/.env*',
			'**/*.pem',
			'**/*.key',
			'**/*.p12',
			'**/*.pfx',
			'**/id_rsa*',
			'**/.ssh',
			'**/.git',
			'**/dev-utilities/**/commands.json',
			'**/SKILL.md',
		] );
	} );

	it( 'still matches each of them', () => {
		for( const path of [
			'C:/p/.env', 'C:/p/.env.local', 'C:/p/a.pem', 'C:/p/a.key', 'C:/p/a.p12', 'C:/p/a.pfx',
			'C:/p/id_rsa', 'C:/p/id_rsa.pub', 'C:/p/.ssh/config', 'C:/p/.git/config',
		] ) {
			expect( Blacklist.excludes( path, deny ), path ).toBe( true );
		}
	} );
} );
