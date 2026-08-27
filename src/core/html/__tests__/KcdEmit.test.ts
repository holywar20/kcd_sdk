import { describe, it, expect } from 'vitest';
import { KcdParse } from '../KcdParse';
import { KcdEmit } from '../KcdEmit';
import { KcdValidate } from '../KcdValidate';

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">emit-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture used only by KcdEmit's round-trip test.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
<dt>tags</dt><dd data-kcd-field="tags" data-kcd-type="list"><ul data-kcd-chips><li data-kcd-tag>alpha</li><li data-kcd-tag>beta</li></ul></dd>
<dt>todo</dt><dd data-kcd-field="todo" data-kcd-type="address">_Claude/logs/x/todo.html</dd>
</dl>
<h1>Fixture</h1>
<p>Some prose that must survive the round trip untouched.</p>
</article>
</body>
</html>
`;

describe( 'KcdEmit — round trip against KcdParse', () => {
	it( 'emits a document that validates clean', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		const report = KcdValidate.validate( html );
		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );

	// NOT byte-for-byte, and the name used to say it was. `spliceFrontmatter` re-parses and
	// re-serializes the whole body, so what survives is CONTENT and structure, never the source's
	// exact whitespace — and since 2026-08-17 the output is deliberately reformatted. The assertion
	// below was always a `toContain`, so only the name was ever wrong; that is precisely how the claim
	// survived being repeated into the tool description an agent reads.
	it( 'edited frontmatter rides through; untouched body content survives', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const edited = { ...artifact, frontmatter: { ...artifact.frontmatter, status: 'draft' } };

		const html = KcdEmit.emit( edited );
		const reparsed = KcdParse.parse( html, 'fixture.html' );

		expect( reparsed.frontmatter[ 'status' ] ).toBe( 'draft' );
		expect( reparsed.frontmatter[ 'name' ] ).toBe( 'emit-fixture' );
		expect( reparsed.frontmatter[ 'tags' ] ).toEqual( [ 'alpha', 'beta' ] );
		expect( reparsed.body ).toContain( 'Some prose that must survive the round trip untouched.' );
	} );

	// An address field carries its value as TEXT and must NOT be emitted as a link — an address asserts
	// no occupancy, so taking its value from an href would make it the very thing it replaces
	// ( KcdAddress.fieldValue ). The round trip is the guard: emit text, read text, same value back.
	it( 'an address field round-trips as a real value, and never as a link', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		const reparsed = KcdParse.parse( html, 'fixture.html' );
		expect( reparsed.frontmatter[ 'todo' ] ).toBe( '_Claude/logs/x/todo.html' );
		expect( html ).not.toContain( 'data-kcd-field="todo" data-kcd-type="address" href=' );
	} );

	it( 'never mints a key the source frontmatter did not carry', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		expect( html ).not.toContain( 'data-kcd-field="author"' );
		expect( html ).not.toContain( 'data-kcd-field="origin"' );
	} );
} );

/**
 * The two-tier stylesheet contract — protocol §8.1, amended 2026-08-17.
 *
 * This block exists because the previous ruling had NO detector, and on 2026-08-17 a session reversed
 * it in good faith: it read `KcdEmit`'s own comment ( which recorded the superseded reasoning ) plus a
 * plan Open Question calling the absolute href a defect, and never opened §8.1. Nothing objected,
 * because nothing asserted the rule. A settled ruling with no case behind it is one confident session
 * away from being undone — so every clause of the amended rule gets a case here.
 */
describe( 'KcdEmit — the two-tier stylesheet ( §8.1 )', () => {

	it( 'emits the inline baseline in every document', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact, '../kcd.css' );
		expect( html ).toContain( '<style>' );
		expect( html ).toContain( 'background:#0d0d1c' );
		expect( html ).toContain( 'color:#e6e6f2' );
	} );

	/**
	 * THE ONE THAT MATTERS. Both tiers set `body` at identical specificity, so the LATER declaration
	 * wins. Baseline first, link second ⇒ kcd.css overrides. Reversed, nine lines silently beat the
	 * real stylesheet in every browser and the page still looks fine — the failure is invisible by
	 * construction, which is exactly why it needs an assertion rather than an eyeball.
	 */
	it( 'puts the baseline BEFORE the link, so the real stylesheet wins the cascade', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact, '../../kcd.css' );
		expect( html.indexOf( '<style>' ) ).toBeLessThan( html.indexOf( '<link rel="stylesheet"' ) );
	} );

	// A baseline that grows into a second design language is the failure this tier exists to avoid,
	// and prose in §8.1 cannot stop it. Ten lines is the stated ceiling; assert it.
	it( 'keeps the baseline under ten lines', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html  = KcdEmit.emit( artifact, 'kcd.css' );
		const block = html.slice( html.indexOf( '<style>' ), html.indexOf( '</style>' ) );
		expect( block.split( '\n' ).filter( l => l.trim() ).length ).toBeLessThanOrEqual( 10 );
	} );

	it( 'emits the tier-2 href exactly as given', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		expect( KcdEmit.emit( artifact, '../../kcd.css' ) ).toContain( '<link rel="stylesheet" href="../../kcd.css">' );
		expect( KcdEmit.emit( artifact ) ).toContain( '<link rel="stylesheet" href="kcd.css">' );
	} );

	it( 'never emits a machine-bound href', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		expect( KcdEmit.emit( artifact, KcdEmit.cssHrefFor( 'references/patterns/x.html' ) ) ).not.toContain( 'file:///' );
	} );
} );

describe( 'KcdEmit.cssHrefFor — the one copy of the depth math', () => {

	it( 'walks up one level per directory below the vault root', () => {
		expect( KcdEmit.cssHrefFor( 'nav-index.html' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssHrefFor( 'plans/daedalus-integrity.html' ) ).toBe( '../kcd.css' );
		expect( KcdEmit.cssHrefFor( 'references/patterns/two-facts-one-value.html' ) ).toBe( '../../kcd.css' );
		expect( KcdEmit.cssHrefFor( 'lenses/driver/context/notes.html' ) ).toBe( '../../../kcd.css' );
	} );

	// The corpus is the fixture: hand-authored documents already carry the relative form, so the tool's
	// output and a human's must be the same string or one of them is wrong.
	it( 'matches what hand-authored documents in this corpus carry', () => {
		expect( KcdEmit.cssHrefFor( 'habits/unslotted/index-format.html' ) ).toBe( '../../kcd.css' );
	} );

	/**
	 * A pre-2026-07-26 vault keeps the stylesheet at `kcd/kcd.css`. Mockingjay is a live instance and
	 * every document there already links `../../kcd/kcd.css` — correctly. Assuming the vault root
	 * would emit a confidently broken link into every document of that vault.
	 */
	it( 'honours a stylesheet that does not sit at the vault root', () => {
		expect( KcdEmit.cssHrefFor( 'nav-index.html', 'kcd/kcd.css' ) ).toBe( 'kcd/kcd.css' );
		expect( KcdEmit.cssHrefFor( 'contracts/plan.html', 'kcd/kcd.css' ) ).toBe( '../kcd/kcd.css' );
		expect( KcdEmit.cssHrefFor( 'lenses/front_end/front_end.html', 'kcd/kcd.css' ) ).toBe( '../../kcd/kcd.css' );
	} );

	it( 'normalizes separators and stray prefixes rather than emitting them', () => {
		expect( KcdEmit.cssHrefFor( 'references\\patterns\\x.html' ) ).toBe( '../../kcd.css' );
		expect( KcdEmit.cssHrefFor( './references/patterns/x.html' ) ).toBe( '../../kcd.css' );
		expect( KcdEmit.cssHrefFor( 'contracts/plan.html', '/kcd.css' ) ).toBe( '../kcd.css' );
	} );

	it( 'degrades to the default location rather than guessing a depth', () => {
		expect( KcdEmit.cssHrefFor( '' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssHrefFor( 'x.html' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssHrefFor( 'contracts/plan.html', '' ) ).toBe( '../kcd.css' );
	} );
} );

describe( 'KcdEmit.cssTargetFrom — the inverse, so a MOVE can re-express a link', () => {

	it( 'recovers the target by stripping the depth padding', () => {
		expect( KcdEmit.cssTargetFrom( 'kcd.css' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssTargetFrom( '../kcd.css' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssTargetFrom( '../../../kcd.css' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssTargetFrom( '../../kcd/kcd.css' ) ).toBe( 'kcd/kcd.css' );
	} );

	// The property that makes the pair usable: whatever depth a document was written for, round-tripping
	// its href through both functions lands on the href its CURRENT location deserves.
	it( 'round-trips with cssHrefFor for any depth', () => {
		for ( const doc of [ 'nav-index.html', 'plans/x.html', 'lenses/driver/context/n.html' ] ) {
			for ( const css of [ 'kcd.css', 'kcd/kcd.css' ] ) {
				const href = KcdEmit.cssHrefFor( doc, css );
				expect( KcdEmit.cssHrefFor( doc, KcdEmit.cssTargetFrom( href )! ) ).toBe( href );
			}
		}
	} );

	/**
	 * SELF-HEALING IS THE POINT, not a side effect. A document moved to a new depth carries an href that
	 * is wrong for where it now sits; the target it names is still right. Re-expressing therefore fixes
	 * the link rather than faithfully carrying the error along — which is exactly the defect found on
	 * 2026-08-19, where a promoted plan kept three `../` at two levels deep and rendered unstyled.
	 */
	it( 'recovers the right target from an href that was already wrong for its location', () => {
		const stale = '../../../kcd.css';                              // written at depth 3
		expect( KcdEmit.cssHrefFor( 'plans/capability/x.html', KcdEmit.cssTargetFrom( stale )! ) ).toBe( '../../kcd.css' );
	} );

	/**
	 * A protocol URL is the RETIRED absolute form ( protocol §8.1 amended it away on 2026-08-17 ) and a
	 * root-absolute path is a hand edit. Both are a different repair with a ruling behind them, so a mover
	 * declines rather than deciding on its own authority. `fixStylesheetLinks` is the verb that owns them.
	 */
	it( 'declines anything that is not a plain relative reference', () => {
		expect( KcdEmit.cssTargetFrom( 'file:///C:/vault/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( 'https://example.com/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '../../' ) ).toBeNull();
	} );
} );
