import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * TASK-520 — `move_doc` repairs frontmatter IDENTITY references on rename, not just inbound links.
 *
 * `move` already heals an `<a href>`/`data-kcd-address` pointing AT the moved document. What it did
 * not touch is a `base`/`lens`/`origin` slug NAMING it — the exact gap that defeated the 2026-09-25
 * lens realignment's own rename-then-delete guard and left ~180 dead `lens:` references behind,
 * because the frontmatter `name` was hand-edited and nothing propagated the change.
 *
 * The signal this suite exercises: a move whose destination basename differs from the moved
 * document's CURRENT `name` is a rename of identity, by the one-per-type anatomy every typed
 * artifact already follows ( `lenses/{name}/{name}.html` and its siblings ). `Vault.IDENTITY_FIELDS`
 * — derived from `KcdValidate.FRONTMATTER`'s own slug-typed fields, not hand-listed — is `base`,
 * `lens` and `origin`.
 */

let root = '';

const lensDoc = ( name: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="lens">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture lens.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="personality"><h2>Personality</h2><p>A fixture.</p></section>\n`
	+ `<section data-kcd-section="philosophy"><h2>Philosophy</h2><p>A fixture's stance.</p></section>\n`
	+ `</article>\n</body></html>\n`;

/** A reference carrying a `lens` field ( list form ) and a `base` field ( scalar form ), both
 *  naming whatever the caller passes — the two shapes `Vault.IDENTITY_FIELDS` has to repair. */
const refDoc = ( name: string, lensName: string, baseName: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `<dt>base</dt><dd data-kcd-field="base" data-kcd-type="slug">${ baseName }</dd>`
	+ `<dt>lens</dt><dd data-kcd-field="lens" data-kcd-type="list"><ul data-kcd-chips><li data-kcd-tag>${ lensName }</li></ul></dd>`
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="overview"><h2>Overview</h2><p>Body.</p></section>\n`
	+ `</article>\n</body></html>\n`;

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-moveidentity-' ) );
	mkdirSync( join( root, '_kcd', 'lenses', 'render' ), { recursive: true } );
	mkdirSync( join( root, '_kcd', 'references' ),       { recursive: true } );

	writeFileSync( join( root, '_kcd', 'lenses', 'render', 'render.html' ), lensDoc( 'render' ) );
	writeFileSync( join( root, '_kcd', 'references', 'dependent.html' ),
		refDoc( 'dependent', 'render', 'render' ) );
	// A NEAR-MISS dependent, naming a slug that merely RESEMBLES the one being renamed — must survive
	// untouched. Carries its own `lens`/`base` so the negative proves the repair, not merely its
	// absence.
	writeFileSync( join( root, '_kcd', 'references', 'near-miss.html' ),
		refDoc( 'near-miss', 'render-old', 'render-old' ) );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'Vault.move — identity repair on rename', () => {

	it( 'renames the moved document\'s own `name` and repairs every dependent\'s `lens`/`base`', () => {
		const vault = new Vault( root, '_kcd' );

		vault.move( 'lenses/render/render.html', 'lenses/front-end/front-end.html' );

		const moved = readFileSync( join( root, '_kcd', 'lenses', 'front-end', 'front-end.html' ), 'utf-8' );
		expect( moved ).toContain( '<dd data-kcd-field="name" data-kcd-type="slug">front-end</dd>' );

		const dependent = readFileSync( join( root, '_kcd', 'references', 'dependent.html' ), 'utf-8' );
		expect( dependent ).toContain( '<dd data-kcd-field="base" data-kcd-type="slug">front-end</dd>' );
		expect( dependent ).toContain( '<li data-kcd-tag>front-end</li>' );
		expect( dependent ).not.toContain( 'render' );
	} );

	it( 'leaves a merely SIMILAR slug untouched — a repairer that rewrites near-misses is worse than one that misses', () => {
		const vault = new Vault( root, '_kcd' );

		vault.move( 'lenses/render/render.html', 'lenses/front-end/front-end.html' );

		const nearMiss = readFileSync( join( root, '_kcd', 'references', 'near-miss.html' ), 'utf-8' );
		expect( nearMiss ).toContain( '<dd data-kcd-field="base" data-kcd-type="slug">render-old</dd>' );
		expect( nearMiss ).toContain( '<li data-kcd-tag>render-old</li>' );
	} );

	it( 'does NOT treat an ordinary path move ( basename unchanged ) as an identity rename', () => {
		const vault = new Vault( root, '_kcd' );
		mkdirSync( join( root, '_kcd', 'lenses_archive' ), { recursive: true } );

		vault.move( 'lenses/render/render.html', 'lenses_archive/render.html' );

		const moved = readFileSync( join( root, '_kcd', 'lenses_archive', 'render.html' ), 'utf-8' );
		expect( moved ).toContain( '<dd data-kcd-field="name" data-kcd-type="slug">render</dd>' );

		const dependent = readFileSync( join( root, '_kcd', 'references', 'dependent.html' ), 'utf-8' );
		expect( dependent ).toContain( '<dd data-kcd-field="base" data-kcd-type="slug">render</dd>' );
		expect( dependent ).toContain( '<li data-kcd-tag>render</li>' );
	} );

} );
