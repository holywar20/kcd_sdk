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

/** The secrets-only default deny-list — always merged in, so protection holds with ZERO config.
 *  A SECURITY boundary (hide credentials), never a noise filter: `node_modules` / build-dir noise
 *  belongs to a separate, opt-in flag, because mixing the two teaches people to trim this list. */
export const DEFAULT_BLACKLIST: string[] = [
	'**/.env*',
	'**/*.pem',
	'**/*.key',
	'**/*.p12',
	'**/*.pfx',
	'**/id_rsa*',
	'**/.ssh',
	'**/.git',
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
