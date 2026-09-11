import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * THE EPHEMERAL-LINK LAW, EVALUATED AGAINST THE RIGHT VAULT ( 2026-09-10 ).
 *
 * `isEphemeralHref` hunted for the literal segment `_Claude` and, when it could not find one, fell
 * back to reading the FIRST segment as the doc root — silently. In any vault named otherwise that
 * made §1.1 wrong in both directions at once, and the direction nobody notices is the dangerous one:
 *
 *   a real link into `_kcd/work/` was NOT reported   ( top read as "_kcd", which is not ephemeral )
 *   a stale link into `_Claude/work/` WAS reported   ( right verdict, wrong reason — the file's
 *                                                      actual defect is that it names the wrong vault )
 *
 * It reached writes as well as reports, because `kcd_save` validates before it lands a file. So a
 * non-default vault refused legal documents and accepted illegal ones.
 *
 * BOTH DIRECTIONS ARE PINNED HERE. A test that only proved the link IS caught would pass against the
 * old code for the `_Claude` case and prove nothing about the defect.
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

	/** THE DEFECT. Identical document, differently-named vault — and it used to pass clean. */
	it( 'catches the same link in a NON-DEFAULT vault', () => {
		const html = doc( 'reference', '<p><a href="_kcd/work/notes.html">notes</a></p>' );
		expect( codes( html, '_kcd' ) ).toContain( 'ephemeral-link' );
	} );

	/**
	 * THE OTHER DIRECTION. A `_Claude/…` href inside a `_kcd` vault names a folder that does not
	 * exist there — it is not a link into THIS vault's scratch space, and calling it one describes
	 * the wrong defect. ( It is still broken, and the reference-integrity pass reports it as a
	 * dangling link — a different finding, from the pass that can actually check the disk. )
	 */
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

	/**
	 * A document that ITSELF lives in ephemeral space is exempt — it never ships, so its links to its
	 * own neighbourhood assert nothing false. That exemption keyed off the same broken lookup, so it
	 * silently stopped applying outside a `_Claude` vault: the identical file was exempt in one vault
	 * and an error in another.
	 */
	it( 'exempts a document that itself lives in scratch space, whatever the vault is called', () => {
		const html = doc( 'reference', '<p><a href="_kcd/work/sibling.html">sibling</a></p>' );

		// The exemption has to be what makes the difference, so the SAME document is asserted both
		// ways. Without this pair the case passed against the broken code too — by accident, because
		// the link check and the self check were wrong in opposite directions and cancelled out. Two
		// compensating bugs read exactly like correct behaviour from one assertion.
		expect( codes( html, '_kcd' ) ).toContain( 'ephemeral-link' );
		expect( codes( html, '_kcd', 'C:/proj/_kcd/work/self.html' ) ).toEqual( [] );
	} );
} );
