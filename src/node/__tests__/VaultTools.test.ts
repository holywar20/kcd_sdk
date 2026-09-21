import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Vault } from '../Vault';
import { VaultTools, VAULT_TOOL_OPS } from '../VaultTools';
import type { VaultToolNames, VaultToolOp } from '../VaultTools';
import type { ToolResult } from '../../server/McpServer';

/**
 * VaultTools — the one engine behind Starmind's `sm_documentation` keystones.
 *
 * A face calls these ops under its own names, so what is worth pinning is what a FACE cannot get
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

	/**
	 * THE SILENT DROP — a document on disk that no query returns, and nothing says why.
	 *
	 * A file that fails to parse is absent from the scan, which is correct. Being absent from the ANSWER
	 * with no signal is not: it reads identically to "no such document", so a reader hunting a file that
	 * is right there learns nothing and has no way to learn it. That cost a real agent twenty minutes
	 * over `_lens-base.html`, found in the end by falling back to a raw file glob.
	 */
	describe( 'a document it cannot parse', () => {

		beforeEach( () => { put( '_Claude/references/patterns/broken.html', '<not an artifact at all' ); } );

		it( 'names it above the results instead of leaving absence as the only clue', () => {
			const said = text( tools().query( {} ) );

			expect( said ).toContain( 'could not be parsed' );
			expect( said ).toContain( 'references/patterns/broken.html' );
			// The reader is pointed at the tool that says WHY, under this face's own name for it.
			expect( said ).toContain( 'check' );
		} );

		it( 'still answers the query — the note leads the results, it does not replace them', () => {
			const said = text( tools().query( {} ) );
			const refs = JSON.parse( said.slice( said.indexOf( '[' ) ) ) as { path: string }[];

			expect( refs.map( r => r.path ).sort() ).toEqual( [ 'references/patterns/alpha.html', 'references/patterns/beta.html' ] );
		} );

		it( 'reports it under a glob that reaches it, and stays quiet under one that does not', () => {
			expect( text( tools().query( { glob: 'references/**' } ) ) ).toContain( 'broken.html' );
			expect( text( tools().query( { glob: 'lenses/**' } ) ) ).not.toContain( 'could not be parsed' );
		} );

		it( 'reports it even under a type or text filter, which it could not have been measured against', () => {
			// Both filters need a parsed document. Applying them to one that has none would be inventing an
			// answer — and this is exactly the search where the silence misleads most.
			expect( text( tools().query( { type: 'lens' } ) ) ).toContain( 'broken.html' );
			expect( text( tools().query( { text: 'nothing matches this' } ) ) ).toContain( 'broken.html' );
		} );
	} );

	it( 'answers a clean query with the bare array it always did, and no preamble', () => {
		// The advisory is a fact about the query rather than a row of it, so a vault with nothing wrong
		// pays nothing for the feature — not a wrapper, not a header, not a token.
		expect( text( tools().query( { type: 'reference' } ) ).trimStart().startsWith( '[' ) ).toBe( true );
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

	/** An artifact that validates, for the cases that need a write to be REACHED. */
	const authored = ( name: string, overview: string ): Record<string, unknown> => ( {
		type:        'reference',
		frontmatter: { name, description: 'Authored by content.', type: 'reference', status: 'active' },
		content:     { sections: { why: 'when a test needs a write to land', overview } },
	} );
	const alpha = (): string => readFileSync( join( root, '_Claude', 'references', 'patterns', 'alpha.html' ), 'utf-8' );

	it( 'save with create refuses a path that already holds a document, and lands nothing', () => {
		// bug-report-20. Two filers took "one past the highest on disk" from one listing, and the second write
		// replaced the first unseen. `create` makes the write exclusive: the loser is refused, not merged away.
		const before = alpha();
		const r = tools().save( { path: 'references/patterns/alpha.html', create: true, artifact: authored( 'alpha', 'The second filer.' ) } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'write refused "references/patterns/alpha.html": it already exists' );
		expect( text( r ) ).toContain( 'omit `create`' );
		expect( alpha() ).toBe( before );
		expect( wrote ).toEqual( [] );
	} );

	it( 'save with create files a path that holds nothing yet', () => {
		const r = tools().save( { path: 'references/domain/delta.html', create: true, artifact: authored( 'delta', 'The first filer.' ) } );
		expect( r.isError ).toBeUndefined();
		expect( readFileSync( join( root, '_Claude', 'references', 'domain', 'delta.html' ), 'utf-8' ) ).toContain( 'The first filer.' );
	} );

	it( 'save without create still replaces — an edit is an overwrite by design', () => {
		const r = tools().save( { path: 'references/patterns/alpha.html', artifact: authored( 'alpha', 'Edited in place.' ) } );
		expect( r.isError ).toBeUndefined();
		expect( alpha() ).toContain( 'Edited in place.' );
	} );

	it( 'saves an artifact read at full and sent straight back as body, one passage altered', () => {
		// bug-report-25 claimed this EDIT path was unusable. It is the report's own reproduction, frontmatter block
		// stripped from the body as the schema asks, and it lands with the edit intact.
		const read = json( tools().get( { path: 'references/patterns/alpha.html', full: true } ) );
		const body = String( read[ 'body' ] );
		const stripped = body.slice( body.indexOf( '</dl>' ) + '</dl>'.length ).replace( 'The target.', 'The altered target.' );

		const r = tools().save( { path: 'references/patterns/alpha.html', artifact: { type: read[ 'type' ], frontmatter: read[ 'frontmatter' ], body: stripped } } );
		expect( r.isError, text( r ) ).toBeUndefined();
		expect( alpha() ).toContain( 'The altered target.' );
		expect( alpha() ).toContain( 'data-kcd-field="name"' );
	} );

	it( 'refuses an artifact with no frontmatter BY NAME on the edit path, instead of leaking a TypeError', () => {
		const r = tools().save( { path: 'references/patterns/alpha.html', artifact: { type: 'reference', body: '<h1>alpha</h1>' } } );
		expect( r.isError ).toBe( true );
		expect( text( r ) ).toContain( 'write refused "references/patterns/alpha.html": `artifact.frontmatter` must be an object' );
		expect( text( r ) ).toContain( 'this call carried none' );
		expect( text( r ) ).not.toContain( 'Cannot convert' );
		expect( wrote ).toEqual( [] );
	} );

	it( 'refuses the same way on the authoring path, and names what arrived when it is not an object', () => {
		const missing = tools().save( { path: 'references/domain/x.html', artifact: { type: 'reference', content: { sections: { why: 'x' } } } } );
		expect( text( missing ) ).toContain( '`artifact.frontmatter` must be an object' );

		const asMarkup = tools().save( { path: 'references/domain/x.html', artifact: { type: 'reference', frontmatter: '<dl data-kcd-frontmatter></dl>', body: '<h1>x</h1>' } } );
		expect( text( asMarkup ) ).toContain( 'this call carried a string' );
		expect( text( asMarkup ) ).toContain( 'read with `full: true`' );
		expect( existsSync( join( root, '_Claude', 'references', 'domain', 'x.html' ) ) ).toBe( false );
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

describe( 'VaultTools — batch runs the FACE\'s dispatch, every call, one result each', () => {

	const invoke = ( t: VaultTools ) => async ( name: string, args: Record<string, unknown> ): Promise<ToolResult> => {
		const op = ( Object.keys( NAMES ) as VaultToolOp[] ).find( ( o ) => NAMES[ o ] === name );
		if ( !op || op === 'batch' ) return VaultTools.error( `Unknown tool: ${ name }` );
		return t[ op ]( args );
	};

	type Step = { tool: string; ok: boolean; output: string };
	const steps = ( r: Record<string, unknown> ): Step[] => r[ 'results' ] as Step[];

	it( 'completes a read sequence in order', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'find', args: { groupBy: 'type' } }, { tool: 'read', args: { path: 'references/patterns/alpha.html' } } ] }, invoke( t ) ) );
		expect( steps( r ).map( s => [ s.tool, s.ok ] ) ).toEqual( [ [ 'find', true ], [ 'read', true ] ] );
	} );

	it( 'runs the calls AFTER a failure — a batch is not a transaction — and never throws', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'find' }, { tool: 'does-not-exist' }, { tool: 'read', args: { path: 'references/patterns/alpha.html' } } ] }, invoke( t ) ) );
		expect( steps( r ).map( s => [ s.tool, s.ok ] ) ).toEqual( [ [ 'find', true ], [ 'does-not-exist', false ], [ 'read', true ] ] );
		expect( steps( r )[ 1 ]!.output ).toBe( 'Unknown tool: does-not-exist' );
	} );

	it( 'carries a step\'s reply VERBATIM, and hands the face each call\'s position', async () => {
		const t    = tools();
		const seen: number[] = [];
		const reply = 'refused — "x.y" is turned off, in words a model reads\n  with its whitespace';
		const r    = json( await t.batch( { calls: [ { tool: 'find' }, { tool: 'read' } ] }, async ( _name, _args, index ) => {
			seen.push( index );
			return { content: [ { type: 'text', text: reply } ], isError: true };
		} ) );
		expect( seen ).toEqual( [ 0, 1 ] );
		for ( const step of steps( r ) ) expect( step ).toMatchObject( { ok: false, output: reply } );
	} );

	it( 'reports a throwing face as that one step\'s failure, and runs the rest', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'find' }, { tool: 'read', args: { path: 'references/patterns/alpha.html' } } ] }, async ( name, args, index ) => {
			if ( index === 0 ) throw new Error( 'the face fell over' );
			return invoke( t )( name, args );
		} ) );
		expect( steps( r )[ 0 ] ).toEqual( { tool: 'find', ok: false, output: 'the face fell over' } );
		expect( steps( r )[ 1 ]!.ok ).toBe( true );
	} );

	it( 'reports a nested batch and a nameless call as failed steps, under this face\'s own name', async () => {
		const t = tools();
		const r = json( await t.batch( { calls: [ { tool: 'run', args: { calls: [] } }, {}, { tool: 'find' } ] }, invoke( t ) ) );
		expect( steps( r ).slice( 0, 2 ) ).toEqual( [
			{ tool: 'run', ok: false, output: 'run cannot be nested' },
			{ tool: '',    ok: false, output: 'call is missing a "tool" name' },
		] );
		expect( steps( r )[ 2 ]!.ok ).toBe( true );
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
} );
