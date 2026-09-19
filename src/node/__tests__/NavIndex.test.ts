import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Vault } from '../Vault'
import { NavIndex } from '../NavIndex'
import { VaultTools } from '../VaultTools'
import type { VaultToolNames } from '../VaultTools'
import type { ToolResult } from '../../server/McpServer'

/**
 * NavIndex — a folder nav-index is derived from the documents under it on every write. What is pinned is
 * what made the hand-kept version rot: a document born with no row, a description changed under a row
 * that did not follow, and a second copy of both. Plus the three bounds that keep it affordable in a
 * vault nobody tidies — scope, head reads, the cap — and the things it must never touch.
 */

const NAMES: VaultToolNames = {
	query: 'find', get: 'read', links: 'edges', health: 'check', compile: 'compose',
	survey: 'scout', save: 'write', move: 'rename', delete: 'remove', batch: 'run',
}

let root = ''

const doc = ( name: string, opts: { h1?: string; description?: string; status?: string; type?: string; lens?: string[]; author?: string } = {} ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="${ opts.type ?? 'reference' }">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">${ opts.description ?? 'A fixture. With a second sentence.' }</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">${ opts.type ?? 'reference' }</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">${ opts.status ?? 'active' }</dd>`
	+ ( opts.lens ? `<dt>lens</dt><dd data-kcd-field="lens" data-kcd-type="list"><ul data-kcd-chips>${ opts.lens.map( l => `<li data-kcd-tag>${ l }</li>` ).join( '' ) }</ul></dd>` : '' )
	+ ( opts.author ? `<dt>author</dt><dd data-kcd-field="author" data-kcd-type="text">${ opts.author }</dd>` : '' )
	+ `</dl>\n<h1>${ opts.h1 ?? name }</h1>\n<p>Body.</p>\n</article>\n</body></html>\n`

/** A hand-kept index, as the vault had them: rows that are wrong, and a description worth keeping. */
const handIndex = ( name: string, description: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="nav-index">\n<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">${ description }</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">nav-index</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `<dt>author</dt><dd data-kcd-field="author" data-kcd-type="text">Ada L. &lt;ada@example.com&gt;</dd>`
	+ `<dt>updated</dt><dd data-kcd-field="updated" data-kcd-type="date">2026-01-01</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n<div data-kcd-table><div data-kcd-slot="link">`
	+ `<span data-kcd-field="what" data-kcd-type="text">Ghost</span>`
	+ `<a data-kcd-field="where" data-kcd-type="path" href="_Claude/references/gone.html">gone</a>`
	+ `<span data-kcd-field="why" data-kcd-type="text">A tombstone the source already shed.</span>`
	+ `</div></div>\n</article>\n</body></html>\n`

const put  = ( rel: string, content: string ): void => {
	const abs = join( root, '_Claude', rel )
	mkdirSync( join( abs, '..' ), { recursive: true } )
	writeFileSync( abs, content )
}
const read = ( rel: string ): string => readFileSync( join( root, '_Claude', rel ), 'utf8' )
const vault = () => new Vault( root, '_Claude' )
const nav   = ( cap?: number ) => new NavIndex( vault(), undefined, cap )
const text  = ( r: ToolResult ): string => r.content.map( c => c.text ).join( '' )
const json  = ( r: ToolResult ): Record<string, unknown> => JSON.parse( text( r ) ) as Record<string, unknown>
const rows  = ( html: string ): string[] => [ ...html.matchAll( /href="_Claude\/([^"]+)"/g ) ].map( m => m[ 1 ] )

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-navindex-' ) )
	put( 'references/nav-index.html', handIndex( 'references', 'The project store of truth.' ) )
	put( 'references/patterns/alpha.html', doc( 'alpha', { h1: 'Alpha Pattern' } ) )
	put( 'references/patterns/beta.html',  doc( 'beta' ) )
} )

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ) } )

describe( 'NavIndex — a row is what the document says about itself', () => {

	it( 'indexes every document under the folder and drops the rows nothing backs', () => {
		expect( nav().rebuild( 'references/nav-index.html' ) ).toBe( 'written' )
		const html = read( 'references/nav-index.html' )
		expect( rows( html ) ).toEqual( [ 'references/patterns/alpha.html', 'references/patterns/beta.html' ] )
		expect( html ).not.toContain( 'gone.html' )
		expect( html ).not.toContain( 'tombstone' )
	} )

	it( 'what is the h1, why is the first sentence — never the whole description', () => {
		nav().rebuild( 'references/nav-index.html' )
		const html = read( 'references/nav-index.html' )
		expect( html ).toContain( '>Alpha Pattern</span>' )
		expect( html ).toContain( '>A fixture.</span>' )
		expect( html ).not.toContain( 'second sentence' )
	} )

	it( 'a long first sentence is cut back to its first clause', () => {
		const long = 'Replace the shared session file with an action log: an append-only table behind two tools, a studio plug-in over the same two tools, and a renamed habit class whose default pole calls the tool. Then more.'
		put( 'references/patterns/gamma.html', doc( 'gamma', { description: long } ) )
		nav().rebuild( 'references/nav-index.html' )
		expect( read( 'references/nav-index.html' ) ).toContain( '>Replace the shared session file with an action log</span>' )
		expect( NavIndex.lead( long ).length ).toBeLessThanOrEqual( NavIndex.WHY_MAX )
	} )

	it( 'keeps the index\'s own name, description and author — the one hand-authored thing in it', () => {
		nav().rebuild( 'references/nav-index.html' )
		const html = read( 'references/nav-index.html' )
		expect( html ).toContain( 'The project store of truth.' )
		// the author's address is TEXT once parsed — a tag-stripper deleted it, and the validator refused the index
		expect( html ).toContain( 'Ada L. &lt;ada@example.com&gt;' )
	} )

	it( 'ignores anything that is not a KCD document, rather than refusing it', () => {
		put( 'references/patterns/stray.html', '<html><body><p>A page somebody saved here.</p></body></html>' )
		put( 'references/patterns/half.html', '<article data-kcd="reference"><dl data-kcd-frontmatter><dt>type</dt></dl></article>' )
		put( 'references/patterns/notes.md', '# not html' )
		expect( nav().rebuild( 'references/nav-index.html' ) ).toBe( 'written' )
		expect( rows( read( 'references/nav-index.html' ) ) ).toEqual( [ 'references/patterns/alpha.html', 'references/patterns/beta.html' ] )
	} )

	it( 'a bundle is one document — its main file, never what lives inside it', () => {
		put( 'references/patterns/kit/kit.html', doc( 'kit' ) )
		put( 'references/patterns/kit/context/detail.html', doc( 'detail' ) )
		nav().rebuild( 'references/nav-index.html' )
		const r = rows( read( 'references/nav-index.html' ) )
		expect( r ).toContain( 'references/patterns/kit/kit.html' )
		expect( r ).not.toContain( 'references/patterns/kit/context/detail.html' )
	} )

	it( 'a habit class folder is a category, not a bundle — a pole that shares the class name hides no sibling', () => {
		const pole = ( name: string ) => doc( name, { type: 'habit' } ).replace( '</dl>', '<dt>habit-class</dt><dd data-kcd-field="habit-class" data-kcd-type="slug">log-action</dd></dl>' )
		put( 'habits/nav-index.html', handIndex( 'habits', 'Habits.' ) )
		put( 'habits/log-action/log-action.html', pole( 'log-action' ) )
		put( 'habits/log-action/log-action-never.html', pole( 'log-action-never' ) )
		nav().rebuild( 'habits/nav-index.html' )
		const html = read( 'habits/nav-index.html' )
		expect( rows( html ) ).toEqual( [ 'habits/log-action/log-action-never.html', 'habits/log-action/log-action.html' ] )
		expect( html ).toContain( '<h3>log-action</h3>' )
	} )

	it( 'sections by status, groups by category folder, and a lens column only when a document declares one', () => {
		put( 'references/domain/old.html', doc( 'old', { status: 'retired' } ) )
		nav().rebuild( 'references/nav-index.html' )
		let html = read( 'references/nav-index.html' )
		expect( html.indexOf( 'data-kcd-section="active"' ) ).toBeLessThan( html.indexOf( 'data-kcd-section="retired"' ) )
		expect( html ).toContain( '<h3>patterns</h3>' )
		expect( html ).not.toContain( 'field="lens"' )

		put( 'references/patterns/beta.html', doc( 'beta', { lens: [ 'main', 'render' ] } ) )
		nav().rebuild( 'references/nav-index.html' )
		html = read( 'references/nav-index.html' )
		expect( html ).toContain( '<span>Lens</span>' )
		expect( html ).toContain( 'main · render' )
	} )
} )

describe( 'NavIndex — drafts, from where the layout says they are drafted', () => {

	beforeEach( () => {
		put( 'plans/nav-index.html', handIndex( 'plans', 'Every plan.' ) )
		put( 'plans/live.html', doc( 'live', { type: 'plan', lens: [ 'main' ] } ) )
		put( 'work/render/plans/2026-09-18_idea.html', doc( 'idea', { type: 'plan', status: 'draft', lens: [ 'render' ] } ) )
	} )

	it( 'lists a draft in its own section, grouped by lens, as an ADDRESS — never a link into ephemeral space', () => {
		expect( nav().rebuild( 'plans/nav-index.html' ) ).toBe( 'written' )
		const html = read( 'plans/nav-index.html' )
		expect( html ).toContain( 'data-kcd-section="drafts"' )
		expect( html ).toContain( '<h3>render</h3>' )
		expect( html ).toContain( 'data-kcd-address="_Claude/work/render/plans/2026-09-18_idea.html"' )
		expect( html ).not.toContain( 'href="_Claude/work/' )
		expect( html.indexOf( 'data-kcd-section="active"' ) ).toBeLessThan( html.indexOf( 'data-kcd-section="drafts"' ) )
	} )

	it( 'a write to a draft reaches the index it is drafted for', () => {
		const v = vault()
		expect( new NavIndex( v ).affected( [ v.toAbs( 'work/render/plans/2026-09-18_idea.html' ) ] ) ).toEqual( [ 'plans/nav-index.html' ] )
		expect( new NavIndex( v ).affected( [ v.toAbs( 'work/render/AI/note.html' ) ] ) ).toEqual( [] )
	} )

	it( 'a directory that declares no drafts lists none', () => {
		put( 'work/render/references/stray.html', doc( 'stray' ) )
		nav().rebuild( 'references/nav-index.html' )
		expect( read( 'references/nav-index.html' ) ).not.toContain( 'data-kcd-section="drafts"' )
	} )
} )

describe( 'NavIndex — what it costs, and what it never touches', () => {

	it( 'writes only when something an index shows changed', () => {
		const n = nav()
		expect( n.rebuild( 'references/nav-index.html' ) ).toBe( 'written' )
		const abs = join( root, '_Claude', 'references', 'nav-index.html' )
		utimesSync( abs, new Date( 2020, 0, 1 ), new Date( 2020, 0, 1 ) )
		const before = statSync( abs ).mtimeMs
		expect( n.rebuild( 'references/nav-index.html' ) ).toBe( 'unchanged' )
		expect( statSync( abs ).mtimeMs ).toBe( before )
	} )

	it( 'reaches every ancestor index, nearest first — never the vault root, never ephemeral space', () => {
		put( 'references/patterns/nav-index.html', handIndex( 'patterns', 'Patterns.' ) )
		put( 'nav-index.html', handIndex( 'root', 'The entry map.' ) )
		put( 'work/render/AI/nav-index.html', handIndex( 'scratch', 'Somebody\'s scratch.' ) )
		const v = vault()
		const n = new NavIndex( v )
		expect( n.affected( [ v.toAbs( 'references/patterns/alpha.html' ) ] ) ).toEqual( [ 'references/patterns/nav-index.html', 'references/nav-index.html' ] )
		expect( n.affected( [ v.toAbs( 'work/render/AI/note.html' ) ] ) ).toEqual( [] )
		expect( n.affected( [ v.toAbs( 'root.html' ) ] ) ).toEqual( [] )
	} )

	it( 'leaves an index over the cap as it stood, and says so', () => {
		const before = read( 'references/nav-index.html' )
		const r = nav( 1 ).rebuild( 'references/nav-index.html' )
		expect( r ).toEqual( { skipped: expect.stringContaining( 'exceeds the index cap of 1' ) } )
		expect( read( 'references/nav-index.html' ) ).toBe( before )
	} )
} )

describe( 'NavIndex — wired into every write', () => {

	const tools = ( wrote: string[][] = [] ) =>
		new VaultTools( vault(), NAMES, { onWrite: paths => { wrote.push( paths ) } } )

	it( 'a document born through save gets its row, and the host is told the index changed', () => {
		const wrote: string[][] = []
		const t = tools( wrote )
		const html = doc( 'delta', { description: 'Born just now.' } )
		const body = html.slice( html.indexOf( '<dl' ), html.lastIndexOf( '</article>' ) )
		const r = t.save( { path: 'references/patterns/delta.html', artifact: { type: 'reference', frontmatter: { name: 'delta', description: 'Born just now.', type: 'reference', status: 'active', author: 'Ada L. <ada@example.com>', updated: '2026-09-18' }, body } } )
		expect( r.isError ).toBeFalsy()
		expect( json( r )[ 'indexed' ] ).toEqual( [ 'references/nav-index.html' ] )
		expect( rows( read( 'references/nav-index.html' ) ) ).toContain( 'references/patterns/delta.html' )
		expect( wrote[ 0 ].some( p => p.endsWith( 'nav-index.html' ) ) ).toBe( true )
	} )

	it( 'a delete takes the row with it', () => {
		const t = tools()
		t.delete( { path: 'references/patterns/beta.html' } )
		expect( rows( read( 'references/nav-index.html' ) ) ).toEqual( [ 'references/patterns/alpha.html' ] )
	} )

	it( 'a move re-files the row under its new category', () => {
		mkdirSync( join( root, '_Claude', 'references', 'domain' ), { recursive: true } )
		tools().move( { from: 'references/patterns/beta.html', to: 'references/domain/beta.html' } )
		const html = read( 'references/nav-index.html' )
		expect( rows( html ) ).toContain( 'references/domain/beta.html' )
		expect( html ).toContain( '<h3>domain</h3>' )
	} )

	it( 'a batch rebuilds once, at the end, across engines built per call', async () => {
		// Starmind builds a fresh VaultTools for every call, so the hold has to live on the vault.
		const wrote: string[][] = []
		const outer = tools( wrote )
		const r = await outer.batch(
			{ calls: [ { tool: 'remove', args: { path: 'references/patterns/alpha.html' } }, { tool: 'remove', args: { path: 'references/patterns/beta.html' } } ] },
			( name, args ) => Promise.resolve( ( tools( wrote ) as unknown as Record<string, ( a: Record<string, unknown> ) => ToolResult> )[ name === 'remove' ? 'delete' : name ]( args ) )
		)
		const out = json( r )
		expect( ( out[ 'results' ] as Array<{ ok: boolean }> ).map( ( s ) => s.ok ) ).toEqual( [ true, true ] )
		expect( out[ 'indexed' ] ).toEqual( [ 'references/nav-index.html' ] )
		// neither step reported an index of its own — the hold swallowed both, the flush wrote once
		for ( const step of out[ 'results' ] as Array<{ output: string }> ) expect( step.output ).not.toContain( '"indexed"' )
		expect( rows( read( 'references/nav-index.html' ) ) ).toEqual( [] )
		expect( existsSync( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ) ) ).toBe( false )
	} )
} )
