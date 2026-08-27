import { defineConfig } from 'vitest/config'

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
export default defineConfig( {
	test: {
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
		exclude:     [ '**/node_modules/**', '**/dist/**' ]
	}
} )
