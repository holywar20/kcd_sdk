import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * THE EPHEMERAL-LINK LAW IS VAULT-RELATIVE. The scratch segment comes from the doc root, never from
 * the first path segment.
 *
 * BOTH DIRECTIONS ARE PINNED. A test that only proves a link is caught passes against a validator that
 * guessed the vault.
 */

const doc = ( selfType: string, body: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>\n`
	+ `<article data-kcd="${ selfType }">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">t</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ selfType }</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>t</h1>\n`
	+ `<section data-kcd-section="overview"><h2>Overview</h2>${ body }</section>\n`
	+ `</article>\n</body></html>\n`;

const codes = ( html: string, docRoot: string, path?: string ): string[] =>
	KcdValidate.validate( html, { docRoot, path } ).errors.map( e => e.code );

describe( 'KcdValidate — the ephemeral-link law is vault-relative', () => {

	it( 'catches a link into scratch space in the DEFAULT vault', () => {
		const html = doc( 'reference', '<p><a href="_Claude/work/notes.html">notes</a></p>' );
		expect( codes( html, '_Claude' ) ).toContain( 'ephemeral-link' );
	} );

	it( 'catches the same link in a NON-DEFAULT vault', () => {
		const html = doc( 'reference', '<p><a href="_kcd/work/notes.html">notes</a></p>' );
		expect( codes( html, '_kcd' ) ).toContain( 'ephemeral-link' );
	} );

	/** A `_Claude/…` href in a `_kcd` vault is not that vault's scratch space: it is a dangling link, a different finding. */
	it( 'does not call a foreign-vault href a link into THIS vault\'s scratch space', () => {
		const html = doc( 'reference', '<p><a href="_Claude/work/notes.html">notes</a></p>' );
		expect( codes( html, '_kcd' ) ).not.toContain( 'ephemeral-link' );
	} );

	// An indexed directory is never ephemeral, in either vault — the guard must not simply flag
	// everything once it stops guessing.
	it( 'leaves an ordinary library link alone', () => {
		const html = doc( 'reference', '<p><a href="_kcd/references/x.html">x</a></p>' );
		expect( codes( html, '_kcd' ) ).toEqual( [] );
	} );

	/** A document that lives in scratch space is exempt: it never ships, so its links assert nothing false. */
	it( 'exempts a document that itself lives in scratch space, whatever the vault is called', () => {
		const html = doc( 'reference', '<p><a href="_kcd/work/sibling.html">sibling</a></p>' );

		// Asserted both ways: one assertion can pass on two compensating bugs.
		expect( codes( html, '_kcd' ) ).toContain( 'ephemeral-link' );
		expect( codes( html, '_kcd', 'C:/proj/_kcd/work/self.html' ) ).toEqual( [] );
	} );
} );
