import { describe, it, expect } from 'vitest';
import { framePdf } from '../TurnEntry';

/**
 * THE PDF-SHAPED DECLARATION — the frame a person's attached PDF rides behind ( Bryan, 2026-10-01 ).
 *
 * The frame is the ONLY thing standing between extracted text and a quiet lie, so what it has to SAY is
 * what these tests pin. Three outcomes, three sentences, and the two failures are asserted hardest: a scan
 * with no text layer and a PDF that would not open both look exactly like an empty document if the frame
 * does not name them, and a model handed an empty document reports one.
 *
 * Asserted on CONTENT rather than byte-for-byte on the whole string, deliberately — the wording is meant to
 * be improved, and a test that locks the prose makes improving it a test edit. What must not change is that
 * each of the four facts is present.
 */
describe( 'framePdf — extracted text that says it is extracted', () => {

	it( 'declares the kind, the page count, and that the text is extracted rather than the document', () => {
		const framed = framePdf( 'C:\\docs\\contract.pdf', { ok: true, pages: 12, text: 'Clause one.' } );

		expect( framed ).toContain( 'PDF' );
		expect( framed ).toContain( 'contract.pdf' );          // where the real file is, for framePointer's reason
		expect( framed ).toContain( '12 page( s )' );
		expect( framed ).toContain( 'EXTRACTED TEXT' );
		// The disclaimer is the load-bearing half: what the model cannot see is exactly what it would
		// otherwise assume it had, and silence about figures reads as "there are none".
		expect( framed ).toContain( 'not the document itself' );
		expect( framed ).toContain( 'Figures, tables and layout are not here' );
		// The body rides AFTER the declaration, on its own line — never merged into it.
		expect( framed.endsWith( '\nClause one.' ) ).toBe( true );
	} );

	/**
	 * THE COMMON REAL CASE. A scanned PDF has pages and no text, and it is indistinguishable from a
	 * successful read of an empty document unless the frame says which it is. It must never arrive empty,
	 * must say WHY there is nothing, and must tell the reader what to do instead of inferring.
	 */
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
		// NO FALLBACK TO THE RAW BODY, ever. A PDF's bytes through a UTF-8 decode are mojibake, which is
		// worse than nothing because it looks like content — so the failure arms take no text at all and
		// there is structurally nothing for them to leak.
		expect( framed ).not.toContain( '%PDF' );
	} );
} );
