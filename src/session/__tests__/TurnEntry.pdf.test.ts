import { describe, it, expect } from 'vitest';
import { framePdf, PDF_PAGE_IMAGE_CAP } from '../TurnEntry';

/**
 * The frame an attached PDF rides behind. It is the only thing between extracted text and a quiet lie, so
 * the tests pin what it must say: a scan with no text layer and an unopenable PDF both look like an empty
 * document unless the frame names them. Asserted on content, not the whole string, so the wording can improve.
 */
describe( 'framePdf — extracted text that says it is extracted', () => {

	it( 'declares the kind, the page count, and that the text is extracted rather than the document', () => {
		const framed = framePdf( 'C:\\docs\\contract.pdf', { ok: true, pages: 12, text: 'Clause one.' } );

		expect( framed ).toContain( 'PDF' );
		expect( framed ).toContain( 'contract.pdf' );          // where the real file is, for framePointer's reason
		expect( framed ).toContain( '12 page( s )' );
		expect( framed ).toContain( 'EXTRACTED TEXT' );
		// The disclaimer is load-bearing: silence about figures reads as "there are none".
		expect( framed ).toContain( 'not the document itself' );
		expect( framed ).toContain( 'Figures, tables and layout are not here' );
		// The body rides AFTER the declaration, on its own line — never merged into it.
		expect( framed.endsWith( '\nClause one.' ) ).toBe( true );
	} );

	/** A scanned PDF has pages and no text, and reads as an empty document unless the frame says which it is. Never arrive empty; say why. */
	it( 'names a no-text-layer scan rather than arriving empty', () => {
		const framed = framePdf( 'scan.pdf', { ok: false, why: 'no-text-layer', pages: 4 } );

		expect( framed ).toContain( 'NO TEXT LAYER' );
		expect( framed ).toContain( '4 page( s )' );           // it WAS read — "0 pages" is a different diagnosis
		expect( framed ).toContain( 'scan' );
		expect( framed ).toContain( 'Do not treat it as an empty document' );
		expect( framed ).toContain( 'Ask the person' );
		expect( framed.trim().length ).toBeGreaterThan( 0 );
	} );

	it( 'says a PDF it could not open could not be opened, and carries no bytes', () => {
		const framed = framePdf( 'locked.pdf', { ok: false, why: 'unopenable', reason: 'encrypted' } );

		expect( framed ).toContain( 'COULD NOT BE READ' );
		expect( framed ).toContain( 'encrypted' );
		expect( framed ).toContain( 'nothing of this document is in context' );
		// No fallback to the raw body: a PDF decoded as UTF-8 is mojibake, which looks like content and is worse than nothing.
		expect( framed ).not.toContain( '%PDF' );
	} );
} );

/**
 * The frame once PAGE IMAGES can ride beside the text ( Bryan, 2026-10-24: cap the images at ten, text
 * beyond, "ensure too that we are informing the agent when we do a truncation of the file, so that the agent
 * can inform the user of an issue" ).
 *
 * THE CLAUSE THESE TESTS ARE REALLY ABOUT is "Figures, tables and layout are not here". It is true of text
 * alone and false the instant a page image rides, and false in the worst direction — it tells a model to
 * disregard the one thing it can now see. So it is asserted PRESENT and ABSENT in the same pair below: a
 * frame that merely gained a sentence about images while keeping the clause would pass one half and fail the
 * other, which is the whole point of testing it from both ends.
 */
describe( 'framePdf — page images, and the cap saying so out loud', () => {

	it( 'caps at thirty pages, as a named constant the rasteriser can obey', () => {
		// The number lives in the SDK beside the frame so the frame's claim and the rasteriser's behaviour
		// cannot disagree. A second copy in main would be a second number.
		expect( PDF_PAGE_IMAGE_CAP ).toBe( 30 );
	} );

	it( 'states the total, WHICH pages arrived, and what to do about the rest when the cap binds', () => {
		const framed = framePdf( 'big.pdf', { ok: true, pages: 40, text: 'Page one text.' },
			{ imaged: [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ] } );

		// THE TOTAL, so the model knows the size of what it cannot see rather than the size of what it can.
		expect( framed ).toContain( '40 page( s )' );
		// WHICH pages, as a range: "10 of 40 arrived" invites the model to assume the first ten.
		expect( framed ).toContain( '1-10' );
		// The remaining pages named as text only, and the number of them stated.
		expect( framed ).toContain( 'EXTRACTED TEXT ONLY' );
		expect( framed ).toContain( '30 of 40' );
		// THE OPERATIVE HALF, and the reason this card exists: the model is told to hand the gap to the
		// person, not merely informed that a gap exists.
		expect( framed ).toContain( 'SAY SO to the person' );
		expect( framed ).toContain( `At most ${ PDF_PAGE_IMAGE_CAP } pages` );
		// The text still rides last, on its own line — unchanged from the text-only frame.
		expect( framed.endsWith( '\nPage one text.' ) ).toBe( true );
	} );

	it( 'keeps the "figures are not here" clause when NO image rode', () => {
		const framed = framePdf( 'text.pdf', { ok: true, pages: 3, text: 'Words.' } );

		// Half one of the pair. With no images this sentence is true, and silence about figures reads as
		// "there are none" — so it must survive the widening untouched.
		expect( framed ).toContain( 'Figures, tables and layout are not here' );
		expect( framed ).not.toContain( 'SAY SO to the person' );
	} );

	it( 'DROPS that clause when every page rode as an image', () => {
		const framed = framePdf( 'small.pdf', { ok: true, pages: 3, text: 'Words.' }, { imaged: [ 1, 2, 3 ] } );

		// Half two, and the one a frame that only gained a sentence would fail: with every page in front of
		// the model, the clause is a lie that suppresses the images.
		expect( framed ).not.toContain( 'Figures, tables and layout are not here' );
		expect( framed ).toContain( 'EVERY PAGE AS AN IMAGE' );
		// Nothing is missing, so there is nothing to tell the person about.
		expect( framed ).not.toContain( 'SAY SO to the person' );
		expect( framed.endsWith( '\nWords.' ) ).toBe( true );
	} );

	it( 'reads a scan whose pages DID arrive as a success, not a dead end', () => {
		const framed = framePdf( 'scan.pdf', { ok: false, why: 'no-text-layer', pages: 2 }, { imaged: [ 1, 2 ] } );

		// The most valuable thing the widening buys: a scan has no text and photographs perfectly, so the
		// frame must stop saying its contents are absent while the pages are sitting in front of the model.
		expect( framed ).not.toContain( 'nothing of its contents is in context' );
		expect( framed ).toContain( 'EVERY PAGE AS AN IMAGE' );
		expect( framed ).toContain( 'read the document off the pages' );
		// And it must stop asking for a text version it no longer needs.
		expect( framed ).not.toContain( 'Ask the person what it says' );
	} );

	it( 'says a scan whose pages only PARTLY arrived is partly absent in every form', () => {
		const framed = framePdf( 'longscan.pdf', { ok: false, why: 'no-text-layer', pages: 30 }, { imaged: [ 1, 2, 3 ] } );

		// The worst case in the set: no text AND no image for 27 pages, so those pages are in context in no
		// form at all. The model must be told to pass that on rather than answer from three pages of thirty.
		expect( framed ).toContain( '30 page( s )' );
		expect( framed ).toContain( '1-3' );
		expect( framed ).toContain( 'ANY form' );
		expect( framed ).toContain( 'SAY SO to the person' );
	} );

	it( 'names pages that FAILED to render rather than modelling them as success', () => {
		const framed = framePdf( 'torn.pdf', { ok: true, pages: 5, text: 'All five pages of text.' },
			{ imaged: [ 1, 2, 3, 5 ], failed: [ 4 ] } );

		// A render that lost a page is a PARTIAL render however many arrived, so this must NOT read as
		// "every page", and page 4 must be named.
		expect( framed ).not.toContain( 'EVERY PAGE AS AN IMAGE' );
		expect( framed ).toContain( 'Page( s ) 4 could not be rendered' );
		expect( framed ).toContain( 'SAY SO to the person' );
		// The cap is not the reason here, and the frame must not claim it was.
		expect( framed ).not.toContain( 'over that cap' );
	} );

	it( 'collapses the page list into runs, and survives a list that is not a prefix', () => {
		const framed = framePdf( 'picked.pdf', { ok: true, pages: 20, text: 'Text.' },
			{ imaged: [ 7, 1, 2, 3, 12, 13 ] } );

		// The rasteriser is free to choose pages that are not the first N; the frame has to describe whatever
		// it chose, compactly, because this string rides in context every time a PDF does.
		expect( framed ).toContain( '1-3, 7, 12-13' );
		expect( framed ).toContain( '6 PAGE IMAGE( S )' );
	} );
} );
