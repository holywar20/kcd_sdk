import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { Vault } from '../Vault';
import { VaultUtilities } from '../VaultUtilities';

/**
 * A lens must be able to correct the floor it stands on ( protocol §6 ).
 *
 * THE BUG THIS PINS ( found 2026-09-04, authoring a lens that set `write-memory-never` against a floor
 * carrying `write-memory-sparing` ): `SlotResolver` resolves habit-class contention over context BLOCKS,
 * and an `on`-mode habit — roughly nine in ten of them — emits no blocks at all. Its whole contribution
 * is a routing ROW inside its declaring lens's habits table, and that table is the LENS's block:
 * classless, never a contender, so it sailed through the cascade with the losing row still inside it.
 * The compiled manifest then advertised BOTH occupants of one mutually-exclusive slot.
 *
 * It failed silently, which is the part that matters. Nothing threw, nothing warned, the chart looked
 * plausible, and the agent simply read two instructions that contradicted each other. Every case below
 * asserts on the compiled TEXT for that reason — asserting the compile did not throw would have passed
 * against the broken build.
 */

let root = '';
const vaultOf = (): Vault => new Vault( root, '_Claude' );

const put = ( rel: string, body: string ): void => {
	const abs = join( root, rel );
	mkdirSync( dirname( abs ), { recursive: true } );
	writeFileSync( abs, body, 'utf8' );
};

/** A habit artifact. `cls` empty means classless — additive, contends nothing. */
const habit = ( name: string, cls: string ): string =>
	`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="habit">\n<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">${ name } fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">habit</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `<dt>schema-version</dt><dd data-kcd-field="schema-version" data-kcd-type="text">0.1</dd>`
	+ ( cls ? `<dt>habit-class</dt><dd data-kcd-field="habit-class" data-kcd-type="slug">${ cls }</dd>` : '' )
	+ `</dl>\n<h1>${ name }</h1>\n`
	+ `<section data-kcd-section="why"><h3>Why</h3><p>fixture trigger for ${ name }</p></section>\n`
	+ `<section data-kcd-section="action"><h3>Action</h3><p>fixture action for ${ name }</p></section>\n`
	+ `</article></body></html>\n`;

/** A lens whose Do region declares `habits` as on-mode routing rows — the ~90% case. */
const lens = ( name: string, habits: string[] ): string => {
	const rows = habits.map( h =>
		`<div data-kcd-slot="habit" data-kcd-mode="on">`
		+ `<span data-kcd-field="what" data-kcd-type="text">${ h.split( '/' ).pop()!.replace( '.html', '' ) }</span>`
		+ `<a data-kcd-field="where" data-kcd-type="path" href="${ h }">${ h.split( '/' ).pop()!.replace( '.html', '' ) }</a>`
		+ `<span data-kcd-field="why" data-kcd-type="text">fixture row</span></div>` ).join( '' );
	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
		+ `<article data-kcd="lens">\n<dl data-kcd-frontmatter>`
		+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
		+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">${ name } fixture.</dd>`
		+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>`
		+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
		+ `<dt>schema-version</dt><dd data-kcd-field="schema-version" data-kcd-type="text">0.1</dd>`
		+ `</dl>\n<h1>${ name }</h1>\n`
		+ `<section data-kcd-region="care"><h2>Care</h2>`
		+ `<section data-kcd-section="purpose"><h3 data-kcd-heading>Purpose</h3><p>fixture purpose for ${ name }.</p></section>`
		+ `</section>\n`
		+ `<section data-kcd-region="do"><h2>Do</h2>`
		+ `<section data-kcd-section="habits"><h3>Habits</h3><div data-kcd-table>${ rows }</div></section>`
		+ `</section>\n`
		+ `</article></body></html>\n`;
};

const NEVER   = '_Claude/habits/write-memory/write-memory-never.html';
const SPARING = '_Claude/habits/write-memory/write-memory-sparing.html';
const NOTES   = '_Claude/habits/unslotted/take-notes.html';

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-slot-' ) );
	put( NEVER,   habit( 'write-memory-never',   'write-memory' ) );
	put( SPARING, habit( 'write-memory-sparing', 'write-memory' ) );
	put( NOTES,   habit( 'take-notes',           '' ) );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'a lens displaces the floor it stands on', () => {

	it( 'drops the floor\'s manifest row when the lens fills the same habit-class', () => {
		put( '_Claude/lenses/_lens-base.html',   lens( '_lens-base', [ SPARING ] ) );
		put( '_Claude/lenses/probe/probe.html',  lens( 'probe',      [ NEVER ] ) );

		const { text } = VaultUtilities.compile( vaultOf(), [ 'probe' ] );

		expect( text ).toContain( 'write-memory-never' );
		expect( text ).not.toContain( 'write-memory-sparing' );
	} );

	it( 'keeps the floor\'s habit when the lens contends nothing', () => {
		put( '_Claude/lenses/_lens-base.html',  lens( '_lens-base', [ SPARING ] ) );
		put( '_Claude/lenses/probe/probe.html', lens( 'probe',      [] ) );

		const { text } = VaultUtilities.compile( vaultOf(), [ 'probe' ] );

		// Displacement is not suppression: an uncontended floor habit still rides.
		expect( text ).toContain( 'write-memory-sparing' );
	} );

	it( 'leaves classless habits additive — they contend nothing and both survive', () => {
		put( '_Claude/lenses/_lens-base.html',  lens( '_lens-base', [ NOTES ] ) );
		put( '_Claude/lenses/probe/probe.html', lens( 'probe',      [ NEVER ] ) );

		const { text } = VaultUtilities.compile( vaultOf(), [ 'probe' ] );

		expect( text ).toContain( 'take-notes' );
		expect( text ).toContain( 'write-memory-never' );
	} );

	it( 'lets the PRIMARY lens win over a later one in the same class', () => {
		put( '_Claude/lenses/_lens-base.html',   lens( '_lens-base', [] ) );
		put( '_Claude/lenses/probe/probe.html',  lens( 'probe',      [ NEVER ] ) );
		put( '_Claude/lenses/second/second.html', lens( 'second',    [ SPARING ] ) );

		const { text } = VaultUtilities.compile( vaultOf(), [ 'probe', 'second' ] );

		expect( text ).toContain( 'write-memory-never' );
		expect( text ).not.toContain( 'write-memory-sparing' );
	} );

	it( 'reports the displaced habit as off, at zero tokens, in the composition chart', () => {
		put( '_Claude/lenses/_lens-base.html',  lens( '_lens-base', [ SPARING ] ) );
		put( '_Claude/lenses/probe/probe.html', lens( 'probe',      [ NEVER ] ) );

		const rows = vaultOf().buildAgent( [ 'probe' ] ).composition();
		const displaced = rows.find( r => r.path.includes( 'write-memory-sparing' ) );

		// The chart is a projection of the same compile, so a row the wire dropped cannot read as `on`
		// carrying weight — that mismatch is what made the bug look like correct behaviour.
		expect( displaced ).toBeDefined();
		expect( displaced!.mode ).toBe( 'off' );
		expect( displaced!.tokens ).toBe( 0 );
	} );
} );
