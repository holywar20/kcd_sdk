import { describe, expect, it, vi } from 'vitest';

import { McpServer } from '../McpServer';

/**
 * `handleLine` contains a malformed frame: the promise RESOLVES and a JSON-RPC error frame goes out on
 * stdout. `starmind_dev/src/mcp/McpServer.ts` is a deliberate hand-maintained twin of this module; keep
 * the two in step by hand (the matching test is `starmind_dev/src/__tests__/frame.test.ts`).
 */

/** Drive one line through the private handler and collect every frame it wrote to stdout.
 *  stdout is the protocol wire here, so reading it is reading the server's answer. */
async function feed( line: string ): Promise<Record<string, unknown>[]> {
	const mcp     = new McpServer( { name: 'test', version: '0' } );
	const written: string[] = [];

	const spy = vi.spyOn( process.stdout, 'write' ).mockImplementation( ( chunk: unknown ) => {
		written.push( String( chunk ) );
		return true;
	} );

	try {
		// RESOLVES, NEVER REJECTS. `.resolves` is the assertion — a rejection here is the defect.
		await expect(
			( mcp as unknown as { handleLine( l: string ): Promise<void> } ).handleLine( line )
		).resolves.toBeUndefined();
	} finally {
		spy.mockRestore();
	}

	return written.map( ( w ) => JSON.parse( w ) as Record<string, unknown> );
}

describe( 'handleLine — a frame that is not an object', () => {

	// -32600 INVALID_REQUEST, -32700 PARSE_ERROR. Not exported from the module; written as literals
	// because the wire codes are what a client actually reads.
	const INVALID_REQUEST = -32600;
	const PARSE_ERROR     = -32700;

	it( 'contains a bare `null` rather than throwing out of the handler', async () => {
		// Valid JSON that parses to `null`: `null.method` throws, so this is the case the containment guards.
		const frames = await feed( 'null' );

		expect( frames ).toHaveLength( 1 );
		expect( ( frames[ 0 ]!.error as { code: number } ).code ).toBe( INVALID_REQUEST );
	} );

	it( 'contains a bare number, string, boolean and array without replying to any of them', async () => {
		// These do not throw: `(7).method` is undefined. They take the missing-method path and, with no id,
		// are owed no reply. Pinned so the silence reads as deliberate, not as a swallowed throw.
		for ( const line of [ '7', '"x"', 'true', '[]' ] ) {
			expect( await feed( line ), line ).toEqual( [] );
		}
	} );

	it( 'still answers a genuinely unparseable line with a parse error', async () => {
		// FENCE: a parse failure and a non-request are owed different codes, so a truncated line stays distinct.
		const frames = await feed( '{ not json' );

		expect( frames ).toHaveLength( 1 );
		expect( ( frames[ 0 ]!.error as { code: number } ).code ).toBe( PARSE_ERROR );
	} );

	it( 'still answers a well-formed request, so the restructure changed no live path', async () => {
		const frames = await feed( JSON.stringify( { jsonrpc: '2.0', id: 1, method: 'ping' } ) );

		expect( frames ).toHaveLength( 1 );
		expect( frames[ 0 ]!.id ).toBe( 1 );
		expect( frames[ 0 ]!.result ).toEqual( {} );
		expect( frames[ 0 ]!.error ).toBeUndefined();
	} );

	it( 'says nothing at all to a malformed NOTIFICATION, which is owed no reply', async () => {
		// An object with no method and no id is a notification nobody can answer. Silence is correct.
		const frames = await feed( JSON.stringify( { jsonrpc: '2.0' } ) );

		expect( frames ).toHaveLength( 0 );
	} );
} );
