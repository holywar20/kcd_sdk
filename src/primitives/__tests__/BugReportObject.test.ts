import { describe, it, expect } from 'vitest';
import { KCDPrimitive, BugReportObject } from '../index';
import { KcdValidate } from '../../core/html/KcdValidate';

/**
 * The bug report — the one type whose status words are its own, and whose body fields map onto the
 * task board by name. Two seams are pinned: the validator takes a type's status set IN PLACE OF the
 * global one ( and only for that type ), and `taskFields()` is a read by field name.
 */
function doc( type: string, status: string, body: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>fixture</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="${ type }">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">bug-report-7</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">Tool calls hang after an expired token.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ type }</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">${ status }</dd>
<dt>created</dt><dd data-kcd-field="created" data-kcd-type="date">2026-09-12</dd>
</dl>
${ body }</article>
</body>
</html>
`;
}

const BODY = `<h1>Bug Report 7</h1>
<section data-kcd-section="report"><h2 data-kcd-heading>Report</h2>
<p>Harness turns die silently.</p>
<p>Filed by <span data-kcd-field="raisedBy" data-kcd-type="text">lens-crafter</span>, priority <span data-kcd-field="priority" data-kcd-type="enum">high</span>.</p>
<p>Fixed when: <span data-kcd-field="exitCondition" data-kcd-type="text">a turn with an expired token fails with the auth reason</span>.</p>
</section>
<section data-kcd-section="repair"><h2 data-kcd-heading>Repair</h2>
<p>Claimed by <span data-kcd-field="assignee" data-kcd-type="text">main</span> on <span data-kcd-field="startedAt" data-kcd-type="date">2026-09-13</span>.</p>
</section>
`;

const ROOT = '_Claude';

describe( 'KcdValidate — a type\'s own status vocabulary', () => {

	it( 'a bug report accepts a board state', () => {
		const report = KcdValidate.validate( doc( 'bug-report', 'working', BODY ), { docRoot: ROOT } );
		expect( report.errors ).toEqual( [] );
	} );

	it( 'a bug report refuses a global status — its set REPLACES the global one', () => {
		const report = KcdValidate.validate( doc( 'bug-report', 'active', BODY ), { docRoot: ROOT } );
		expect( report.errors.map( e => e.code ) ).toContain( 'not-allowed' );
	} );

	it( 'another type refuses a board state — the set is scoped to the type that declares it', () => {
		const report = KcdValidate.validate( doc( 'reference', 'working', BODY ), { docRoot: ROOT } );
		expect( report.errors.map( e => e.code ) ).toContain( 'not-allowed' );
	} );

	it( 'another type still accepts the global set', () => {
		const report = KcdValidate.validate( doc( 'reference', 'active', BODY ), { docRoot: ROOT } );
		expect( report.errors ).toEqual( [] );
	} );
} );

describe( 'BugReportObject.taskFields — the board mapping', () => {

	// Hydrated per test, never at collection — a parse failure then fails the case that depends on it
	// rather than taking the whole file down with no test named.
	const hydrate = () => KCDPrimitive.fromHtml( doc( 'bug-report', 'working', BODY ), '_Claude/bug-reports/bug-report-7.html', ROOT );

	it( 'hydrates as a bug report, not a bare primitive', () => {
		expect( hydrate() ).toBeInstanceOf( BugReportObject );
	} );

	it( 'reads frontmatter and annotated body fields by Task property name', () => {
		const fields = ( hydrate() as BugReportObject ).taskFields();

		expect( fields ).toMatchObject( {
			name:          'bug-report-7',
			title:         'Tool calls hang after an expired token.',
			category:      'bugfix',
			state:         'working',
			createdAt:     '2026-09-12',
			raisedBy:      'lens-crafter',
			priority:      'high',
			exitCondition: 'a turn with an expired token fails with the auth reason',
			assignee:      'main',
			startedAt:     '2026-09-13',
		} );
	} );

	it( 'a field not yet written reads empty, not missing', () => {
		const fields = ( hydrate() as BugReportObject ).taskFields();

		expect( fields.verifiedBy ).toBe( '' );
		expect( fields.approval ).toBe( '' );
		expect( fields.endedAt ).toBe( '' );
	} );

	it( 'body is the Report section\'s text', () => {
		const fields = ( hydrate() as BugReportObject ).taskFields();

		expect( fields.body ).toContain( 'Harness turns die silently.' );
		expect( fields.body ).not.toContain( 'Claimed by' );
	} );
} );
