import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * WHERE A TOOL SLOT MAY LIVE — on a lens, and nowhere else.
 *
 * Tools are a lens concern: a lens's Tools table is what composes onto an agent. Analyzers, generators and
 * every other type are processes written as prose, and a tool slot on one encodes a permission nothing
 * reads — the projection drops tool slots from the body, so the guidance it carried also never reached a
 * compiled context.
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

const TOOL_ROW = '<div data-kcd-slot="tool" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">daedalus.kcd_get</span><span data-kcd-field="why" data-kcd-type="text">on</span></div>';

const TOOLS_TABLE = `<div data-kcd-table>
<div data-kcd-head><span>Tool</span><span>Mode</span></div>
${ TOOL_ROW }
</div>`;

function codes( type: string, body: string ): string[] {
	return KcdValidate.validate( doc( type, body ), { docRoot: '_Claude' } ).errors.map( e => e.code );
}

describe( 'KcdValidate — tool slots belong to a lens', () => {

	it( 'ADMITS a tool slot in a lens\'s Tools table', () => {
		const body = `<section data-kcd-region="do"><section data-kcd-section="tools">${ TOOLS_TABLE }</section></section>`;
		expect( codes( 'lens', body ) ).not.toContain( 'tool-slot-non-lens' );
	} );

	it( 'REFUSES a tool slot on an analyzer, and names the rule', () => {
		const report = KcdValidate.validate( doc( 'analyzer', `<section data-kcd-section="tooling"><p>Reach for the server.</p>${ TOOLS_TABLE }</section>` ), { docRoot: '_Claude' } );

		expect( report.ok ).toBe( false );
		const fault = report.errors.find( e => e.code === 'tool-slot-non-lens' );
		expect( fault ).toBeDefined();
		expect( fault!.msg ).toContain( 'lens' );
		expect( fault!.msg ).toContain( 'prose' );
	} );

	it( 'REFUSES it on a generator and a reference alike — the rule is the type, not the section', () => {
		expect( codes( 'generator', `<section data-kcd-section="tooling"><p>Reach for the server.</p>${ TOOLS_TABLE }</section>` ) ).toContain( 'tool-slot-non-lens' );
		expect( codes( 'reference', `<section data-kcd-section="overview"><p>Tools.</p>${ TOOLS_TABLE }</section>` ) ).toContain( 'tool-slot-non-lens' );
	} );

	it( 'reports ONE fault per misplaced row', () => {
		const two = `<section data-kcd-section="tooling"><p>Two rows.</p><div data-kcd-table>${ TOOL_ROW }${ TOOL_ROW }</div></section>`;
		expect( codes( 'analyzer', two ).filter( c => c === 'tool-slot-non-lens' ) ).toHaveLength( 2 );
	} );

	it( 'leaves a template alone — scaffolds are exempt from every structural rule', () => {
		expect( codes( 'template', TOOLS_TABLE ) ).toEqual( [] );
	} );
} );
