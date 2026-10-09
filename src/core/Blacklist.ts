import { Glob } from './Glob';

/**
 * Blacklist — the negative permission layer, shared by every agent-facing file reader.
 *
 * Subtree: a path is denied when it or any ancestor directory matches, so one `.ssh` pattern hides the subtree.
 * Pattern alone, never disk: no stat, so a reader reports policy without disclosing that a file exists.
 * Case follows the filesystem: `.ENV` and `.env` are one file on win32/darwin, two on linux. Folding
 * unconditionally would merge distinct linux files; folding nowhere lets `Server.KEY` through on Windows.
 */

/** The default deny-list — always merged in, so protection holds with ZERO config.
 *  A SECURITY boundary, never a noise filter: `node_modules` / build-dir noise belongs to a separate,
 *  opt-in flag, because mixing the two teaches people to trim this list.
 *
 *  Two KINDS of thing are protected here, and they are protected for opposite reasons. The first eight
 *  patterns keep a SECRET out of a model's context — the harm is in the reading. The last one keeps an
 *  EXECUTABLE INSTRUCTION out of an agent's hands — the harm is in the writing, and the read is denied
 *  alongside it by ruling rather than by necessity ( see below ). Both kinds belong on one list because
 *  there is one enforcement point; nothing about the matching rule distinguishes them. */
export const DEFAULT_BLACKLIST: string[] = [
	'**/.env*',
	'**/*.pem',
	'**/*.key',
	'**/*.p12',
	'**/*.pfx',
	'**/id_rsa*',
	'**/.ssh',
	'**/.git',

	/**
	 * THE COMMAND DECK ROSTER — the one entry here that protects an INSTRUCTION rather than a secret.
	 *
	 * WHAT IT IS. `<project vault>/dev-utilities/**​/commands.json` is the Command Deck's card roster: an
	 * array of `{ label, icon, run, args, shell }` rows, each of which becomes a button a person clicks to
	 * launch a script in a shell. The deck stamps origin `command-deck`, which is the ONE origin on
	 * `ShellGate`'s allow-list, so a row in this file is a shell command waiting for a click.
	 *
	 * WHY IT IS DENIED. An agent that can write this file can plant a card, and the human's click launders
	 * it into arbitrary execution through a gate behaving exactly as designed. Nothing is escaped and
	 * nothing is exploited — prompt injection reaching a text file is the whole attack.
	 *
	 * READ IS DENIED TOO, by ruling: friction here is deliberate. An agent that cannot read the roster
	 * cannot report its shape back.
	 *
	 * HARDCODED DELIBERATELY, AND TEMPORARILY. `dev-utilities` is a CONVENTION ( CommandDeckDock computes
	 * the deck folder as `<project root>/<project docRoot>/dev-utilities` and never reads it from config ),
	 * so naming it here is exact rather than clever. It is not general: a future project could site a deck
	 * elsewhere and this would not cover it. THE FIX IS NOT A BETTER GLOB — it is minting a per-project
	 * blacklist at project-creation time, which is a separate deferred job. Do not "generalize" this line.
	 *
	 * SCOPE IS THE ROSTER, NOT THE TREE. Scripts a card names, such as `git-ops.js`, sit in the same folder
	 * and are still agent-writable: poisoning one is a known open path, ruled acceptable to keep dev scripts usable.
	 *
	 * NOT ON THIS LIST: `Blacklist.ts` itself. What is protected is the DATA, never the mechanism; that
	 * absence is a decision.
	 *
	 * The middle `**​/` matches ZERO or more directories ( see `Glob` ), so this one pattern covers both the
	 * deck folder's own roster and every category subfolder's.
	 */
	'**/dev-utilities/**/commands.json',
];

/** Does a filesystem of this platform treat two paths differing only in case as the SAME file?
 *  Pure, and takes the platform as a string so both branches are testable without a stub. */
export function foldsCase( platform: string ): boolean {
	return platform === 'win32' || platform === 'darwin';
}

/** `foldsCase` for the host this runs on, as `excludes`' default. It is a default so a forgotten argument
 *  cannot silently weaken the rule, and it folds when it cannot tell: over-denying beats disclosing. */
function hostFoldsCase(): boolean {
	return typeof process === 'undefined' || typeof process.platform !== 'string'
		? true
		: foldsCase( process.platform );
}

export const Blacklist = {

	/** The effective pattern set: the defaults, then the user's. DEFAULTS FIRST and unconditionally,
	 *  so a config can only ADD coverage — there is deliberately no way to switch a default off. */
	patterns( extra: readonly string[] = [] ): string[] {
		return [ ...DEFAULT_BLACKLIST, ...extra.filter( ( p ) => typeof p === 'string' && p.length > 0 ) ];
	},

	/** True when `path` or any ancestor directory matches `patterns`. Pure: no disk, no config.
	 *  `fold` defaults to this host's filesystem; pass it only to pin a platform in a test. */
	excludes( path: string, patterns: readonly string[], fold: boolean = hostFoldsCase() ): boolean {
		if ( patterns.length === 0 ) return false;

		// Both sides or neither: folding one side would make the rule depend on how a row was typed.
		const normalized = path.replace( /\\/g, '/' );
		const subject    = fold ? normalized.toLowerCase() : normalized;
		const globs      = fold ? patterns.map( ( p ) => p.toLowerCase() ) : patterns;

		const segments = subject.split( '/' );
		for ( let depth = segments.length; depth > 0; depth -= 1 ) {
			const prefix = segments.slice( 0, depth ).join( '/' );
			for ( const pattern of globs ) {
				if ( Glob.matches( prefix, pattern ) ) return true;
			}
		}
		return false;
	},
};
