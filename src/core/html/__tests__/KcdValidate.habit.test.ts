import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * The habit PROJECTION rules — content a habit carries that the dense form never delivers.
 *
 * `KcdContext.projectHabit` reads four sections and takes `rules` from `<li>` items only. Everything
 * else in the file rides an on-demand read, which is a real and deliberate tier — so these cases are
 * NOT about forbidding extra sections. They pin the two shapes where the authored document and the
 * projected one disagree without anything reporting it, both found in the deployed corpus on
 * 2026-08-18: `author-script` and `author-reference` had written their rules as house faux-tables
 * ( seven and six rules respectively, reaching no agent ), and `run-command-list` told the agent to
 * check a whitelist that lives in a section the projection drops.
 */
function habit( name: string, body: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${ name }</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="habit">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for the habit projection rules.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">habit</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>${ name } — Habit</h1>
<section data-kcd-section="why"><h3>Why</h3><p>a fixture fires</p></section>
<section data-kcd-section="explanation"><h3>Explanation</h3><p>so the unrelated warnings stay quiet</p></section>
${ body }</article>
</body>
</html>
`;
}

const codes = ( r: { errors: { code: string }[]; warnings: { code: string }[] } ): string[] =>
	[ ...r.errors, ...r.warnings ].map( i => i.code );

describe( 'KcdValidate — habit rules must be a list to project', () => {

	// The corpus shape this rule was written from. The house idiom for a rules block is a faux-table,
	// and following it here silently deletes every rule from the only form an agent ever receives.
	it( 'rules authored as a faux-table is an ERROR, because projectHabit reads list items only', () => {
		const report = KcdValidate.validate( habit( 'table-rules', `
			<section data-kcd-section="rules"><h3>Rules</h3>
				<div data-kcd-table>
					<div data-kcd-head><span>Rule</span></div>
					<div data-kcd-slot="rule"><span data-kcd-field="rule" data-kcd-type="text">Scripts are dev-only and never ship.</span></div>
				</div>
			</section>` ) );

		expect( report.errors.map( e => e.code ) ).toContain( 'habit-rules-not-projecting' );
		expect( report.ok ).toBe( false );
	} );

	it( 'rules authored as a list PASSES — that is the shape the projection reads', () => {
		const report = KcdValidate.validate( habit( 'list-rules', `
			<section data-kcd-section="rules"><h3>Rules</h3>
				<ul><li>write the whole path from root every time</li></ul>
			</section>` ) );

		expect( codes( report ) ).not.toContain( 'habit-rules-not-projecting' );
	} );

	// `rules` is optional in the shape table. A habit that simply has none is not carrying dropped
	// content, so the rule must stay silent — otherwise it grades authorship rather than reporting loss.
	it( 'no rules section at all is silent, not an error', () => {
		const report = KcdValidate.validate( habit( 'no-rules', `
			<section data-kcd-section="action"><h3>Action</h3><p>do the thing</p></section>` ) );

		expect( codes( report ) ).not.toContain( 'habit-rules-not-projecting' );
	} );

	// Prose in a rules block loses just as completely as a table does — the mechanism is the same
	// ( `readSection` files everything that is not an <li> under `text`, and `projectHabit` reads
	// `items` ), so the check is anchored on the absence of list items rather than on seeing a table.
	it( 'prose in the rules section fails for the same reason a table does', () => {
		const report = KcdValidate.validate( habit( 'prose-rules', `
			<section data-kcd-section="rules"><h3>Rules</h3><p>never edit the whitelist on your own initiative</p></section>` ) );

		expect( report.errors.map( e => e.code ) ).toContain( 'habit-rules-not-projecting' );
	} );
} );

describe( 'KcdValidate — a projected field may not defer to a section that is dropped', () => {

	// `run-report`, verbatim in shape: the action said "see the Output/Format sections below", so the
	// agent was handed a pointer whose target the dense form drops. The destination path survived only
	// because it happened to be inlined in the same sentence; the chart template did not.
	it( 'an action naming a non-projected section WARNS', () => {
		const report = KcdValidate.validate( habit( 'template-pointer', `
			<section data-kcd-section="action"><h3>Action</h3><p>write the chart — see the format section below for the exact shape</p></section>
			<section data-kcd-section="format"><h3>Format</h3><p>the table template</p></section>` ) );

		const hit = report.warnings.find( w => w.code === 'habit-nonprojecting-ref' );
		expect( hit ).toBeDefined();
		expect( hit!.where ).toBe( 'section:action' );
		expect( report.ok ).toBe( true );          // a warning, not a refusal — the fix is editorial
	} );

	// The params sections PROJECT ( `KcdContext.paramBlocks` ), so pointing at one is correct and this
	// check must stay quiet. It did warn here until 2026-08-18, when the compiler was taught to inject
	// them — the pin exists so the two lists cannot drift back apart: a section that rides must never be
	// reported as dropped, or the warning trains authors to delete a working reference.
	it( 'an action naming its own params section is silent — params ride the projection', () => {
		const report = KcdValidate.validate( habit( 'whitelist-pointer', `
			<section data-kcd-section="action"><h3>Action</h3><p>check the command against private-habit-params · whitelist below</p></section>
			<section data-kcd-section="private-habit-params"><h3>Private habit params</h3><p>ships empty</p></section>` ) );

		expect( codes( report ) ).not.toContain( 'habit-nonprojecting-ref' );
	} );

	// The extra-section tier is legitimate and heavily used. A habit that carries reference material
	// nothing points at is correct by design, and a check that fired here would forbid the tier.
	it( 'extra sections nothing refers to are silent — the on-demand tier is not a defect', () => {
		const report = KcdValidate.validate( habit( 'quiet-extras', `
			<section data-kcd-section="action"><h3>Action</h3><p>place the script by species and stamp it</p></section>
			<section data-kcd-section="promotion"><h3>The promotion ladder</h3><p>junk to diagnostic to dev-utility</p></section>
			<section data-kcd-section="references"><h3>References</h3><p>see also</p></section>` ) );

		expect( codes( report ) ).not.toContain( 'habit-nonprojecting-ref' );
	} );

	// The precision case, and the reason the check is anchored on section NAMES rather than on deictic
	// words like "above" / "below". `run-command-judge` and `run-command-free` both say "every rule
	// above" — pointing at `rules`, which projects perfectly well. A deixis-based check flags both and
	// teaches authors to route around it; this one stays quiet.
	it( 'a projected field pointing at ANOTHER projected field is fine', () => {
		const report = KcdValidate.validate( habit( 'rule-backref', `
			<section data-kcd-section="action"><h3>Action</h3><p>run it when every rule above is satisfied</p></section>
			<section data-kcd-section="rules"><h3>Rules</h3><ul><li>effects must die with the session</li></ul></section>` ) );

		expect( codes( report ) ).not.toContain( 'habit-nonprojecting-ref' );
	} );

	// One habit may leak in more than one place; each is its own finding so a fix can be verified
	// field by field rather than by watching a single warning disappear.
	it( 'reports once per offending field', () => {
		const report = KcdValidate.validate( habit( 'two-pointers', `
			<section data-kcd-section="action"><h3>Action</h3><p>write the chart described under format</p></section>
			<section data-kcd-section="rules"><h3>Rules</h3><ul><li>follow format exactly</li></ul></section>
			<section data-kcd-section="format"><h3>Format</h3><p>the table template</p></section>` ) );

		const where = report.warnings.filter( w => w.code === 'habit-nonprojecting-ref' ).map( w => w.where );
		expect( where ).toEqual( [ 'section:action', 'section:rules' ] );
	} );
} );
