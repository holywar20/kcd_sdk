import { Glob } from './Glob';

/**
 * Blacklist — the negative permission layer, shared by every agent-facing file reader.
 *
 * The DENY side, beside a whitelist's ALLOW side. Two readers enforce it — the spawned
 * `starmind_file` child and the in-process `starmind_files` built-in — and they are in different
 * processes, so the only way they cannot drift is for the patterns AND the matching rule to live
 * here, in one Node-free place both already depend on.
 *
 * ONE SECURITY MODEL — SUBTREE SEMANTICS: a path is denied when the path ITSELF or ANY ANCESTOR
 * directory matches a deny pattern, so a single `.ssh` pattern hides the whole subtree without a
 * second `**​/.ssh/**` entry. Patterns are globs matched by the shared `Glob` matcher, identical to
 * the whitelist and the glob tool.
 *
 * PATTERN ALONE, NEVER DISK. This answers "is this path denied?" without a stat, which is what lets
 * a reader report policy without disclosing whether the file exists. Enforcement is bifurcated by
 * the CALLER, not here: discovery tools drop denied entries silently, a direct read says
 * `out_of_scope`.
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
	 * nothing is exploited — prompt injection reaching a text file is the whole attack. This was named and
	 * deferred in `ShellGate`'s own comment from 2026-09-05 and is closed here.
	 *
	 * READ IS DENIED TOO, and that is a RULING rather than a derivation ( Bryan, 2026-09-30 ): "It's more
	 * limiting but also simpler. Complex security models get subverted and we want to be judicious about
	 * where friction gets injected. Friction here is good — security should always get human attention."
	 * An agent cannot read the roster, so it cannot report the shape back either — which is why the shape
	 * is written down in the reference the refusal points at.
	 *
	 * HARDCODED DELIBERATELY, AND TEMPORARILY. `dev-utilities` is a CONVENTION ( CommandDeckDock computes
	 * the deck folder as `<project root>/<project docRoot>/dev-utilities` and never reads it from config ),
	 * so naming it here is exact rather than clever. It is not general: a future project could site a deck
	 * elsewhere and this would not cover it. THE FIX IS NOT A BETTER GLOB — it is minting a per-project
	 * blacklist at project-creation time, which is a separate deferred job. Do not "generalize" this line.
	 *
	 * SCOPE IS THE ROSTER, NOT THE TREE ( Bryan, 2026-09-30 ). The scripts a card NAMES — `git-ops.js`,
	 * `app-build.js` and their neighbours — sit in the same folder and are still agent-writable, so
	 * poisoning an existing card's script is an open path and a known one: the card is unchanged, so the
	 * user clicks a button they have pressed a hundred times. Ruled acceptable in exchange for keeping the
	 * dev scripts a working surface an agent can help with. Bryan on the scope of the whole card: "We are
	 * closing one door here — but the house has 20."
	 *
	 * NOTE WHAT IS *NOT* ON THIS LIST. `Blacklist.ts` itself, by explicit ruling: "modifications to how the
	 * blacklist file WORKS needs to be allowed — by definition." What is protected is the DATA, never the
	 * mechanism. That absence is a decision, not an oversight.
	 *
	 * The middle `**​/` matches ZERO or more directories ( see `Glob` ), so this one pattern covers both the
	 * deck folder's own roster and every category subfolder's.
	 */
	'**/dev-utilities/**/commands.json',
];

export const Blacklist = {

	/** The effective pattern set: the defaults, then the user's. DEFAULTS FIRST and unconditionally,
	 *  so a config can only ADD coverage — there is deliberately no way to switch a default off. */
	patterns( extra: readonly string[] = [] ): string[] {
		return [ ...DEFAULT_BLACKLIST, ...extra.filter( ( p ) => typeof p === 'string' && p.length > 0 ) ];
	},

	/** True when `path` is denied by `patterns` — the path or any ancestor directory matches. Pure:
	 *  no disk, no config, no state. Separators are normalized so a Windows path matches the same
	 *  '/'-shaped globs the vault and the glob tool use. */
	excludes( path: string, patterns: readonly string[] ): boolean {
		if ( patterns.length === 0 ) return false;

		const segments = path.replace( /\\/g, '/' ).split( '/' );
		for ( let depth = segments.length; depth > 0; depth -= 1 ) {
			const prefix = segments.slice( 0, depth ).join( '/' );
			for ( const pattern of patterns ) {
				if ( Glob.matches( prefix, pattern ) ) return true;
			}
		}
		return false;
	},
};
