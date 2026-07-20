import { describe, it, expect } from 'vitest';
import { KcdParse } from '../KcdParse';
import { KcdContext } from '../KcdContext';
import { HtmlTree } from '../HtmlTree';

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
<div data-kcd-slot="reference" data-kcd-mode="suggested">
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

	it( 'preserves the significant space between two inline elements — no "canonical:_Claude" welding', () => {
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>WS</title></head><body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">ws</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">d</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<p><strong>kcd is canonical:</strong> <code>_Claude/kcd/</code> is the source.</p>
</article>
</body></html>`;
		const out = KcdContext.project( KcdParse.parse( html, 'ws.html' ) );
		expect( out ).toContain( 'kcd is canonical: _Claude/kcd/ is the source.' );
		expect( out ).not.toContain( 'canonical:_Claude' );
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
<div data-kcd-slot="reference"><span data-kcd-field="what" data-kcd-type="text">A ref</span><a data-kcd-field="where" data-kcd-type="path" href="x.html">x</a><span data-kcd-field="why" data-kcd-type="text">reasons</span></div>
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

	it( 'emits NO synthetic head block on the wire — identity ( name/path ) rides once in the compiled manifest, not per artifact', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		const blocks = KcdContext.projectBlocks( artifact, 'know' );
		// No block carries the `# [type] path` header or the frontmatter keep-set anymore.
		expect( blocks.some( b => b.text.includes( '# [lens]' ) ) ).toBe( false );
		expect( blocks.some( b => b.text.includes( 'name: region-fixture' ) ) ).toBe( false );
		// The first block is now the artifact's real lede ( still tagged `care` for a lens ), not the head.
		expect( blocks[ 0 ].region ).toBe( 'care' );
		expect( blocks[ 0 ].text ).toContain( 'identity lede' );
	} );

	it( 'the flat project() still leads with the head — that path feeds the Atlas human preview, not the wire', () => {
		const artifact = KcdParse.parse( LENS_FIXTURE, 'fixture.html' );
		expect( KcdContext.project( artifact ).split( '\n' )[ 0 ] ).toBe( '# [lens] fixture.html' );
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

// A lens whose Do region carries a Tools section: three explicitly-stamped tool slots ( on / suggested /
// off ) plus one BARE slot ( no data-kcd-slot value ) that must still resolve to `tool` by position.
const TOOLS_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tools Fixture</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">tools-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for tool-kind slot handling.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Tools Fixture</h1>
<p>The lens's own identity lede.</p>
<section data-kcd-region="care">
<section data-kcd-section="purpose"><p>Exists to test tool-kind slot handling.</p></section>
</section>
<section data-kcd-region="do">
<section data-kcd-section="tools">
<div data-kcd-table>
<div data-kcd-head><span>Tool</span><span>Mode</span></div>
<div data-kcd-slot="tool" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">recall</span><span data-kcd-field="why" data-kcd-type="text">on</span></div>
<div data-kcd-slot="tool" data-kcd-mode="suggested"><span data-kcd-field="what" data-kcd-type="text">learn</span><span data-kcd-field="why" data-kcd-type="text">suggested</span></div>
<div data-kcd-slot="tool" data-kcd-mode="off"><span data-kcd-field="what" data-kcd-type="text">grep</span><span data-kcd-field="why" data-kcd-type="text">off</span></div>
<div data-kcd-slot data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">write</span><span data-kcd-field="why" data-kcd-type="text">on</span></div>
</div>
</section>
</section>
</article>
</body>
</html>
`;

// NOTE: this fixture keeps ONE deliberately-bare slot ( `write` ) to prove the parser still INFERS a
// slot's kind by position ( `inferSlotKind`, live by design ). A bare slot is invalid per the validator
// now, so these tests build through `KcdParse.build( HtmlTree.parse( … ) )` — the non-validating assembly
// path — rather than `KcdParse.parse`, which would reject the doc at the gate. Inference is a parser
// resilience feature; validity is a separate, stricter contract.
describe( 'KcdParse / KcdContext — tool-kind slots ( explicit data-kcd-slot="tool" + bare-slot fallback )', () => {
	it( 'toolModes keys on the KIND, not the section name — explicit `tool` slots AND a bare tools-section slot both resolve; mode `off` drops out', () => {
		const artifact = KcdParse.build( HtmlTree.parse( TOOLS_FIXTURE ), 'tools.html' );
		expect( artifact.toolModes ).toEqual( { recall: 'on', learn: 'suggested', write: 'on' } );
		// grep is mode `off` → contributes nothing.
		expect( artifact.toolModes.grep ).toBeUndefined();
	} );

	it( 'a bare slot in a tools section infers kind `tool` by position; an explicit stamp is read verbatim', () => {
		const artifact = KcdParse.build( HtmlTree.parse( TOOLS_FIXTURE ), 'tools.html' );
		const byName = ( n: string ) => artifact.slots.find( s => s.what === n )!;
		expect( byName( 'recall' ).kind ).toBe( 'tool' );   // explicit
		expect( byName( 'write' ).kind ).toBe( 'tool' );    // inferred from the tools section
	} );

	it( 'a tool slot is metadata — it never renders into the compiled body ( the Tools-in-Knowledge leak, closed )', () => {
		const artifact = KcdParse.build( HtmlTree.parse( TOOLS_FIXTURE ), 'tools.html' );
		const wire = KcdContext.projectBlocks( artifact, 'know' ).map( b => b.text ).join( '\n' );
		expect( wire ).not.toContain( 'recall' );
		expect( wire ).not.toContain( '— on' );           // the "recall — on" slot-line shape must be absent
		expect( wire ).not.toMatch( /#+\s+Tools/ );         // and no bare Tools heading either
		// The all-tool section renders to empty text, so no block survives for it.
		expect( KcdContext.projectBlocks( artifact, 'know' ).some( b => b.section === 'tools' ) ).toBe( false );
	} );

	it( 'the flat human preview drops tool slots too ( same block() render gate )', () => {
		const artifact = KcdParse.build( HtmlTree.parse( TOOLS_FIXTURE ), 'tools.html' );
		expect( KcdContext.project( artifact ) ).not.toContain( 'recall' );
	} );
} );
