import { describe, expect, it } from 'vitest';

import { Blacklist, DEFAULT_BLACKLIST, foldsCase } from '../Blacklist';

/**
 * The deny-list's matching rule and its defaults.
 *
 * TWO PROPERTIES ARE THE DELIVERABLE HERE, and neither is about any one pattern. First, the defaults are
 * UNCONDITIONAL — `patterns` merges them ahead of a caller's list and offers no way to remove one, so a
 * configuration that omits an entry still refuses. Second, matching is SUBTREE-shaped and PURE: the path
 * or any ancestor, by pattern alone, never a stat, which is what lets a refusal disclose the rule without
 * disclosing whether the file exists.
 *
 * NO DISK, deliberately — every path below is a string. A test that created files would be testing
 * something this module does not do.
 */
describe( 'Blacklist.patterns — defaults are unconditional', () => {

	it( 'carries every default when given nothing', () => {
		expect( Blacklist.patterns() ).toEqual( DEFAULT_BLACKLIST );
	} );

	it( 'puts a caller\'s patterns AFTER the defaults, never instead of them', () => {
		expect( Blacklist.patterns( [ '**/vault/**' ] ) ).toEqual( [ ...DEFAULT_BLACKLIST, '**/vault/**' ] );
	} );

	it( 'still refuses a default-listed path when the config omits it entirely', () => {
		// THE PROPERTY, stated as the attack it stops. A config is the one input a caller controls; if
		// supplying one could drop a default, every protection here would be one setting away from gone.
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

	/** The hole as it was found: a secret whose real name on disk carries capitals. Every one of these
	 *  was listed by glob, found by search and readable by a lane agent on Windows while this list
	 *  said otherwise. `fold` is passed explicitly so the test pins a PLATFORM, not the host it runs
	 *  on — a suite that only ever ran on Windows would otherwise prove nothing about either branch. */
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
		// BRYAN'S SCOPE, 2026-09-30, pinned so a later reader does not mistake it for a gap in the pattern.
		// He ruled the roster only and not the tree, keeping the dev scripts a surface an agent can help
		// with. The consequence is deliberate and known: poisoning `git-ops.js` while leaving its card
		// alone gets the same execution from an unchanged button. If this ever becomes the tree, this test
		// is the one that must change, and it should change loudly.
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

describe( 'the credential patterns', () => {

	const deny = Blacklist.patterns();

	it( 'holds all eight, unreordered, with the roster entry added after them', () => {
		// FENCE. These eight hold with zero config and predate the roster entry; nothing about adding one
		// should narrow or reorder them. Pinned as a literal so a reshuffle is a failing test rather than a
		// silent change to what a fresh install protects.
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
