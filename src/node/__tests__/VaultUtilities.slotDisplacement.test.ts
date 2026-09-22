import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * A LENS NO LONGER CORRECTS THE FLOOR'S HABITS, because a lens carries no habits ( plan agents-own-behaviour ).
 *
 * This file pinned habit-class displacement between a lens and the floor it stood on ( protocol §6, found
 * 2026-09-04 ). Habits belong to the agent now — its record holds them and the agent compiler resolves them —
 * so the contention that bug lived in cannot arise in a lens. What stands in its place is the refusal: a lens
 * that still carries habit rows does not compile at all, rather than compiling a half it no longer owns.
 */

let root = '';

const put = ( rel: string, body: string ): void => {
	const abs = join( root, rel );
	mkdirSync( dirname( abs ), { recursive: true } );
	writeFileSync( abs, body, 'utf8' );
};

const lens = ( name: string, extra: string ): string =>
	`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="lens">\n<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">${ name } fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="personality"><p>Who ${ name } is.</p></section>\n`
	+ `<section data-kcd-section="philosophy"><p>What ${ name } believes.</p></section>\n`
	+ extra
	+ `</article></body></html>\n`;

const HABIT_ROW = '<div data-kcd-slot="habit" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">take-notes</span>'
	+ '<a data-kcd-field="where" data-kcd-type="path" href="_Claude/habits/unslotted/take-notes.html">take-notes</a>'
	+ '<span data-kcd-field="why" data-kcd-type="text">fixture row</span></div>';

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-slot-' ) );
	put( '_Claude/lenses/_lens-base.html', lens( '_lens-base', '' ) );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'a lens carries no habits', () => {

	it( 'compiles a flat lens', () => {
		put( '_Claude/lenses/probe/probe.html', lens( 'probe', '' ) );
		expect( VaultUtilities.compile( new Vault( root, '_Claude' ), [ 'probe' ] ).text ).toContain( 'Who probe is.' );
	} );

	it( 'refuses to compile a lens that still carries habit rows', () => {
		put( '_Claude/lenses/probe/probe.html', lens( 'probe', `<section data-kcd-section="references"><div data-kcd-table>${ HABIT_ROW }</div></section>\n` ) );
		expect( () => VaultUtilities.compile( new Vault( root, '_Claude' ), [ 'probe' ] ) ).toThrow( /lens-behaviour-slot|habit/ );
	} );
} );
