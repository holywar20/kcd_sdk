import { describe, it, expect } from 'vitest';
import { KcdParse } from '../KcdParse';
import { KcdEmit } from '../KcdEmit';
import { KcdValidate } from '../KcdValidate';

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">emit-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture used only by KcdEmit's round-trip test.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
<dt>tags</dt><dd data-kcd-field="tags" data-kcd-type="list"><ul data-kcd-chips><li data-kcd-tag>alpha</li><li data-kcd-tag>beta</li></ul></dd>
<dt>todo</dt><dd data-kcd-field="todo" data-kcd-type="path" href="_Claude/logs/x/todo.md">_Claude/logs/x/todo.md</dd>
</dl>
<h1>Fixture</h1>
<p>Some prose that must survive the round trip untouched.</p>
</article>
</body>
</html>
`;

describe( 'KcdEmit — round trip against KcdParse', () => {
	it( 'emits a document that validates clean', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		const report = KcdValidate.validate( html );
		expect( report.errors ).toEqual( [] );
		expect( report.ok ).toBe( true );
	} );

	it( 'edited frontmatter rides through; untouched body content survives byte-for-byte', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const edited = { ...artifact, frontmatter: { ...artifact.frontmatter, status: 'draft' } };

		const html = KcdEmit.emit( edited );
		const reparsed = KcdParse.parse( html, 'fixture.html' );

		expect( reparsed.frontmatter[ 'status' ] ).toBe( 'draft' );
		expect( reparsed.frontmatter[ 'name' ] ).toBe( 'emit-fixture' );
		expect( reparsed.frontmatter[ 'tags' ] ).toEqual( [ 'alpha', 'beta' ] );
		expect( reparsed.body ).toContain( 'Some prose that must survive the round trip untouched.' );
	} );

	it( 'a path-type field round-trips as a real value, not an empty link', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		const reparsed = KcdParse.parse( html, 'fixture.html' );
		expect( reparsed.frontmatter[ 'todo' ] ).toBe( '_Claude/logs/x/todo.md' );
	} );

	it( 'never mints a key the source frontmatter did not carry', () => {
		const artifact = KcdParse.parse( FIXTURE, 'fixture.html' );
		const html = KcdEmit.emit( artifact );
		expect( html ).not.toContain( 'data-kcd-field="author"' );
		expect( html ).not.toContain( 'data-kcd-field="origin"' );
	} );
} );
