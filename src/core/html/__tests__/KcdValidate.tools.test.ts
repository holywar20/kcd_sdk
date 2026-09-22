import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * A TOOL SLOT LIVES NOWHERE ( plan agents-own-behaviour, 2026-09-22 ).
 *
 * An agent's tools live on its record. A lens carried tool slots until the lens became information, and every
 * other type — a process written as prose — never encoded a permission at all: the projection dropped tool slots
 * from the body, so the guidance they carried never reached a compiled context either.
 */
function doc( type: string, body: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>fixture</title></head>
<body>
<article data-kcd="${ type }">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">tool-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for tool slot placement.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ type }</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Tool Fixture</h1>
${ body }</article>
</body>
</html>
`;
}

const TOOL_ROW = '<div data-kcd-slot="tool" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">sm_documentation.get_doc</span><span data-kcd-field="why" data-kcd-type="text">on</span></div>';

const TOOLS_TABLE = `<div data-kcd-table>
<div data-kcd-head><span>Tool</span><span>Mode</span></div>
${ TOOL_ROW }
</div>`;

const LENS_BODY = '<section data-kcd-section="personality"><p>p</p></section><section data-kcd-section="philosophy"><p>q</p></section>';

function codes( type: string, body: string ): string[] {
	return KcdValidate.validate( doc( type, body ), { docRoot: '_Claude' } ).errors.map( e => e.code );
}

describe( 'KcdValidate — tool slots are retired', () => {

	it( 'REFUSES a tool slot on a lens, which no longer carries behaviour', () => {
		const errors = codes( 'lens', `${ LENS_BODY }<section data-kcd-section="references"><p>r</p>${ TOOLS_TABLE }</section>` );
		expect( errors ).toContain( 'tool-slot-retired' );
	} );

	it( 'REFUSES a tool slot on an analyzer, and names where tools live instead', () => {
		const report = KcdValidate.validate( doc( 'analyzer', `<section data-kcd-section="tooling"><p>Reach for the server.</p>${ TOOLS_TABLE }</section>` ), { docRoot: '_Claude' } );

		expect( report.ok ).toBe( false );
		const fault = report.errors.find( e => e.code === 'tool-slot-retired' );
		expect( fault ).toBeDefined();
		expect( fault!.msg ).toContain( 'agent' );
		expect( fault!.msg ).toContain( 'prose' );
	} );

	it( 'reports ONE fault per row', () => {
		const two = `<section data-kcd-section="tooling"><p>Two rows.</p><div data-kcd-table>${ TOOL_ROW }${ TOOL_ROW }</div></section>`;
		expect( codes( 'analyzer', two ).filter( c => c === 'tool-slot-retired' ) ).toHaveLength( 2 );
	} );

	it( 'leaves a template alone — scaffolds are exempt from every structural rule', () => {
		expect( codes( 'template', TOOLS_TABLE ) ).toEqual( [] );
	} );
} );
