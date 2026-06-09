import type { ToolDefinition, ToolResult } from './McpServer';
import type { ServerManifest } from './manifest';

/**
 * verify.ts — the verification utility.
 *
 * The whole "prove a server works" capability in one place: the vocabulary a
 * server author writes (TestSpec + Assertion), the report it produces
 * (VerifyReport), and the engine that interprets one against the other
 * (runVerify). Assertions are data, not code — editable through a future
 * authoring UI, never compiled.
 *
 * runVerify() takes a server's registered tools and its manifest, runs every
 * tool's TestSpecs against its live handler in-process (no transport), and hands
 * back a dated report. It mirrors McpServer's error contract: a handler that
 * throws is folded to an isError result, exactly as it would be on the wire.
 */

/**
 * Assertion — one data-driven check the runner interprets against a tool result.
 * Keys are top-level only (no dotted paths) for now.
 */
export type Assertion =
	| { type: 'has_key';        key: string }
	| { type: 'type_is';        key: string; expected: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' }
	| { type: 'value_eq';       key: string; expected: unknown }
	| { type: 'error_expected' };

/**
 * TestSpec — one verification case for a tool: an input and the assertions its
 * result must satisfy. A spec carrying an `error_expected` assertion checks only
 * that the call failed (isError); its value assertions are ignored.
 */
export interface TestSpec {
	label:      string;
	input:      Record<string, unknown>;
	assertions: Assertion[];
}

/**
 * VerifyReport — the dated proof record written at promotion. `overall` is
 * 'pass' only when no tool has a failing case.
 */
export interface VerifyReport {
	server_id: string;
	version:   string;
	timestamp: string;                    // ISO 8601 — when runVerify ran
	tools: {
		name:   string;
		passed: number;
		failed: number;
		cases:  { label: string; pass: boolean; detail?: string }[];
	}[];
	overall: 'pass' | 'fail';
}

/** A tool registration paired with the cases that prove it — runVerify's input. */
export type Registration = { def: ToolDefinition; spec: TestSpec[] };

/**
 * Run every tool's TestSpecs against its live handler, in-process — no transport.
 * The manifest supplies the report's identity (server_id, version).
 */
export async function runVerify(
	registrations: Registration[],
	manifest:      ServerManifest,
): Promise<VerifyReport> {
	const tools: VerifyReport[ 'tools' ] = [];
	for ( const { def, spec } of registrations ) {
		const cases: VerifyReport[ 'tools' ][ number ][ 'cases' ] = [];
		for ( const tc of spec ) cases.push( await runCase( def, tc ) );
		const passed = cases.filter( ( c ) => c.pass ).length;
		tools.push( { name: def.name, passed, failed: cases.length - passed, cases } );
	}

	return {
		server_id: manifest.id,
		version:   manifest.version,
		timestamp: new Date().toISOString(),
		tools,
		overall:   tools.every( ( t ) => t.failed === 0 ) ? 'pass' : 'fail',
	};
}

/** Run one case: invoke the handler, fold a throw to isError, judge assertions. */
async function runCase(
	def: ToolDefinition,
	tc:  TestSpec,
): Promise<{ label: string; pass: boolean; detail?: string }> {
	let result: ToolResult;
	try {
		result = await def.handler( tc.input );
	} catch ( e ) {
		result = { content: [ { type: 'text', text: errorText( e ) } ], isError: true };
	}
	return { label: tc.label, ...judge( tc.assertions, result ) };
}

/** Judge a result against a case's assertions. The first failure wins the detail. */
function judge( assertions: Assertion[], result: ToolResult ): { pass: boolean; detail?: string } {
	// error_expected: the case checks only that the call failed — value assertions ignored.
	if ( assertions.some( ( a ) => a.type === 'error_expected' ) ) {
		return result.isError === true
			? { pass: true }
			: { pass: false, detail: 'expected an error result, got success' };
	}

	if ( result.isError ) {
		return { pass: false, detail: `unexpected error: ${ textOf( result ) }` };
	}

	let data: Record<string, unknown>;
	try {
		data = JSON.parse( textOf( result ) ) as Record<string, unknown>;
	} catch {
		return { pass: false, detail: 'result payload was not JSON' };
	}

	for ( const a of assertions ) {
		const detail = checkOne( a, data );
		if ( detail ) return { pass: false, detail };
	}
	return { pass: true };
}

/** Check one assertion; returns a failure detail, or '' on pass. */
function checkOne( a: Assertion, data: Record<string, unknown> ): string {
	switch ( a.type ) {
		case 'has_key':
			return a.key in data ? '' : `missing key "${ a.key }"`;
		case 'type_is': {
			const actual = typeName( data[ a.key ] );
			return actual === a.expected ? '' : `key "${ a.key }" is ${ actual }, expected ${ a.expected }`;
		}
		case 'value_eq':
			return JSON.stringify( data[ a.key ] ) === JSON.stringify( a.expected )
				? ''
				: `key "${ a.key }" did not equal the expected value`;
		case 'error_expected':
			return '';   // resolved in judge() before the value pass
	}
}

/** The JS runtime type name, with array and null split out from typeof. */
function typeName( v: unknown ): string {
	if ( v === null ) return 'null';
	if ( Array.isArray( v ) ) return 'array';
	return typeof v;
}

function textOf( result: ToolResult ): string {
	return result.content[ 0 ]?.text ?? '';
}

function errorText( e: unknown ): string {
	return e instanceof Error ? e.message : String( e );
}
