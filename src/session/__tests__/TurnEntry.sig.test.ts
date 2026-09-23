import { describe, it, expect } from 'vitest';
import { frameSig, projectSig } from '../TurnEntry';

/**
 * THE `.sig` PROJECTION, and the split between it and its frame.
 *
 * `projectSig` was carved out of `frameSig` on 2026-09-22 so the agent's own read path could reach the same
 * body the context gutter already got ( `sm_file.read` ). Two things have to stay true and neither is
 * visible from one side alone: the projection answers WHY it declined, because a caller words "not JSON"
 * and "a schema I do not speak" differently and both must keep the bytes; and the gutter's framing did not
 * move while the body was lifted out from under it.
 */

const graph = ( over: Record<string, unknown> = {} ): string => JSON.stringify( {
	schema: 'insight/1',
	nodes:  [
		{ id: 'n1', type: 'claim', title: 'Reach is the fourth axis', layout: { x: 401, y: 474, w: 200, h: 96, shape: 'ellipse' } },
		{ id: 'n2', type: 'risk',  title: 'Habituation',              layout: { x: 701, y: 505, w: 200, h: 96, shape: 'ellipse' } },
	],
	edges:  [ { id: 'e1', from: 'n1', to: 'n2', rel: 'guards against', style: 'curved', headTo: 'square' } ],
	...over,
} );

describe( 'projectSig — the lean view of an insight graph', () => {

	it( 'flattens nodes and edges and keeps no geometry at all', () => {
		const seen = projectSig( graph() );
		expect( seen.ok ).toBe( true );
		if( !seen.ok ) return;

		expect( seen ).toMatchObject( { nodes: 2, edges: 1 } );
		expect( seen.body ).toBe(
			'- (claim) Reach is the fourth axis\n'
			+ '- (risk) Habituation\n'
			+ '- Reach is the fourth axis --[guards against]--> Habituation'
		);
		// THE WHOLE POINT, asserted rather than assumed: every drawing VALUE is gone. Asserted on the values
		// rather than the field names, because `x` / `y` / `w` / `h` are single letters that occur in
		// ordinary English — an assertion on those names passes or fails on the prose, not on the geometry.
		for( const drawn of [ '401', '474', '200', '96', 'ellipse', 'curved', 'square', 'layout' ] ) {
			expect( seen.body ).not.toContain( drawn );
		}
	} );

	it( 'names a colliding label by id, and leaves a unique one bare', () => {
		// Ids are the document's plumbing and mean nothing to a reader — but a duplicate title makes an edge
		// ambiguous, so the cost is paid on the rows that need it and nowhere else.
		const seen = projectSig( JSON.stringify( {
			schema: 'insight/1',
			nodes:  [ { id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }, { id: 'c', title: 'Other' } ],
			edges:  [],
		} ) );
		if( !seen.ok ) throw new Error( 'expected a projection' );
		expect( seen.body ).toContain( 'Same (a)' );
		expect( seen.body ).toContain( 'Same (b)' );
		expect( seen.body ).toContain( '- (node) Other' );
		expect( seen.body ).not.toContain( 'Other (c)' );
	} );

	it( 'reports a graph with nothing in it as projected-and-empty, not as a failure', () => {
		const seen = projectSig( JSON.stringify( { schema: 'insight/1', nodes: [], edges: [] } ) );
		expect( seen ).toEqual( { ok: true, nodes: 0, edges: 0, body: '' } );
	} );

	/**
	 * THE TWO DECLINES ARE DIFFERENT FACTS and every caller words them apart, which is why the cause travels
	 * instead of collapsing into a null. A file that is not JSON is just a file. A file that IS an insight
	 * document of a schema we do not speak has to keep its bytes AND say so, because a projection built on
	 * moved field names returns a confidently empty graph — a document that looks like it says nothing.
	 */
	it( 'declines a non-JSON body and a foreign schema for different stated reasons', () => {
		expect( projectSig( 'plainly not json' ) ).toEqual( { ok: false, why: 'not-json' } );
		expect( projectSig( '{"schema":"insight/2"}' ) ).toEqual( { ok: false, why: 'schema', schema: 'insight/2' } );
		expect( projectSig( '{"nodes":[]}' ) ).toEqual( { ok: false, why: 'schema', schema: 'absent' } );
	} );
} );

describe( 'frameSig — the gutter framing over that body', () => {

	it( 'frames a projection with its counts', () => {
		expect( frameSig( 'notes.sig', graph() ) ).toBe(
			'[injected insight graph — notes.sig — 2 nodes, 1 edges; layout stripped]\n'
			+ '- (claim) Reach is the fourth axis\n'
			+ '- (risk) Habituation\n'
			+ '- Reach is the fourth axis --[guards against]--> Habituation'
		);
	} );

	it( 'keeps every byte when it cannot project, and says which reason applies', () => {
		const foreign = '{"schema":"insight/2","nodes":[{"id":"n1"}]}';
		const framed  = frameSig( 'notes.sig', foreign );
		expect( framed ).toContain( 'insight schema insight/2 is not insight/1' );
		expect( framed ).toContain( foreign );                 // the bytes survive, which is the safe direction

		// Not JSON at all falls back to the ORDINARY file frame — it was never an insight document, so
		// explaining insight schemas to the model would be noise about a file that is just a file.
		expect( frameSig( 'notes.sig', 'hello' ) ).toBe( '[injected file — notes.sig]\nhello' );
	} );

	it( 'says empty rather than framing a blank body', () => {
		expect( frameSig( 'notes.sig', JSON.stringify( { schema: 'insight/1', nodes: [], edges: [] } ) ) )
			.toBe( '[injected insight graph — notes.sig — empty: no nodes, no edges]' );
	} );
} );
