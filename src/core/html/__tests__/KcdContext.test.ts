import { describe, it, expect } from 'vitest';
import { KcdParse } from '../KcdParse';
import { KcdContext } from '../KcdContext';

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">context-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture used only by KcdContext's tests.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
<dt>author</dt><dd data-kcd-field="author" data-kcd-type="text">Someone &lt;someone@example.com&gt;</dd>
<dt>schema-version</dt><dd data-kcd-field="schema-version" data-kcd-type="text">0.1</dd>
</dl>
<h1>Fixture</h1>
<p>Prose that must survive as plain text.</p>
<p data-kcd-audience="human">This paragraph is human-only and must never reach the model.</p>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-table>
<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>
<div data-kcd-slot data-kcd-mode="suggested">
<span data-kcd-field="what" data-kcd-type="text">A reference</span>
<a data-kcd-field="where" data-kcd-type="path" href="_Claude/references/x.html">x</a>
<span data-kcd-field="why" data-kcd-type="text">Because it matters.</span>
</div>
</div>
</section>
</section>
</article>
</body>
</html>
`;

describe( 'KcdContext — AI-audience projection', () => {
	it( 'strips all tags and chrome', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out ).not.toContain( '<' );
		expect( out ).not.toContain( '>' );
	} );

	it( 'keeps prose but drops data-kcd-audience="human" content entirely', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out ).toContain( 'Prose that must survive as plain text.' );
		expect( out ).not.toContain( 'human-only' );
	} );

	it( 'reduces frontmatter to the keep-set — name/description/status survive, author/schema-version do not', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out ).toContain( 'name: context-fixture' );
		expect( out ).toContain( 'description: A fixture used only by KcdContext' );
		expect( out ).toContain( 'status: active' );
		expect( out ).not.toContain( 'someone@example.com' );
		expect( out ).not.toContain( 'schema-version' );
	} );

	it( 'renders a dredge/slot row as one tight "what — why (where)" line, route preserved', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out ).toContain( 'A reference — Because it matters. (_Claude/references/x.html)' );
	} );

	it( 'renderRow produces the exact same line slotLine embeds — one render path, not two shapes', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		const rendered = KcdContext.renderRow( { what: 'A reference', where: '_Claude/references/x.html', why: 'Because it matters.' } );
		expect( out ).toContain( rendered );
	} );

	it( 'drops the data-kcd-head table-header row — visual-only chrome, not content', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out ).not.toMatch( /^What$/m );
		expect( out ).not.toMatch( /^Where$/m );
	} );

	it( 'leads with a "# [type] path" header', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const out = KcdContext.project( artifact );
		expect( out.split( '\n' )[ 0 ] ).toBe( '# [lens] fixture.html' );
	} );
} );

const LENS_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Lens Fixture</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">region-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for region-block decomposition.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Region Fixture</h1>
<p>The lens's own identity lede — unregioned, top-level.</p>
<section data-kcd-region="know">
<h2>Know</h2>
<p>The Know region's own intro paragraph, before its first named section.</p>
<section data-kcd-section="references">
<div data-kcd-slot><span data-kcd-field="what" data-kcd-type="text">A ref</span><a data-kcd-field="where" data-kcd-type="path" href="x.html">x</a><span data-kcd-field="why" data-kcd-type="text">reasons</span></div>
</section>
</section>
<section data-kcd-region="care">
<section data-kcd-section="purpose">
<p>This lens exists to test region decomposition.</p>
</section>
</section>
<section data-kcd-region="do">
<section data-kcd-section="habits" data-kcd-merge-key="habits-table">
<p>Habit A applies.</p>
</section>
</section>
</article>
</body>
</html>
`;

const REFERENCE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Reference Fixture</title></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">plain-reference</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A plain reference fixture with no region wrapper.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Plain Reference</h1>
<section data-kcd-section="overview">
<p>No region wrapper — a plain reference never carries one.</p>
</section>
<section data-kcd-section="references" data-kcd-merge-key="shared-refs">
<p>One shared reference row.</p>
</section>
</article>
</body>
</html>
`;

describe( 'KcdContext.projectBlocks — region-block decomposition (Phase 2)', () => {
	it( 'tags a lens\'s unregioned lede as `care`, and its named sections by their enclosing data-kcd-region', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );

		const lede = blocks.find( b => b.section === null && b.text.includes( 'identity lede' ) );
		expect( lede?.region ).toBe( 'care' );

		const refs = blocks.find( b => b.section === 'references' );
		expect( refs?.region ).toBe( 'know' );

		const purpose = blocks.find( b => b.section === 'purpose' );
		expect( purpose?.region ).toBe( 'care' );

		const habits = blocks.find( b => b.section === 'habits' );
		expect( habits?.region ).toBe( 'do' );
		expect( habits?.mergeKey ).toBe( 'habits-table' );
	} );

	it( 'tags a region\'s own intro paragraph ( before its first named section ) with THAT region, not the artifact-level care lede', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		const intro = blocks.find( b => b.section === null && b.text.includes( 'Know region\'s own intro' ) );
		expect( intro?.region ).toBe( 'know' );
	} );

	it( 'never emits the Know/Care/Do region-label heading — the region sorts the build for us, it never names itself to the agent', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const knowLabel = /^#+\s+Know\s*$/m;
		// Both render paths drop it: the flat single-string projection and the block ( wire ) projection.
		expect( KcdContext.project( artifact ) ).not.toMatch( knowLabel );
		const joined = KcdContext.projectBlocks( artifact, 'know' ).map( b => b.text ).join( '\n' );
		expect( joined ).not.toMatch( knowLabel );
		// The region's real content — its intro and its section rows — is untouched.
		expect( joined ).toContain( 'Know region\'s own intro' );
		expect( joined ).toContain( 'A ref — reasons (x.html)' );
	} );

	it( 'gives the head (type/path header + frontmatter) its own leading block, tagged `care` for a lens', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		expect( blocks[ 0 ].region ).toBe( 'care' );
		expect( blocks[ 0 ].text ).toContain( 'name: region-fixture' );
	} );

	it( 'defaults every block of a non-lens artifact to the caller-supplied role — a habit-role artifact defaults to `do`', () => {
		const artifact = KcdParse.parse( REFERENCE_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'do' );
		expect( blocks.every( b => b.region === 'do' ) ).toBe( true );
	} );

	it( 'defaults a reference-role artifact to `know` and carries its data-kcd-merge-key through untouched', () => {
		const artifact = KcdParse.parse( REFERENCE_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		const overview = blocks.find( b => b.section === 'overview' );
		expect( overview?.region ).toBe( 'know' );
		expect( overview?.mergeKey ).toBeNull();

		const shared = blocks.find( b => b.section === 'references' );
		expect( shared?.mergeKey ).toBe( 'shared-refs' );
	} );

	it( 'a References section carries its rows as STRUCTURED data too — not just rendered into `text`', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		const refs = blocks.find( b => b.section === 'references' )!;
		expect( refs.rows ).toEqual( [ { what: 'A ref', where: 'x.html', why: 'reasons' } ] );
	} );

	it( 'a block with no data-kcd-slot rows carries no `rows` at all — not an empty array, genuinely absent', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		const purpose = blocks.find( b => b.section === 'purpose' )!;
		expect( purpose.rows ).toBeUndefined();
	} );
} );
