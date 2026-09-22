import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentCompiler } from '../AgentCompiler';
import { loadLensFromDisk } from '../../node/io';
import { KCDPrimitive } from '../../primitives/framework/KCDPrimitive';

/**
 * The agent compiler ( plan agents-own-behaviour, task 55 ) — lenses in order with the first primary, loaded
 * habits in full, the rest as their why, the tools described, and no inheritance walked.
 */

let root = '';

const FM = ( name: string, type: string ): string =>
	'<dl data-kcd-frontmatter>'
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">The ${ name } fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ type }</dd>`
	+ '<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>'
	+ '<dt>schema-version</dt><dd data-kcd-field="schema-version" data-kcd-type="text">0.1</dd>'
	+ '</dl>';

const page = ( body: string ): string => `<!DOCTYPE html><html><head><title>x</title></head><body>${ body }</body></html>`;

const LENS = ( name: string, purpose: string, extra = '' ): string => page(
	`<article data-kcd="lens">${ FM( name, 'lens' ) }<h1>${ name }</h1>`
	+ '<section data-kcd-region="know"><h2>Know</h2>'
	+ '<section data-kcd-section="references"><h3>References</h3><div data-kcd-table>'
	+ '<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>'
	+ `<div data-kcd-slot="reference" data-kcd-mode="load"><span data-kcd-field="what" data-kcd-type="text">${ name } notes</span>`
	+ `<a data-kcd-field="where" data-kcd-type="path" href="_Claude/references/${ name }-notes.html">${ name }-notes</a>`
	+ `<span data-kcd-field="why" data-kcd-type="text">what ${ name } knows</span></div>`
	+ '</div></section></section>'
	+ `<section data-kcd-region="care"><h2>Care</h2><section data-kcd-section="purpose"><h3 data-kcd-heading>Purpose</h3><p>${ purpose }</p></section></section>`
	+ extra
	+ '</article>' );

/** A Do table naming a habit — the compiler must ignore it, because behaviour is the agent's. */
const LENS_HABITS = '<section data-kcd-region="do"><h2>Do</h2><section data-kcd-section="habits"><h3>Habits</h3><div data-kcd-table>'
	+ '<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>'
	+ '<div data-kcd-slot="habit" data-kcd-mode="load"><span data-kcd-field="what" data-kcd-type="text">lens-habit</span>'
	+ '<a data-kcd-field="where" data-kcd-type="path" href="_Claude/habits/lens-habit/lens-habit.html">lens-habit</a>'
	+ '<span data-kcd-field="why" data-kcd-type="text"></span></div></div></section></section>';

const REFERENCE = ( name: string, body: string ): string =>
	page( `<article data-kcd="reference">${ FM( name, 'reference' ) }<h1>${ name }</h1><p>${ body }</p></article>` );

const HABIT = ( name: string ): string => page(
	`<article data-kcd="habit">${ FM( name, 'habit' ).replace( '</dl>', `<dt>habit-class</dt><dd data-kcd-field="habit-class" data-kcd-type="slug">${ name }</dd></dl>` ) }`
	+ `<h1>${ name }</h1><section data-kcd-section="why"><h3>Why</h3><p>when ${ name } applies</p></section>`
	+ `<section data-kcd-section="action"><h3>Action</h3><p>do the ${ name } thing</p></section></article>` );

function put( rel: string, text: string ): string {
	const abs = join( root, rel );
	mkdirSync( join( abs, '..' ), { recursive: true } );
	writeFileSync( abs, text, 'utf-8' );
	return abs;
}

const lens = ( rel: string ) => loadLensFromDisk( join( root, rel ), { projectRoot: root, eager: true } );
const habit = ( rel: string ): KCDPrimitive => KCDPrimitive.fromHtml( readFileSync( join( root, rel ), 'utf-8' ), join( root, rel ), '_Claude' );

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-agent-compiler-' ) );
	put( '_Claude/lenses/alpha/alpha.html', LENS( 'alpha', 'Alpha cares about first things.', LENS_HABITS ) );
	put( '_Claude/lenses/beta/beta.html', LENS( 'beta', 'Beta cares about second things.' ) );
	put( '_Claude/lenses/_lens-base.html', LENS( '_lens-base', 'The floor nobody asked for.' ) );
	put( '_Claude/references/alpha-notes.html', REFERENCE( 'alpha-notes', 'Alpha reference body.' ) );
	put( '_Claude/references/beta-notes.html', REFERENCE( 'beta-notes', 'Beta reference body.' ) );
	put( '_Claude/habits/lens-habit/lens-habit.html', HABIT( 'lens-habit' ) );
	put( '_Claude/habits/kept/kept.html', HABIT( 'kept' ) );
	put( '_Claude/habits/listed/listed.html', HABIT( 'listed' ) );
} );

afterEach( () => rmSync( root, { recursive: true, force: true } ) );

function compile() {
	return AgentCompiler.compile( {
		name:   'Tester',
		lenses: [ lens( '_Claude/lenses/alpha/alpha.html' ), lens( '_Claude/lenses/beta/beta.html' ) ],
		habits: [
			{ name: 'kept',   path: 'habits/kept/kept.html',     why: 'when kept applies',        loaded: true,  habit: habit( '_Claude/habits/kept/kept.html' ) },
			{ name: 'listed', path: 'habits/listed/listed.html', why: 'when listing is the move', loaded: false, habit: habit( '_Claude/habits/listed/listed.html' ) }
		],
		tools: [ { id: 'sm_log.log_action', description: 'Record what was done.' }, { id: 'exa.web_search_exa' } ]
	} );
}

describe( 'AgentCompiler', () => {

	it( 'compiles the lenses in order, the first marked primary, each with its Care and its loaded references', () => {
		const { text, lenses } = compile();

		expect( lenses ).toEqual( [ 'alpha', 'beta' ] );
		expect( text ).toContain( 'The first, alpha, is your persona and overrules the others where they conflict.' );
		expect( text ).toContain( '## alpha — primary' );
		expect( text.indexOf( '## alpha — primary' ) ).toBeLessThan( text.indexOf( '## beta' ) );
		expect( text.indexOf( 'Alpha cares about first things.' ) ).toBeLessThan( text.indexOf( 'Beta cares about second things.' ) );
		expect( text ).toContain( 'Alpha reference body.' );
		expect( text ).toContain( 'Beta reference body.' );
	} );

	it( 'rides a loaded habit in full and the others as their why-text only', () => {
		const { text, habits } = compile();

		expect( habits ).toEqual( { loaded: [ 'kept' ], listed: [ 'listed' ] } );
		expect( text ).toContain( 'do the kept thing' );
		expect( text ).toContain( '- listed — when listing is the move (habits/listed/listed.html)' );
		expect( text ).not.toContain( 'do the listed thing' );
	} );

	it( 'describes the tools it holds, and says who decides for a Claude Code host', () => {
		const { text, tools } = compile();

		expect( tools ).toEqual( [ 'sm_log.log_action', 'exa.web_search_exa' ] );
		expect( text ).toContain( '- sm_log.log_action — Record what was done.' );
		expect( text ).toContain( '- exa.web_search_exa' );
		expect( text ).toContain( 'passport' );

		const cc = AgentCompiler.compile( { name: 'Tester', lenses: [], habits: [], tools: [ { id: 'x.y' } ], host: 'claude-code' } );
		expect( cc.text ).toContain( 'Claude Code decides what you may call' );
	} );

	it( 'walks no inheritance — no base floor, and none of a lens\'s own habits', () => {
		const { text } = compile();

		expect( text ).not.toContain( '_lens-base' );
		expect( text ).not.toContain( 'The floor nobody asked for.' );
		expect( text ).not.toContain( 'lens-habit' );
		expect( text ).not.toContain( 'Available on request' );
	} );

	it( 'falls back to the why line for a loaded habit whose file did not load', () => {
		const { text, habits } = AgentCompiler.compile( { name: 'T', lenses: [], tools: [], habits: [
			{ name: 'gone', path: 'habits/gone/gone.html', why: 'when it existed', loaded: true, habit: null }
		] } );

		expect( habits ).toEqual( { loaded: [], listed: [ 'gone' ] } );
		expect( text ).toContain( '- gone — when it existed (habits/gone/gone.html)' );
	} );
} );
