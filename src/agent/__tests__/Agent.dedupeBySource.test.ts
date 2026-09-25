import { describe, it, expect } from 'vitest'
import '../../primitives/index'   // registers each type's fromSerialized hydrator — a node must come back its real subclass
import { Agent } from '../Agent'
import { LensObject } from '../../primitives/framework/LensObject'
import type { TaggedBlock } from '../../primitives/types'

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
