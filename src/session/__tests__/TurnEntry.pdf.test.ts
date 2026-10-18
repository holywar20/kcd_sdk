import { describe, it, expect } from 'vitest';
import { framePdf } from '../TurnEntry';

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
