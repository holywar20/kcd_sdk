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

	/**
	 * THE 2026-09-25 FAILURE, PINNED — the half the repair exists to prevent, asserted from the guard's
	 * side rather than from the repair's.
	 *
	 * The sequence that got through was rename-then-delete. `identityDependents` reads the target's OWN
	 * `name` off disk and looks for documents naming it, so after a rename the guard asks about the NEW
	 * slug — and before `move` propagated the rename, nobody held the new slug. Every wearer still said
	 * `render`, the guard asked who says `front-end`, found nobody, and allowed the delete. Roughly 180
	 * references were orphaned by a guard that was working exactly as written.
	 *
	 * So the guard was never the defect and relaxing it would have been the wrong repair. What was
	 * missing is that the two halves disagreed about WHEN the name changed. Now the rename propagates,
	 * the dependents name the new slug by the time the guard runs, and the delete is refused.
	 *
	 * The near-miss case rides along deliberately: a guard that blocked on anything at all would also
	 * pass the first assertion, so the one that proves it is answering the real question is the document
	 * it must NOT name.
	 */
	it( 'no longer reports the renamed target as unreferenced, so the rename-then-delete is refused', () => {
		const vault = new Vault( root, '_kcd' );

		vault.move( 'lenses/render/render.html', 'lenses/front-end/front-end.html' );

		// THE ASSERTION THAT WOULD HAVE CAUGHT IT. Asked about the renamed document, the guard now finds
		// the dependent — under the new slug, which it did not hold before the move propagated it.
		const dependents = vault.identityDependents(
			join( root, '_kcd', 'lenses', 'front-end', 'front-end.html' )
		);
		expect( dependents.some( ( p ) => p.includes( 'dependent' ) ) ).toBe( true );
		// …and NOT the near-miss, whose `render-old` neither was nor became this document's name. A guard
		// that blocks on everything blocks on this one too, and would be useless rather than safe.
		expect( dependents.some( ( p ) => p.includes( 'near-miss' ) ) ).toBe( false );

		// The delete the realignment got away with. It is refused now, and the refusal names who holds the
		// reference — which is the whole of what the caller needs to repoint them.
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
