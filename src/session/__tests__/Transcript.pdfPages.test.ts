import { describe, it, expect } from 'vitest';
import { Transcript, PDF_PAGE_IMAGE_PIXELS, PDF_PAGE_IMAGE_MEDIA_TYPE, type TurnEntry, type WireBlock } from '../TurnEntry';

/**
 * A PDF'S PAGES ON THE WIRE — the projection half of moving a TABLE into an agent's context.
 *
 * A table does not exist inside a PDF: there are glyphs at coordinates and the grid is in the reader's eye,
 * so extraction cannot recover one in principle. The page IMAGE can, which is why the `injected-file` case
 * now emits blocks as well as text. These tests pin the four things that distinguish a working feature from
 * one that merely emits something: the ORDER ( frame first, pages after, because a caption read after the
 * thing it qualifies did not work ), the LIVE-TURN-ONLY bargain, the `imagesAsText` degrade, and the PRICE.
 *
 * None of them can be settled by looking at a green suite elsewhere — before this card the `injected-file`
 * case emitted text and nothing else, so every image assertion below had nothing to find.
 */

function pdfEntry( pages: string[] = [], bytes = 4000 ): TurnEntry {
	const entry: TurnEntry = {
		at: 1, kind: 'injected-file', path: 'C:/docs/report.pdf', name: 'report.pdf',
		mediaType: 'application/pdf', bytes
	};
	entry.contents = '[PDF — report.pdf — 3 page( s ), EXTRACTED TEXT AND EVERY PAGE AS AN IMAGE]\nClause one.';
	if ( pages.length ) entry.imageData = pages;
	return entry;
}

/** The live turn carries the PDF — what the orchestrator builds at send time, with main's hydration already on it. */
function injecting( entry: TurnEntry ): Transcript {
	const t = new Transcript();
	const live = t.openTurn( 'turn-1', 0 );
	t.append( entry, live );
	t.append( { at: 1, kind: 'user', text: 'what does the table say' }, live );
	return t;
}

/** The PDF on a PRIOR turn, with an ordinary turn after it. */
function afterInjection( entry: TurnEntry ): Transcript {
	const t = new Transcript();
	const past = t.openTurn( 'turn-1', 0 );
	t.append( entry, past );
	const live = t.openTurn( 'turn-2', 1 );
	t.append( { at: 2, kind: 'user', text: 'and now this' }, live );
	return t;
}

function blocks( t: Transcript, opts?: Parameters<Transcript[ 'wireMessages' ]>[ 0 ] ): WireBlock[] {
	return t.wireMessages( opts ).flatMap( ( m ) => typeof m.content === 'string' ? [] : m.content );
}

describe( 'wireMessages — a PDF projects its framed text and then its pages', () => {

	it( 'emits one IMAGE block per rendered page, AFTER the framed text', () => {
		const out = blocks( injecting( pdfEntry( [ 'PAGE1BYTES', 'PAGE2BYTES', 'PAGE3BYTES' ] ) ) );

		// ORDER IS THE ASSERTION, not mere presence. The frame is what stops the model believing it holds the
		// whole document; a frame read after the pages is a frame that did not do its job. Indices, not a
		// substring search, so a block list that happened to contain both in the wrong order fails.
		const text  = out.findIndex( ( b ) => b.type === 'text' );
		const first = out.findIndex( ( b ) => b.type === 'image' );
		expect( text ).toBeGreaterThanOrEqual( 0 );
		expect( first ).toBeGreaterThan( text );

		const images = out.filter( ( b ) => b.type === 'image' );
		expect( images.length ).toBe( 3 );
		expect( images.map( ( b ) => b.type === 'image' ? b.data : '' ) ).toEqual( [ 'PAGE1BYTES', 'PAGE2BYTES', 'PAGE3BYTES' ] );
	} );

	it( 'labels a page with an IMAGE media type, never the PDF\'s own', () => {
		const images = blocks( injecting( pdfEntry( [ 'PAGE1BYTES' ] ) ) ).filter( ( b ) => b.type === 'image' );

		// The entry's `mediaType` is `application/pdf`, which is true of the file and wrong for every block
		// cut out of it — a provider handed that on an image block rejects the request.
		expect( images[ 0 ] ).toMatchObject( { mediaType: PDF_PAGE_IMAGE_MEDIA_TYPE } );
		expect( PDF_PAGE_IMAGE_MEDIA_TYPE.startsWith( 'image/' ) ).toBe( true );
	} );

	it( 'emits NO image block when the tier cannot carry one ( imagesAsText )', () => {
		const out = blocks( injecting( pdfEntry( [ 'PAGE1BYTES', 'PAGE2BYTES' ] ) ), { imagesAsText: true } );

		// A block a connector will quietly discard is worse than no block: the bytes are spent and the model
		// gets nothing. The framed text still rides, so the PDF is never silent.
		expect( out.filter( ( b ) => b.type === 'image' ) ).toHaveLength( 0 );
		expect( JSON.stringify( out ) ).not.toContain( 'PAGE1BYTES' );
		expect( JSON.stringify( out ) ).toContain( 'report.pdf' );
	} );

	it( 'stops sending the pages once the turn is history', () => {
		const out = blocks( afterInjection( pdfEntry( [ 'PAGE1BYTES', 'PAGE2BYTES' ] ) ) );

		// THE EXISTING BARGAIN, and not a thing this feature gets an exception from: the bytes ARE the payload,
		// so there is no cheap form to decay to, and ten pages riding forever would displace the context they
		// were fetched to add. Position is the clock, even with the transient still sitting on the object.
		expect( out.filter( ( b ) => b.type === 'image' ) ).toHaveLength( 0 );
		expect( JSON.stringify( out ) ).toContain( 'C:/docs/report.pdf' );
	} );

	it( 'skips an index with no bytes rather than sending an empty block', () => {
		const out = blocks( injecting( pdfEntry( [ 'PAGE1BYTES', '', 'PAGE3BYTES' ] ) ) );

		// A page that failed to render is named in the frame; an empty image block is a 400 from the provider.
		const images = out.filter( ( b ) => b.type === 'image' );
		expect( images.length ).toBe( 2 );
		expect( images.map( ( b ) => b.type === 'image' ? b.data : '' ) ).toEqual( [ 'PAGE1BYTES', 'PAGE3BYTES' ] );
	} );

	it( 'projects a PDF with no pages exactly as it did before — text and nothing else', () => {
		const out = blocks( injecting( pdfEntry() ) );

		// The text-only path is the one every non-multimodal model and every unrendered PDF takes, so it has
		// to be untouched by the widening.
		expect( out.filter( ( b ) => b.type === 'image' ) ).toHaveLength( 0 );
		expect( out.some( ( b ) => b.type === 'text' && b.text.includes( 'EXTRACTED TEXT' ) ) ).toBe( true );
	} );
} );

describe( 'a page image is never stored, and never free', () => {

	it( 'strips imageData from the stored payload, so no page byte reaches turn_entries', () => {
		const stored = Transcript.entryPayload( pdfEntry( [ 'PAGE1BYTES', 'PAGE2BYTES' ] ) );

		// The whole attachment model rests on this: a ten-page render is megabytes, and a row holding it would
		// cost that much memory at every boot forever. One strip on the base, which is why `imageData` is
		// declared there rather than on the arms.
		expect( stored ).not.toContain( 'PAGE1BYTES' );
		expect( stored ).not.toContain( 'imageData' );
		// And the entry's own record still persists — the strip removes the bytes, not the attachment.
		expect( stored ).toContain( 'C:/docs/report.pdf' );
		expect( stored ).toContain( 'application/pdf' );
	} );

	it( 'prices ten page images at pixel area, not at zero and not at the text length', () => {
		const pages    = Array.from( { length: 10 }, ( _, i ) => `PAGE${ i }BYTES` );
		const textOnly = Transcript._entryTokens( pdfEntry(), true );
		const withPages = Transcript._entryTokens( pdfEntry( pages ), true );

		// AN UNPRICED PAGE IMAGE READS AS FREE, which is the one kind of error that makes a budget readout
		// worse than no readout at all: ten pages is of the order of sixteen thousand tokens, and the
		// document's own byte count says nothing whatever about them.
		const expected = Math.round( 10 * PDF_PAGE_IMAGE_PIXELS / 750 );
		expect( withPages - textOnly ).toBe( expected );
		expect( expected ).toBeGreaterThan( 10_000 );
		// Sanity on the direction: the text half is still priced too, not replaced.
		expect( textOnly ).toBeGreaterThan( 0 );
	} );

	it( 'prices an empty index at nothing, matching what the projection sends', () => {
		// The gauge and the wire have to agree about what is riding, or the gauge reports a cost nobody pays.
		const one  = Transcript._entryTokens( pdfEntry( [ 'PAGE1BYTES' ] ), true );
		const hole = Transcript._entryTokens( pdfEntry( [ 'PAGE1BYTES', '' ] ), true );
		expect( hole ).toBe( one );
	} );
} );
