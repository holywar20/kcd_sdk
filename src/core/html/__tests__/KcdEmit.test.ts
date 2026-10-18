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
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html = KcdEmit.emit( artifact );
		const report = KcdValidate.validate( html , { docRoot: '_Claude' });
		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );

	// NOT byte-for-byte: spliceFrontmatter re-parses and re-serializes the body, so what survives is content and
	// structure, never the source's exact whitespace.
	it( 'edited frontmatter rides through; untouched body content survives', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const edited = { ...artifact, frontmatter: { ...artifact.frontmatter, status: 'draft' } };

		const html = KcdEmit.emit( edited );
		const reparsed = KcdParse.parse( html, 'fixture.html' , '_Claude');

		expect( reparsed.frontmatter[ 'status' ] ).toBe( 'draft' );
		expect( reparsed.frontmatter[ 'name' ] ).toBe( 'emit-fixture' );
		expect( reparsed.frontmatter[ 'tags' ] ).toEqual( [ 'alpha', 'beta' ] );
		expect( reparsed.body ).toContain( 'Some prose that must survive the round trip untouched.' );
	} );

	// An address field carries its value as TEXT, never as a link: an address asserts no occupancy (KcdAddress.fieldValue). The round trip is the guard.
	it( 'an address field round-trips as a real value, and never as a link', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html = KcdEmit.emit( artifact );
		const reparsed = KcdParse.parse( html, 'fixture.html' , '_Claude');
		expect( reparsed.frontmatter[ 'todo' ] ).toBe( '_Claude/logs/x/todo.html' );
		expect( html ).not.toContain( 'data-kcd-field="todo" data-kcd-type="address" href=' );
	} );

	it( 'never mints a key the source frontmatter did not carry', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html = KcdEmit.emit( artifact );
		expect( html ).not.toContain( 'data-kcd-field="author"' );
		expect( html ).not.toContain( 'data-kcd-field="origin"' );
	} );
} );

/**
 * The two-tier stylesheet contract (protocol §8.1). Every clause of the rule has a case here, because a rule
 * with no case behind it is one confident session away from being undone.
 */
describe( 'KcdEmit — the two-tier stylesheet ( §8.1 )', () => {

	it( 'emits the inline baseline in every document', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html = KcdEmit.emit( artifact, '../kcd.css' );
		expect( html ).toContain( '<style>' );
		expect( html ).toContain( 'background:#0d0d1c' );
		expect( html ).toContain( 'color:#e6e6f2' );
	} );

	/**
	 * Both tiers set `body` at identical specificity, so the later declaration wins. Baseline first, link second:
	 * a reversed order would let the baseline beat the real stylesheet in every browser, invisibly.
	 */
	it( 'puts the baseline BEFORE the link, so the real stylesheet wins the cascade', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html = KcdEmit.emit( artifact, '../../kcd.css' );
		expect( html.indexOf( '<style>' ) ).toBeLessThan( html.indexOf( '<link rel="stylesheet"' ) );
	} );

	// A baseline that grows into a second design language is the failure this tier exists to avoid,
	// and prose in §8.1 cannot stop it. Ten lines is the stated ceiling; assert it.
	it( 'keeps the baseline under ten lines', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		const html  = KcdEmit.emit( artifact, 'kcd.css' );
		const block = html.slice( html.indexOf( '<style>' ), html.indexOf( '</style>' ) );
		expect( block.split( '\n' ).filter( l => l.trim() ).length ).toBeLessThanOrEqual( 10 );
	} );

	it( 'emits the tier-2 href exactly as given', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		expect( KcdEmit.emit( artifact, '../../kcd.css' ) ).toContain( '<link rel="stylesheet" href="../../kcd.css">' );
		expect( KcdEmit.emit( artifact ) ).toContain( '<link rel="stylesheet" href="kcd.css">' );
	} );

	it( 'never emits a machine-bound href', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' , '_Claude');
		expect( KcdEmit.emit( artifact, KcdEmit.cssHrefFor( 'references/patterns/x.html' ) ) ).not.toContain( 'file:///' );
	} );
} );

describe( 'KcdEmit.cssHrefFor — the one copy of the depth math', () => {

	it( 'walks up one level per directory below the vault root', () => {
		expect( KcdEmit.cssHrefFor( 'nav-index.html' ) ).toBe( 'kcd.css' );
		expect( KcdEmit.cssHrefFor( 'plans/vault-integrity.html' ) ).toBe( '../kcd.css' );
		expect( KcdEmit.cssHrefFor( 'references/patterns/two-facts-one-value.html' ) ).toBe( '../../kcd.css' );
		expect( KcdEmit.cssHrefFor( 'lenses/driver/context/notes.html' ) ).toBe( '../../../kcd.css' );
	} );

	// The corpus is the fixture: hand-authored documents already carry the relative form, so the tool's
	// output and a human's must be the same string or one of them is wrong.
	it( 'matches what hand-authored documents in this corpus carry', () => {
		expect( KcdEmit.cssHrefFor( 'habits/unslotted/index-format.html' ) ).toBe( '../../kcd.css' );
	} );

	/** A vault may keep its stylesheet below the root (`kcd/kcd.css`); assuming the root would emit a broken link into every document. */
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

	/** Self-healing is the point: a moved document's href is wrong for its new depth, but the target it names is still right. */
	it( 'recovers the right target from an href that was already wrong for its location', () => {
		const stale = '../../../kcd.css';                              // written at depth 3
		expect( KcdEmit.cssHrefFor( 'plans/capability/x.html', KcdEmit.cssTargetFrom( stale )! ) ).toBe( '../../kcd.css' );
	} );

	/**
	 * A protocol URL or a root-absolute path is a different repair with its own ruling, so a mover declines it.
	 * Nothing else repairs it: the href stays as it is until a person or a re-emit changes it.
	 */
	it( 'declines anything that is not a plain relative reference', () => {
		expect( KcdEmit.cssTargetFrom( 'file:///C:/vault/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( 'https://example.com/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '/kcd.css' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '' ) ).toBeNull();
		expect( KcdEmit.cssTargetFrom( '../../' ) ).toBeNull();
	} );
} );
