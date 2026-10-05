import { describe, it, expect } from 'vitest';
import { KcdAddress } from '../KcdAddress';
import { KcdParse } from '../KcdParse';
import { KcdShapes } from '../KcdShapes';
import { KcdValidate } from '../KcdValidate';
import { KCDPrimitive } from '../../../primitives/framework/KCDPrimitive';
import type { ArtifactType, SerializedArtifact } from '../../../primitives/types';

/**
 * WHAT HAPPENS TO A DOCUMENT STILL DECLARING `audit`, now that the type is retired ( Bryan, 2026-10-03 ).
 *
 * TASK-386 was carded on the reasoning that such a document would "degrade to `unknown` rather than
 * throwing", and asked for that to be verified rather than relied on. IT IS HALF TRUE, and the half that
 * is false is the half that matters — so this file pins both halves rather than the comfortable one.
 *
 *   - THE PARSE PATH DOES NOT DEGRADE. `KcdValidate` raises `unknown-type` for a root type absent from
 *     `KcdAddress.TYPES`, that is an ERROR rather than a warning, and `KcdParse.parse` throws on any
 *     error. So an audit document left on disk would FAIL TO PARSE. Nothing rewrites its type to
 *     `unknown`; `unknown` is a type a document may be ASSIGNED by the layout table, never a landing
 *     place a rejected declaration falls into.
 *   - THE WIRE PATH DOES DEGRADE, and throws nothing. `fromSerialized` falls back to `hydrateBase` for
 *     any type with no registered hydrator, which is what every type outside that list already does.
 *
 * Which makes the card's ordering a REQUIREMENT and not a courtesy: the twelve audit artifacts had to go
 * first ( task 385 ), and `query_docs { type: 'audit' }` was confirmed empty before the vocabulary
 * changed. This file is what makes that dependency fail loudly if anyone re-adds a document later.
 */

/** A minimal conforming document at whatever root type it is handed. `audit` is passed as a bare string
 *  because `ArtifactType` no longer admits it — which is itself part of the retirement. */
function doc( rootType: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>retired</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="${ rootType }">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">some-report</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for the audit retirement.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ rootType }</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>some-report</h1>
<p>A body.</p>
</article>
</body>
</html>
`;
}

describe( 'the audit type is retired from the vocabulary', () => {

	it( 'is gone from the declarable set, and from the shape table', () => {
		expect( KcdAddress.TYPES ).not.toContain( 'audit' );
		// `known: false` is the shape table's honest answer for a type it does not hold, and it finds
		// nothing rather than throwing — so every read path past here stays non-throwing.
		expect( KcdShapes.audit( 'audit', [] ).known ).toBe( false );
		expect( KcdShapes.audit( 'audit', [] ).missing ).toEqual( [] );
	} );

	it( 'has no registered hydrator, so the wire falls back to a bare primitive', () => {
		const wire = {
			path: '_Claude/reports/some-report.html',
			type: 'audit' as ArtifactType,   // cast because the union no longer admits it
			frontmatter: { name: 'some-report' },
			sections: {},
			body: '<p>A body.</p>',
			links: [],
		} satisfies SerializedArtifact;

		// THE HALF OF THE CARD'S CLAIM THAT HOLDS. No throw, and the type string is carried through
		// verbatim rather than rewritten — a bare `KCDPrimitive` wearing the retired name.
		const obj = KCDPrimitive.fromSerialized( wire );
		expect( obj.getType() ).toBe( 'audit' );
		expect( obj.getRole() ).toBe( 'know' );
		expect( obj.constructor.name ).toBe( 'KCDPrimitive' );
	} );

	it( 'FAILS VALIDATION as an unknown type rather than degrading, which is why the documents went first', () => {
		const report = KcdValidate.validate( doc( 'audit' ), { docRoot: '_Claude' } );

		// The correction to the card's premise, stated as the assertion. A retired root type is a named
		// validation error — it is not quietly re-read as `unknown`.
		expect( report.errors.map( e => e.code ) ).toContain( 'unknown-type' );
		expect( report.ok ).toBe( false );
	} );

	it( 'therefore THROWS on the strict parse door and answers null on the lenient one', () => {
		// `parse` is the protected door and all-or-nothing; `tryParse` is the scanner's skip-and-continue
		// sweep. The pair is the whole blast radius of leaving an audit document on disk.
		expect( () => KcdParse.parse( doc( 'audit' ), '_Claude/reports/some-report.html', '_Claude' ) ).toThrow();
		expect( KcdParse.tryParse( doc( 'audit' ), '_Claude/reports/some-report.html', '_Claude' ) ).toBeNull();
	} );

	it( 'still accepts a type that was NOT retired, so the fixture proves the vocabulary and not the fixture', () => {
		// Without this, every assertion above would also pass against a doc() that was simply malformed.
		const report = KcdValidate.validate( doc( 'reference' ), { docRoot: '_Claude' } );
		expect( report.errors.map( e => e.code ) ).not.toContain( 'unknown-type' );
	} );
} );
