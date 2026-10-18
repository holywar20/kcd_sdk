import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';

/**
 * A move whose destination basename differs from the document's current `name` is a rename of identity.
 * `move` then repairs every `base`, `lens` and `origin` slug naming it. Those fields come from
 * `KcdValidate.FRONTMATTER`, not a hand-written list.
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
	// A near-miss slug must survive the rename untouched, which proves the repair rather than its absence.
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

	/**
	 * The guard reads the target's name, so a rename must propagate before it runs. The near-miss assertion
	 * stops it refusing everything, which would pass the first check and be useless.
	 */
	it( 'no longer reports the renamed target as unreferenced, so the rename-then-delete is refused', () => {
		const vault = new Vault( root, '_kcd' );

		vault.move( 'lenses/render/render.html', 'lenses/front-end/front-end.html' );

		// Asked about the renamed document, the guard finds the dependent under its new slug.
		const dependents = vault.identityDependents(
			join( root, '_kcd', 'lenses', 'front-end', 'front-end.html' )
		);
		expect( dependents.some( ( p ) => p.includes( 'dependent' ) ) ).toBe( true );
		// …and not the near-miss, whose slug is not this document's name.
		expect( dependents.some( ( p ) => p.includes( 'near-miss' ) ) ).toBe( false );

		// The refusal names who holds the reference, which is what a caller needs to repoint them.
		expect( () => vault.delete( 'lenses/front-end/front-end.html' ) )
			.toThrow( /reference it by identity/ );
		expect( () => vault.delete( 'lenses/front-end/front-end.html' ) ).toThrow( /dependent/ );
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
