import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

/**
 * The structured-record reporter ( see _Claude/references/notes/test-results-pipeline.html ), loaded
 * OPTIONALLY and never fatally.
 *
 * IT LIVES IN THE VAULT, at `_Claude/dev-utilities/`, because that is the shared bucket that travels
 * with the project as documentation. Its previous home was `starmind_root/scripts/` — outside BOTH
 * repos, so on a fresh machine it simply was not there, and a STATIC import of a missing path is not
 * a test failure: esbuild cannot build the config at all, vitest dies at startup, and NOTHING runs.
 *
 * So the load is dynamic and caught. A reporter is infrastructure: a missing one degrades to
 * `default` alone, which is a quieter run rather than no run. The guard is duplicated in starmind's
 * config rather than shared, deliberately — the thing that makes an optional folder optional cannot
 * itself live in that folder.
 */
async function loadTestResults(): Promise<( ( suite: string ) => Reporter ) | null> {
	const path = resolve( __dirname, '..', '_Claude', 'dev-utilities', 'test-results', 'reporter.mjs' )
	if( !existsSync( path ) ) return null
	try {
		// The specifier is COMPUTED so the config bundler leaves it as a runtime import rather than
		// trying to resolve it at build time — which is the failure this guard exists to prevent.
		const mod = await import( pathToFileURL( path ).href )
		return mod.default ?? null
	}
	catch( err ) {
		process.stderr.write( `[test-results] reporter not loaded: ${ ( err as Error )?.message }\n` )
		return null
	}
}

/**
 * The first config this package has ever had.
 *
 * Until 2026-08-23 kcd_sdk ran vitest on inherited defaults with no config file at all, three majors
 * behind every other suite in the workspace ( ^1.6.0 against ^4.1.8, in repositories authored the same
 * week ). That worked — but nobody had ever CHOSEN the environment or the include glob, and inherited
 * and chosen are different states even when they look identical. This file makes the choice explicit
 * so the next person changing it is arguing with a decision rather than with an accident.
 *
 * WHAT THE AUDIT FOUND, since the answer is the reason this file is short:
 *
 *  • Nothing was being silently skipped. All 33 test files sit at `src/**\/__tests__/*.test.ts`, which
 *    the default include already matched, and `dist/` is excluded by default so the 33 COMPILED copies
 *    of those same tests never double-ran.
 *  • Nothing was failing to resolve. tsconfig declares no `paths`, and no test imports anything but
 *    relative paths, node builtins and `vitest` itself — so the alias hazard that makes a config-less
 *    runner dangerous elsewhere does not exist here.
 *
 * So this config CODIFIES the previous behaviour rather than changing it. If the file count moves when
 * it lands, that is a defect in this file, not a discovery.
 */
export default defineConfig( async () => {
const testResults = await loadTestResults()

return {
	test: {
		// ── THE STRUCTURED RECORD ( plan 4.a ) ────────────────────────────────────────────────────
		//
		// `default` STAYS FIRST and is not optional: naming a reporter REPLACES the set, so dropping it
		// would trade the terminal output a person reads for the file an agent reads. Both, or this
		// becomes a worse experience wearing a better one.
		//
		// The reporter is shared from the vault rather than copied per package, for the same reason
		// membership in `test-all.mjs` was read off the tree: three copies of one shape drift, and the
		// one that drifts is the one nobody is looking at. It is also OPTIONAL — see loadTestResults.
		reporters: [ 'default', ...( testResults ? [ testResults( 'vitest:kcd_sdk' ) ] : [] ) ],
		name:        'kcd_sdk',
		// Node-only by construction. @kcd/core is deliberately Node-free so the renderer can import it,
		// and @kcd/node is the fs layer — neither has ever wanted a DOM, and the suite mounts nothing.
		environment: 'node',

		// DELIBERATELY WIDER THAN THE CONVENTION. Every test today lives in a `__tests__/` folder, and
		// narrowing this glob to match would be more precise and strictly worse: a test misfiled outside
		// that folder would then SILENTLY NOT RUN, which is the exact failure this workspace has already
		// paid for once — starmind's renderer tests sat on disk unexecuted for weeks because a single
		// include pattern did not reach them, and the suite reported green the whole time. A misfiled
		// test that RUNS and fails is a visible problem; one that is skipped is not a problem at all
		// until it is a very large one.
		include:     [ 'src/**/*.test.ts' ],

		// `dist/` is in vitest's default exclude, so this line changes nothing today. It is here because
		// of WHAT is in there: `tsconfig.json` compiles `src/**/*` — tests included — so dist holds a
		// complete second copy of this suite. If that exclude ever moves, every test would run twice,
		// once against source and once against stale compiled output, and the two would disagree in ways
		// that read as flakiness. Stating it makes the hazard visible at the place that governs it.
		//
		// ( That dist ships the test suite at all is a PACKAGING problem, not a test-running one, and is
		//   tracked on the automation-suite plan rather than fixed here. )
		exclude:     [ '**/node_modules/**', '**/dist/**' ],

		// ── COVERAGE ──────────────────────────────────────────────────────────────────────────────
		//
		// `all: true` is the line that matters: without it v8 counts only files a test imported, so an
		// untested module is invisible rather than uncovered and the percentage climbs as coverage
		// falls. This package is a LIBRARY, which makes that failure mode worse than elsewhere — an
		// unimported export is exactly the thing a library most needs to know about.
		//
		// `dist/` is excluded here for the same reason it is excluded above, and the reason is sharper
		// for coverage: dist holds a complete compiled copy of both the source AND the suite, so
		// counting it would double every file and report a number that means nothing at all.
		//
		// No thresholds until there is a baseline — see the automation-suite plan, item 6.c.
		coverage: {
			provider:         'v8',
			reporter:         [ 'text-summary', 'json-summary' ],
			reportsDirectory: './coverage',
			all:              true,
			include:          [ 'src/**/*.ts' ],
			exclude:          [ '**/__tests__/**', '**/*.test.ts', '**/dist/**', '**/*.d.ts' ]
		}
	}
}
} )
