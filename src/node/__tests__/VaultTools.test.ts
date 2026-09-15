import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Vault } from '../Vault';
import { VaultTools, VAULT_TOOL_OPS } from '../VaultTools';
import type { VaultToolNames, VaultToolOp } from '../VaultTools';
import type { ToolResult } from '../../server/McpServer';

/**
 * VaultTools — the one engine behind the Daedalus server and Starmind's `sm_documentation` keystones.
 *
 * Two faces call these ops under different names, so what is worth pinning is what a FACE cannot get
 * wrong by construction: the jail runs inside every path-taking op ( no face can skip it ), a refusal
 * names the sibling AS THIS FACE CALLS IT, a write reports what it touched, and the prose renders the
 * same on every face except for the names. Every assertion on a refusal reads its TEXT — the message is
 * the model's next input, not a log line.
 */

const NAMES: VaultToolNames = {
	query: 'find', get: 'read', links: 'edges', health: 'check', compile: 'compose',
	survey: 'scout', save: 'write', move: 'rename', delete: 'remove', batch: 'run',
};

let root = '';
let wrote: string[][] = [];

/** A minimal valid reference. `body` is dropped in verbatim so a case can plant what it needs. */
const doc = ( name: string, body: string ) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ name }</title></head><body>\n`
	+ `<article data-kcd="reference">\n`
	+ `<dl data-kcd-frontmatter>`
	+ `<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ name }</dd>`
	+ `<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture.</dd>`
	+ `<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>`
	+ `<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>`
	+ `</dl>\n<h1>${ name }</h1>\n${ body }\n</article>\n</body></html>\n`;

const put = ( rel: string, content: string ): void => {
	const abs = join( root, rel );
	mkdirSync( join( abs, '..' ), { recursive: true } );
	writeFileSync( abs, content );
};

const tools = () => new VaultTools( new Vault( root, '_Claude' ), NAMES, { onWrite: ( paths ) => { wrote.push( paths ); } } );
const text  = ( r: ToolResult ): string => r.content.map( c => c.text ).join( '' );
const json  = ( r: ToolResult ): Record<string, unknown> => JSON.parse( text( r ) ) as Record<string, unknown>;

beforeEach( () => {
	root  = mkdtempSync( join( tmpdir(), 'kcd-tools-' ) );
	wrote = [];
	put( '_Claude/references/patterns/alpha.html', doc( 'alpha', '<p>The target.</p>' ) );
	put( '_Claude/references/patterns/beta.html',  doc( 'beta',  '<p>See <a href="_Claude/references/patterns/alpha.html">alpha</a>.</p>' ) );
	mkdirSync( join( root, '_Claude', 'references', 'domain' ), { recursive: true } );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'VaultTools — the jail is inside the op', () => {

	it( 'refuses an absolute path on every path-taking op, naming the form and the sibling that finds paths', () => {
		const t = tools();
		const outside = 'C:/Windows/System32/drivers/etc/hosts';
		const refusals = [
			t.get( { path: outside } ),
			t.links( { path: outside } ),
			t.health( { path: outside } ),
			t.save( { path: outside, artifact: { type: 'reference', frontmatter: {}, body: '' } } ),
			t.move( { from: outside, to: 'references/domain/x.html' } ),
			t.move( { from: 'references/patterns/alpha.html', to: outside } ),
			t.delete( { path: outside } ),
		];
		for ( const r of refusals ) {
			expect( r.isError ).toBe( true );
			expect( text( r ) ).toContain( 'is outside the vault' );
			expect( text( r ) ).toContain( 'vault-RELATIVE' );
			// THE SIBLING IS NAMED AS THIS FACE CALLS IT — never the other face's spelling.
			expect( text( r ) ).toContain( 'Use find to find' );
			expect( text( r ) ).not.toContain( 'kcd_query' );
		}
		expect( wrote ).toEqual( [] );
	} );

	it( 'refuses a save whose declared type the directory does not accept, naming the accepted set', () => {
		const r = tools().save( { path: 'references/domain/x.html', artifact: { type: 'lens', frontmatter: { type: 'lens' }, body: '' } } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toMatch( /^Type mismatch at "references\/domain\/x.html": directory accepts .*"reference".*artifact declares "lens"/ );
	} );
} );

describe( 'VaultTools — reads', () => {

	it( 'get is LEAN by default and verbatim under full', () => {
		const lean = json( tools().get( { path: 'references/patterns/alpha.html' } ) );
		expect( lean ).not.toHaveProperty( 'body' );
		expect( ( lean[ 'frontmatter' ] as Record<string, unknown> )[ 'name' ] ).toBe( 'alpha' );

		const full = json( tools().get( { path: 'references/patterns/alpha.html', full: true } ) );
		expect( typeof full[ 'body' ] ).toBe( 'string' );
		expect( full[ 'body' ] as string ).toContain( 'The target.' );
	} );

	it( 'get rewrites a missing artifact into the path AS ASKED and the sibling that finds one', () => {
		const r = tools().get( { path: 'references/patterns/nope.html' } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'No artifact at "references/patterns/nope.html"' );
		expect( text( r ) ).toContain( 'Use find to find it' );
		expect( text( r ) ).not.toContain( root );   // never the absolute path the caller did not write
	} );

	it( 'query answers refs, and a type census under groupBy', () => {
		const refs = JSON.parse( text( tools().query( { type: 'reference' } ) ) ) as { path: string }[];
		expect( refs.map( r => r.path ).sort() ).toEqual( [ 'references/patterns/alpha.html', 'references/patterns/beta.html' ] );

		const census = JSON.parse( text( tools().query( { groupBy: 'type' } ) ) ) as { type: string; count: number }[];
		expect( census ).toEqual( [ { type: 'reference', count: 2 } ] );
	} );

	it( 'links sees the backlink beta declares onto alpha', () => {
		const r = json( tools().links( { path: 'references/patterns/alpha.html' } ) );
		expect( ( r[ 'inbound' ] as { path: string }[] ).map( l => l.path ) ).toEqual( [ 'references/patterns/beta.html' ] );
	} );

	it( 'health sweeps the whole vault when no path is given', () => {
		const r = json( tools().health( {} ) );
		expect( r ).toHaveProperty( 'issues' );
		expect( r ).toHaveProperty( 'summary' );
	} );
} );

describe( 'VaultTools — writes report what they touched', () => {

	it( 'save in content mode synthesizes a valid document, writes it, and tells the host', () => {
		const r = tools().save( {
			path:     'references/domain/gamma.html',
			artifact: {
				type:        'reference',
				frontmatter: { name: 'gamma', description: 'Authored by content.', type: 'reference', status: 'active' },
				content:     { sections: { why: 'when a test wants a synthesized reference', overview: 'One paragraph.' } },
			},
		} );
		expect( r.isError ).toBeUndefined();
		// `Vault.write` reports the path in OS spelling; the fact under test is WHICH file, not the separator.
		expect( String( json( r )[ 'saved' ] ).replace( /\\/g, '/' ) ).toBe( 'references/domain/gamma.html' );
		expect( existsSync( join( root, '_Claude', 'references', 'domain', 'gamma.html' ) ) ).toBe( true );
		expect( wrote ).toEqual( [ [ resolve( root, '_Claude', 'references', 'domain', 'gamma.html' ) ] ] );
	} );

	it( 'save refuses content and body together, under this face\'s own name', () => {
		const r = tools().save( {
			path:     'references/domain/x.html',
			artifact: { type: 'reference', frontmatter: { name: 'x', description: 'x', type: 'reference', status: 'active' }, body: '<p>x</p>', content: { sections: { why: 'x' } } },
		} );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'write refused "references/domain/x.html": supply either "content"' );
		expect( wrote ).toEqual( [] );
	} );

	it( 'save validates BEFORE writing — a malformed artifact lands nothing', () => {
		const r = tools().save( { path: 'references/domain/x.html', artifact: { type: 'reference', frontmatter: {}, body: '' } } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'write refused "references/domain/x.html": artifact failed validation' );
		expect( existsSync( join( root, '_Claude', 'references', 'domain', 'x.html' ) ) ).toBe( false );
		expect( wrote ).toEqual( [] );
	} );

	it( 'move heals the referrer and reports the moved file AND the referrer to the host', () => {
		const r = json( tools().move( { from: 'references/patterns/alpha.html', to: 'references/domain/alpha.html' } ) );
		expect( r[ 'op' ] ).toBe( 'move' );
		expect( ( r[ 'edits' ] as { file: string }[] ).map( e => e.file ) ).toEqual( [ 'references/patterns/beta.html' ] );
		expect( readFileSync( join( root, '_Claude', 'references', 'patterns', 'beta.html' ), 'utf-8' ) ).toContain( '_Claude/references/domain/alpha.html' );

		expect( wrote ).toHaveLength( 1 );
		expect( wrote[ 0 ]!.sort() ).toEqual( [
			resolve( root, '_Claude', 'references', 'domain', 'alpha.html' ),
			resolve( root, '_Claude', 'references', 'patterns', 'alpha.html' ),
			resolve( root, '_Claude', 'references', 'patterns', 'beta.html' ),
		].sort() );
	} );

	it( 'delete cascades through the referrer and reports both to the host', () => {
		const r = json( tools().delete( { path: 'references/patterns/alpha.html' } ) );
		expect( r[ 'op' ] ).toBe( 'delete' );
		expect( existsSync( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ) ) ).toBe( false );
		expect( readFileSync( join( root, '_Claude', 'references', 'patterns', 'beta.html' ), 'utf-8' ) ).not.toContain( 'alpha.html' );
		expect( wrote[ 0 ] ).toContain( resolve( root, '_Claude', 'references', 'patterns', 'beta.html' ) );
	} );

	it( 'a missing move source is a structured refusal, not a throw', () => {
		const r = tools().move( { from: 'references/patterns/nope.html', to: 'references/domain/x.html' } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'Cannot move: source "references/patterns/nope.html" does not exist' );
	} );
} );

describe( 'VaultTools — batch runs the FACE\'s dispatch and stops at the first failure', () => {

	const invoke = ( t: VaultTools ) => async ( name: string, args: Record<string, unknown> ): Promise<ToolResult> => {
		const op = ( Object.keys( NAMES ) as VaultToolOp[] ).find( ( o ) => NAMES[ o ] === name );
		if ( !op || op === 'batch' ) return VaultTools.error( `Unknown tool: ${ name }` );
		return t[ op ]( args );
	};

	it( 'completes a read sequence in order', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'find', args: { groupBy: 'type' } }, { tool: 'read', args: { path: 'references/patterns/alpha.html' } } ] }, invoke( t ) ) );
		expect( ( r[ 'completed' ] as { tool: string }[] ).map( c => c.tool ) ).toEqual( [ 'find', 'read' ] );
		expect( r[ 'failed' ] ).toBeNull();
		expect( r[ 'remaining' ] ).toEqual( [] );
	} );

	it( 'reports the failing step with what remained, and never throws', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'find' }, { tool: 'does-not-exist' }, { tool: 'read' } ] }, invoke( t ) ) );
		expect( ( r[ 'completed' ] as unknown[] ) ).toHaveLength( 1 );
		expect( r[ 'failed' ] ).toEqual( { index: 1, tool: 'does-not-exist', error: 'Unknown tool: does-not-exist' } );
		expect( r[ 'remaining' ] ).toEqual( [ 'read' ] );
	} );

	it( 'refuses to nest itself, under this face\'s own name', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'run', args: { calls: [] } } ] }, invoke( t ) ) );
		expect( r[ 'failed' ] ).toEqual( { index: 0, tool: 'run', error: 'run cannot be nested' } );
	} );
} );

describe( 'VaultTools.spec — one copy of the prose, rendered per face', () => {

	it( 'renders every sibling reference in this face\'s names, and leaves no token behind', () => {
		for ( const op of VAULT_TOOL_OPS ) {
			const spec = VaultTools.spec( op, NAMES );
			const flat = JSON.stringify( spec );
			expect( flat ).not.toMatch( /\{\{\w+\}\}/ );
			expect( flat ).not.toContain( 'kcd_' );
		}
		expect( VaultTools.spec( 'get', NAMES ).doc ).toContain( 'Use edges instead when you only need the link graph' );
		expect( VaultTools.spec( 'batch', NAMES ).example ).toEqual( { calls: [ { tool: 'find', args: { type: 'lens' } }, { tool: 'read', args: { path: 'lenses/mcp/mcp.html' } } ] } );
	} );

	it( 'keeps a literal single-brace placeholder in prose intact — only {{op}} is a token', () => {
		expect( VaultTools.spec( 'health', NAMES ).doc ).toContain( '{placeholder} hrefs are skipped' );
	} );

	it( 'throws on a token that names no op, so an authoring slip cannot ship as prose', () => {
		const partial = { ...NAMES, links: '' } as VaultToolNames;
		expect( () => VaultTools.spec( 'get', partial ) ).toThrow( /has no name on this face/ );
	} );

	/**
	 * THE DAEDALUS WIRE MUST NOT MOVE. That face's committed snapshot is what every host advertises while
	 * the server is dormant, and moving the prose into the SDK was meant to change what a tool DOES about
	 * nothing and what it SAYS about nothing. Skipped when the sibling checkout is not beside this one —
	 * Daedalus is its own repository — so the SDK suite stays runnable on its own.
	 */
	it( 'renders the Daedalus face byte-identical to its committed tool snapshot', () => {
		const snapshot = resolve( __dirname, '../../../../daedalus/tools.snapshot.json' );
		if ( !existsSync( snapshot ) ) return;

		const DAEDALUS: VaultToolNames = {
			query: 'kcd_query', get: 'kcd_get', links: 'kcd_links', health: 'kcd_health', compile: 'kcd_compile',
			survey: 'kcd_survey', save: 'kcd_save', move: 'kcd_move', delete: 'kcd_delete', batch: 'kcd_batch',
		};
		const tools = ( JSON.parse( readFileSync( snapshot, 'utf-8' ) ) as { tools: Record<string, unknown>[] } ).tools;
		expect( tools.map( t => t[ 'name' ] ) ).toEqual( VAULT_TOOL_OPS.map( op => DAEDALUS[ op ] ) );

		for ( const op of VAULT_TOOL_OPS ) {
			const spec = VaultTools.spec( op, DAEDALUS );
			const shipped = tools.find( t => t[ 'name' ] === DAEDALUS[ op ] )!;
			expect( shipped[ 'description' ], op ).toEqual( spec.description );
			expect( shipped[ 'doc' ],         op ).toEqual( spec.doc );
			expect( shipped[ 'inputSchema' ], op ).toEqual( spec.inputSchema );
			expect( shipped[ 'annotations' ], op ).toEqual( spec.annotations );
			// `example` on the wire may be borrowed from the first verify spec, which lives on the face.
			if ( spec.example ) expect( shipped[ 'example' ], op ).toEqual( spec.example );
		}
	} );
} );
