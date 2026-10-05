import { describe, it, expect } from 'vitest'
import '../../primitives/index'   // registers each type's fromSerialized hydrator — a node must come back its real subclass
import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'
import type { ReaderFn, TaggedBlock } from '../../primitives/types'

/**
 * One artifact contributes once ( bug-report-26 ), on BOTH the axes that can duplicate it.
 *
 * The defect: `dedupeBySource` ranked by `sourceLayer` and kept every block tied for the best rank, but
 * every lens tags its blocks `lens` — so a reference three stacked lenses each load arrived as three
 * same-path, same-rank blocks, all tied, all kept.
 *
 * The two axes are settled in different places, and deliberately. ACROSS LAYERS is `dedupeBySource`, on a
 * flat block list. ACROSS SIBLING LENSES is `getContextBlocks`, which claims a path per LENS — the last
 * point where the lens boundary is still visible. Downstream, one artifact's several regions and several
 * lenses' copies of one region are the same shape, so the sibling case cannot be answered there without
 * costing real content. Both are pinned so a later fix to either cannot quietly undo the other.
 */

const ROOT = '/vault/_Claude'
const REF  = `${ ROOT }/references/js-style-guide.html`

const block = ( over: Partial<TaggedBlock> = {} ): TaggedBlock => ( {
	region:       'know',
	section:      'rules',
	mergeKey:     null,
	text:         'Two spaces, never tabs.',
	sourceLayer:  'lens',
	path:         REF,
	artifactType: 'reference',
	habitClass:   null,
	...over,
} )

/** A lens carrying the given reference nodes outright — `fromSerialized` takes them as authored, so no
 *  reader and no dredge policy stands between the fixture and the thing under test. */
function lensLoading( name: string, refs: { path: string; body: string }[] ): LensObject {
	return LensObject.fromSerialized( {
		path:        `${ ROOT }/lenses/${ name }/${ name }.html`,
		type:        'lens',
		frontmatter: { type: 'lens', name },
		sections:    { Know: '', Care: '', Do: '' },
		body:        '<section data-kcd-section="personality"><p>Fixture.</p></section>',
		links:       [],
		policy:      [],
		nodes:       refs.map( ( r ) => ( {
			path:        r.path,
			type:        'reference',
			frontmatter: { type: 'reference', name: r.path.split( '/' ).pop()!.replace( '.html', '' ) },
			sections:    {},
			body:        r.body,
			links:       [],
			policy:      [],
		} ) ),
	} as never )
}

/** Two sections, so the several-regions case is exercised by a real artifact rather than a hand-rolled pair. */
const STYLE_GUIDE = {
	path: REF,
	body: '<section data-kcd-section="rules"><p>STYLE-GUIDE-RULES</p></section>'
		+ '<section data-kcd-section="exceptions"><p>STYLE-GUIDE-EXCEPTIONS</p></section>',
}

const TS_GUIDE = {
	path: `${ ROOT }/references/ts-style-guide.html`,
	body: '<section data-kcd-section="rules"><p>TS-GUIDE-RULES</p></section>',
}

describe( 'Agent.dedupeBySource — the layer axis, which is all it owns', () => {

	it( 'keeps the most-specific layer and drops every block of the losing one', () => {
		const kept = Agent.dedupeBySource( [
			block( { sourceLayer: 'lens', text: 'from the lens' } ),
			block( { sourceLayer: 'agent', text: 'from the agent' } ),
		] )

		expect( kept ).toHaveLength( 1 )
		expect( kept[ 0 ]!.sourceLayer ).toBe( 'agent' )
	} )

	it( 'ranks an injected node above an agent one — the session-dropped copy is the most specific of all', () => {
		const kept = Agent.dedupeBySource( [
			block( { sourceLayer: 'agent' } ),
			block( { sourceLayer: 'injected' } ),
		] )

		expect( kept.map( ( b ) => b.sourceLayer ) ).toEqual( [ 'injected' ] )
	} )

	it( 'keeps one artifact\'s several regions — same path, same rank, all legitimate', () => {
		const kept = Agent.dedupeBySource( [
			block( { region: 'care', section: 'purpose' } ),
			block( { region: 'know', section: 'rules' } ),
			block( { region: 'know', section: 'exceptions' } ),
		] )

		expect( kept.map( ( b ) => b.section ) ).toEqual( [ 'purpose', 'rules', 'exceptions' ] )
	} )

	it( 'leaves two genuinely different artifacts alone', () => {
		const kept = Agent.dedupeBySource( [
			block( { path: REF } ),
			block( { path: `${ ROOT }/references/ts-style-guide.html` } ),
		] )

		expect( kept ).toHaveLength( 2 )
	} )
} )

describe( 'Agent.getContextBlocks — the sibling-lens axis', () => {

	/** The reported shape: Churchill's driver / mcp / model-manager each load `js-style-guide`. */
	const churchill = (): Agent => Agent.create( { lenses: [
		lensLoading( 'driver', [ STYLE_GUIDE ] ),
		lensLoading( 'mcp', [ STYLE_GUIDE ] ),
		lensLoading( 'model-manager', [ STYLE_GUIDE ] ),
	] } )

	it( 'contributes a shared reference once, however many lenses load it', () => {
		const paths = churchill().getContextBlocks().map( ( b ) => b.path ).filter( ( p ) => p === REF )

		// One entry per SECTION of the one surviving copy — never one per lens.
		expect( new Set( paths ).size ).toBe( 1 )
		expect( paths ).toHaveLength( 2 )
	} )

	it( 'rides each of its sections once in the compiled context, not once per lens', () => {
		const text = churchill().compile()

		expect( text.split( 'STYLE-GUIDE-RULES' ).length - 1 ).toBe( 1 )
		expect( text.split( 'STYLE-GUIDE-EXCEPTIONS' ).length - 1 ).toBe( 1 )
	} )

	it( 'keeps every region of the surviving copy — claiming is per lens, not per block', () => {
		const sections = churchill().getContextBlocks()
			.filter( ( b ) => b.path === REF )
			.map( ( b ) => b.section )

		expect( sections ).toEqual( [ 'rules', 'exceptions' ] )
	} )

	it( 'the FIRST lens in the stack supplies the surviving copy', () => {
		const agent = Agent.create( { lenses: [
			lensLoading( 'driver', [ STYLE_GUIDE ] ),
			lensLoading( 'mcp', [ { path: REF, body: '<section data-kcd-section="rules"><p>MCP-COPY</p></section>' } ] ),
		] } )
		const text = agent.compile()

		expect( text ).toContain( 'STYLE-GUIDE-RULES' )
		expect( text ).not.toContain( 'MCP-COPY' )
	} )

	it( 'leaves references the lenses do NOT share alone', () => {
		const agent = Agent.create( { lenses: [
			lensLoading( 'driver', [ STYLE_GUIDE ] ),
			lensLoading( 'mcp', [ TS_GUIDE ] ),
		] } )
		const text = agent.compile()

		expect( text ).toContain( 'STYLE-GUIDE-RULES' )
		expect( text ).toContain( 'TS-GUIDE-RULES' )
	} )

	it( 'wears all three lenses regardless — dedup thins the context, never the stack', () => {
		expect( churchill().lenses.map( ( l ) => l.getName() ) ).toEqual( [ 'driver', 'mcp', 'model-manager' ] )
	} )
} )

// ── The mode axis — a CHARACTERISATION test, pinning what happens rather than what ought to ──────────

const MODE_ROOT = 'C:/fixtures/mode-root'
const SHARED    = 'shared-ref.html'

/** One reference slot, at the mode given — the same shape the HTML parser computes policy from. */
const slotRow = ( mode: 'on' | 'load', href: string, what: string, why: string ): string =>
	`<div data-kcd-slot="reference" data-kcd-mode="${ mode }">`
	+ `<span data-kcd-field="what" data-kcd-type="text">${ what }</span>`
	+ `<a data-kcd-field="where" data-kcd-type="path" href="${ href }">${ what }</a>`
	+ `<span data-kcd-field="why" data-kcd-type="text">${ why }</span></div>`

const modeLensHtml = ( name: string, rows: string ): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mode Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture for the mode axis.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>${ name }</h1>
<p>Its identity lede.</p>
<section data-kcd-section="references">
${ rows }
</section>
<section data-kcd-section="personality">
<p>Fixture personality for ${ name }.</p>
</section>
<section data-kcd-section="philosophy">
<p>Fixture philosophy for ${ name }.</p>
</section>
</article>
</body></html>
`

const SHARED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Reference</title></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">shared-ref</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">The reference both lenses name.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-section="rules">
<p>SHARED-REF-BODY</p>
</section>
</article>
</body></html>
`

const MODE_FILES: Record<string, string> = {
	'lens-on.html':   modeLensHtml( 'lens-on', slotRow( 'on', SHARED, 'Shared reference', 'on-mode reason' ) ),
	'lens-load.html': modeLensHtml( 'lens-load', slotRow( 'load', SHARED, 'Shared reference', 'load-mode reason' ) ),
	[ SHARED ]:       SHARED_HTML,
}

const modeRead: ReaderFn = ( absPath ) => {
	const rel = absPath.replace( /\\/g, '/' ).split( '/' ).pop()!
	const content = MODE_FILES[ rel ]
	if ( content === undefined ) throw new Error( `fixture missing: ${ absPath }` )
	return content
}

/** Loaded the way a compile loads one — `eager`, so the dredge actually runs and a `load` slot's body rides. */
const modeLens = ( file: string ): LensObject =>
	LensObject.load( `${ MODE_ROOT }/${ file }`, { projectRoot: MODE_ROOT, read: modeRead, depth: 2, eager: true } )

/**
 * WHAT A SHARED REFERENCE'S MODE DOES WHEN TWO LENSES DISAGREE — pinned as it behaves TODAY.
 *
 * First-in-stack wins the COPY; it does NOT win the MODE. The mechanism is `LensObject.stubBlock`: every
 * `on`-mode row in a lens collapses into ONE synthetic block carrying `path: this.path` — the LENS's path,
 * not the reference's. So a first lens holding X at `on` contributes no block under X's path, claims
 * nothing for X in `Agent.getContextBlocks`, and a second lens's `load` of X still rides in full.
 *
 * RULED NOT WORTH REPAIRING — Bryan, 2026-09-29, closing bug-report-26: the `on`-mode case is cheap enough
 * that chasing it does not pay, and a test case is enough to cover it. The report's Notes sketch a fix
 * ( make the deduped currency the ARTIFACT rather than the block ) which is kept for its reasoning and is
 * explicitly NOT a live direction. So this is documented behaviour, not a bug somebody enshrined — and the
 * point of pinning it is that a future change to `getContextBlocks` or `stubBlock` has to come past here
 * and say so out loud.
 */
describe( 'Agent.getContextBlocks — the mode axis, pinned as-is', () => {

	/** Slash-blind, because the block's path came through `PathText.resolve` and wears the platform's separator. */
	const isShared = ( b: TaggedBlock ): boolean => b.path.replace( /\\/g, '/' ) === `${ MODE_ROOT }/${ SHARED }`

	it( 'a first lens\'s `on` does NOT suppress a later lens\'s `load` — the body still rides', () => {
		const agent = Agent.create( { lenses: [ modeLens( 'lens-on.html' ), modeLens( 'lens-load.html' ) ] } )
		const blocks = agent.getContextBlocks()

		// The `on` lens contributes nothing under the reference's own path, so there is nothing to claim.
		// Every surviving block for that path is the SECOND lens's `load` copy.
		expect( blocks.filter( isShared ) ).toHaveLength( 1 )
		expect( agent.compile().split( 'SHARED-REF-BODY' ).length - 1 ).toBe( 1 )
	} )

	it( 'stack order is not the variable — the mode is invisible to the claim either way round', () => {
		const loadFirst = Agent.create( { lenses: [ modeLens( 'lens-load.html' ), modeLens( 'lens-on.html' ) ] } )

		// Reversed, the `load` lens claims the path first and the `on` lens has nothing to drop. Same result,
		// for a different reason — which is exactly what "first-in-stack wins the copy, not the mode" means.
		expect( loadFirst.getContextBlocks().filter( isShared ) ).toHaveLength( 1 )
		expect( loadFirst.compile().split( 'SHARED-REF-BODY' ).length - 1 ).toBe( 1 )
	} )
} )
