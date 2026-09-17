import { describe, it, expect } from 'vitest';
import { KcdContext } from '../KcdContext';
import type { SerializedArtifact } from '../../../primitives/types';

/** A minimal habit `SerializedArtifact` — only the fields `projectHabit` reads ( type, path,
 *  frontmatter.name, body ) matter; the rest is cast away. */
const habit = ( name: string, body: string ): SerializedArtifact =>
	( { type: 'habit', path: `_Claude/habits/${ name }.html`, frontmatter: { name }, body } as unknown as SerializedArtifact );

const DO_STYLE = `<article data-kcd="habit">
	<section data-kcd-section="scaffold-note" data-kcd-audience="human"><h3>Scaffold</h3><p>human-only noise that must never ride</p></section>
	<section data-kcd-section="why"><h3>Why</h3><p>the user asks to "log", or a session closes after changing <code>_Claude/</code></p></section>
	<section data-kcd-section="action"><h3>Action</h3><p>prepend one dated breadcrumb line to <code>_Claude/logs/session.md</code></p></section>
	<section data-kcd-section="explanation"><h3>Explanation</h3><p>the session log is read in full to orient every new session, so it stays a terse, scannable trail.</p></section>
	<section data-kcd-section="rules"><h3>Rules</h3><ul><li>one line, ≤40 words</li><li>newest on top</li></ul></section>
</article>`;

const DONT_STYLE = `<article data-kcd="habit">
	<section data-kcd-section="why"><h3>Why</h3><p>tempted to create any class or module the task didn't name</p></section>
	<section data-kcd-section="explanation"><h3>Explanation</h3><p>silent new idioms fragment the codebase; announcing lets the user catch drift early.</p></section>
	<section data-kcd-section="rules"><h3>Rules</h3><ul><li>announce it before building</li><li>silence is approval</li></ul></section>
</article>`;

const ROWS = `<div data-kcd-slot="table-data"><span data-kcd-field="what" data-kcd-type="text">npm run typecheck</span><span data-kcd-field="why" data-kcd-type="text">reads types, writes nothing</span></div>
		<div data-kcd-slot="table-data"><span data-kcd-field="what" data-kcd-type="text">netstat -ano</span><span data-kcd-field="why" data-kcd-type="text">a read-only listing of sockets</span></div>`;

const WITH_PARAMS = `<article data-kcd="habit">
	<section data-kcd-section="why"><h3>Why</h3><p>about to run any shell command</p></section>
	<section data-kcd-section="action"><h3>Action</h3><p>match it against the whitelist</p></section>
	<section data-kcd-section="public-habit-params"><h3>Public habit params</h3>
		<p>Human-authored prose that is NOT a row, and must not leak into the block.</p>
		<div data-kcd-table>
		<div data-kcd-head><span>Command</span><span>Why it qualifies</span></div>
		${ ROWS }
		</div>
	</section>
	<section data-kcd-section="explanation"><h3>Explanation</h3><p>a list goes stale where a judgement drifts.</p></section>
	<section data-kcd-section="rules"><h3>Rules</h3><ul><li>literal form is literal</li></ul></section>
</article>`;

describe( 'KcdContext.projectHabit — the dense four-field directive', () => {
	it( 'do-style: line one is "{name} — when {when}, execute {action}."; line two is "↳ {explanation} · {rules}"', () => {
		const out = KcdContext.projectHabit( habit( 'log-session-liberal', DO_STYLE ) );
		expect( out ).toBe(
			'log-session-liberal — when the user asks to "log", or a session closes after changing _Claude/, execute prepend one dated breadcrumb line to _Claude/logs/session.md.\n' +
			'↳ the session log is read in full to orient every new session, so it stays a terse, scannable trail. · one line, ≤40 words; newest on top'
		);
	} );

	it( 'don\'t-style ( no action ): rules fold onto line one after a colon; explanation stays on line two', () => {
		const out = KcdContext.projectHabit( habit( 'no-new-idioms', DONT_STYLE ) );
		expect( out ).toBe(
			'no-new-idioms — when tempted to create any class or module the task didn\'t name: announce it before building; silence is approval.\n' +
			'↳ silent new idioms fragment the codebase; announcing lets the user catch drift early.'
		);
	} );

	it( 'the human-only scaffold-note never rides the dense form', () => {
		const out = KcdContext.projectHabit( habit( 'x', DO_STYLE ) );
		expect( out ).not.toContain( 'human-only noise' );
	} );

	// Params were a document convention with no consumer from 2026-08-17 to 2026-08-18: a habit could
	// point at a whitelist that no projection carried, so it read as populated on disk while behaving,
	// to the agent, as though the section were empty. These cases pin the injection that closed it.
	it( 'params rows ride the dense form as a labelled third block', () => {
		const out = KcdContext.projectHabit( habit( 'params-habit', WITH_PARAMS ) );

		expect( out.split( '\n' ) ).toEqual( [
			'params-habit — when about to run any shell command, execute match it against the whitelist.',
			'↳ a list goes stale where a judgement drifts. · literal form is literal',
			'↳ public-habit-params:',
			'- npm run typecheck — reads types, writes nothing',
			'- netstat -ano — a read-only listing of sockets',
		] );
	} );

	// Withholding rows is an AUDIENCE question, never a section-name one — a whitelist the agent cannot
	// see is not a whitelist. The audience marker is the one real lever, and every other section honours it.
	it( 'a params section marked human-only is withheld, like any other human-only section', () => {
		const out = KcdContext.projectHabit( habit( 'x', WITH_PARAMS.replace( 'data-kcd-section="public-habit-params"', 'data-kcd-section="public-habit-params" data-kcd-audience="human"' ) ) );

		expect( out ).not.toContain( 'public-habit-params:' );
		expect( out ).not.toContain( 'netstat' );
	} );

	// An empty list is a declared valid state ( the pole then behaves exactly as `run-command-ask` ), so
	// a params section with no rows must contribute no block rather than an empty labelled one.
	it( 'a params section with no rows contributes nothing', () => {
		const out = KcdContext.projectHabit( habit( 'x', WITH_PARAMS.replace( ROWS, '' ) ) );

		expect( out.split( '\n' ) ).toHaveLength( 2 );
		expect( out ).not.toContain( 'public-habit-params:' );
	} );

	it( 'a habit with no params section is unchanged — two lines, exactly as before', () => {
		const out = KcdContext.projectHabit( habit( 'log-session-liberal', DO_STYLE ) );

		expect( out.split( '\n' ) ).toHaveLength( 2 );
	} );

	it( 'projectBlocks routes a habit to ONE dense block ( region do, section "habit" ), not section-by-section', () => {
		const blocks = KcdContext.projectBlocks( habit( 'log-session-liberal', DO_STYLE ), 'do' );
		expect( blocks ).toHaveLength( 1 );
		expect( blocks[ 0 ].region ).toBe( 'do' );
		expect( blocks[ 0 ].section ).toBe( 'habit' );
		expect( blocks[ 0 ].text ).toContain( '— when ' );
		expect( blocks[ 0 ].text ).toContain( '↳ ' );
	} );
} );
