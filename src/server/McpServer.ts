import * as readline from 'readline';

/**
 * McpServer — a dependency-free MCP server over stdio.
 *
 * Rolled by hand to escape the `@modelcontextprotocol/sdk` + zod type graph, which
 * OOMs `tsc` at 4GB (the dist must be built with esbuild to dodge it). This is the
 * whole wire protocol in one file: newline-delimited JSON-RPC 2.0 on stdin/stdout,
 * the MCP `initialize` handshake, and `tools/list` / `tools/call`. No external deps —
 * only Node builtins — so it lives in kcd_sdk and every server reuses it.
 *
 * Transport contract (MCP stdio): every message is a single line of UTF-8 JSON
 * terminated by '\n', with no embedded newlines. stdout carries protocol messages
 * ONLY — all diagnostics go to stderr, or they corrupt the stream.
 *
 * Errors are split the MCP way: a malformed call or unknown method is a JSON-RPC
 * *protocol* error (the model never sees it); a handler that fails returns an
 * `isError` tool result (the model sees it and can self-correct). Handlers therefore
 * never throw across this boundary — McpServer catches and folds for them.
 */

/** A single block of tool output. Text is the only type this server emits. */
export type ContentBlock = { type: 'text'; text: string };

/** What a tool handler returns. Mirrors the MCP `tools/call` result shape. */
export type ToolResult = {
	content:  ContentBlock[];
	isError?: boolean;
};

/** Client-facing tool hints (no effect on execution) — forwarded verbatim in `tools/list`
 *  so a client can badge a tool read-only vs. destructive. All optional; mirrors the MCP
 *  spec's tool annotations. */
export interface ToolAnnotations {
	title?:           string;
	readOnlyHint?:    boolean;
	destructiveHint?: boolean;
	idempotentHint?:  boolean;
	openWorldHint?:   boolean;
}

/** One registered tool: its wire descriptor plus the handler that runs it. */
export interface ToolDefinition {
	name:        string;
	description: string;
	/** Plain JSON Schema object — no zod. Sent verbatim in `tools/list`. */
	inputSchema: Record<string, unknown>;
	/** Optional client hints (read-only / destructive). Emitted in `tools/list` when present. */
	annotations?: ToolAnnotations;
	/** An idiomatic sample input — a ready-to-run example of what this tool expects. Emitted in
	 *  `tools/list` so an inspector can prepopulate a call. StarmindServer fills it from the first
	 *  verify spec by default (the example you test with is the example a user sees). */
	example?: Record<string, unknown>;
	/** The expanded doc-block — the tool's own account of its capacity (params, returns, edge cases),
	 *  the rich half of the two-tier model. `description` is the one-liner on the wire; `doc` is the
	 *  full read a surface fetches on demand. Emitted in `tools/list` when present. */
	doc?:        string;
	/** `meta` is the call's out-of-band envelope — JSON-RPC's `_meta`, which rides BESIDE `arguments`
	 *  and is written by the CLIENT, never by the model ( see Authorization ). Optional, so a handler with
	 *  no interest in it stays a one-parameter function.
	 *
	 *  A handler FORWARDS it and never reads it: only a guard interprets an envelope. That asymmetry is
	 *  the containment — a tool holds nothing it could strip, rewrite or synthesize, so passing it
	 *  along is the only thing it can do with it. */
	handler:     ( args: Record<string, unknown>, meta?: Record<string, unknown> ) => Promise<ToolResult>;
}

export interface ServerInfo {
	name:    string;
	version: string;
}

// ── JSON-RPC shapes ───────────────────────────────────────────────────────────

type JsonRpcId = string | number;

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?:     JsonRpcId;        // absent → notification (no response owed)
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?:  { code: number; message: string };
}

// Standard JSON-RPC 2.0 error codes.
const PARSE_ERROR      = -32700;
const INVALID_REQUEST  = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS   = -32602;

// MCP protocol version this server speaks. Echoed in the initialize result; if the
// client requests a different one we still echo theirs back (clients negotiate down).
const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {

	private tools = new Map<string, ToolDefinition>();

	constructor( private info: ServerInfo ) {}

	/** Register a tool. Last registration of a name wins. */
	registerTool( def: ToolDefinition ): void {
		this.tools.set( def.name, def );
	}

	/**
	 * Start the read loop. Resolves when stdin closes (client disconnected) — the
	 * caller can then exit. Each input line is one JSON-RPC message.
	 */
	connect(): Promise<void> {
		const rl = readline.createInterface( { input: process.stdin } );

		rl.on( 'line', ( line ) => {
			const trimmed = line.trim();
			if ( trimmed.length === 0 ) return;
			void this.handleLine( trimmed );
		} );

		return new Promise( ( resolve ) => rl.on( 'close', resolve ) );
	}

	// ── Dispatch ────────────────────────────────────────────────────────────────

	private async handleLine( line: string ): Promise<void> {
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse( line ) as JsonRpcMessage;
		} catch {
			this.sendError( null, PARSE_ERROR, 'Parse error: invalid JSON' );
			return;
		}

		if ( typeof msg.method !== 'string' ) {
			if ( msg.id !== undefined ) this.sendError( msg.id, INVALID_REQUEST, 'Invalid request: missing method' );
			return;
		}

		// Notifications carry no id and are owed no response (e.g. notifications/initialized).
		const isNotification = msg.id === undefined;

		try {
			switch ( msg.method ) {
				case 'initialize':
					this.reply( msg.id!, this.onInitialize( msg.params ) );
					return;

				case 'tools/list':
					this.reply( msg.id!, this.onToolsList() );
					return;

				case 'tools/call':
					this.reply( msg.id!, await this.onToolsCall( msg.params ) );
					return;

				case 'ping':
					this.reply( msg.id!, {} );
					return;

				default:
					// Unknown notifications are silently ignored; unknown requests get an error.
					if ( !isNotification ) this.sendError( msg.id!, METHOD_NOT_FOUND, `Method not found: ${ msg.method }` );
					return;
			}
		} catch ( e ) {
			if ( !isNotification ) this.sendError( msg.id!, INVALID_PARAMS, errorText( e ) );
		}
	}

	// ── Method handlers ───────────────────────────────────────────────────────────

	private onInitialize( params?: Record<string, unknown> ): unknown {
		const requested = typeof params?.[ 'protocolVersion' ] === 'string'
			? params[ 'protocolVersion' ] as string
			: PROTOCOL_VERSION;

		return {
			protocolVersion: requested,
			capabilities:    { tools: {} },
			serverInfo:      { name: this.info.name, version: this.info.version },
		};
	}

	/**
	 * The wire tool surface — the exact array `tools/list` sends, exposed publicly so tooling can read a
	 * built server's surface WITHOUT spawning it over stdio (the promotion script regenerates the committed
	 * `tools.snapshot.json` from this — authoritative by construction, since it is the same projection the
	 * wire uses). No handlers, no protocol framing: just the descriptors a client sees.
	 */
	listTools(): Record<string, unknown>[] {
		return [ ...this.tools.values() ].map( ( t ) => ( {
			name:        t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			// Only emit the key when a tool declares hints — a client sees `annotations` or nothing.
			...( t.annotations ? { annotations: t.annotations } : {} ),
			...( t.example ? { example: t.example } : {} ),
			...( t.doc ? { doc: t.doc } : {} ),
		} ) );
	}

	private onToolsList(): unknown {
		return { tools: this.listTools() };
	}

	private async onToolsCall( params?: Record<string, unknown> ): Promise<ToolResult> {
		const name = params?.[ 'name' ];
		if ( typeof name !== 'string' ) {
			throw new Error( 'tools/call requires a string "name"' );
		}

		const tool = this.tools.get( name );
		if ( !tool ) {
			throw new Error( `Unknown tool: ${ name }` );
		}

		const args = ( params?.[ 'arguments' ] ?? {} ) as Record<string, unknown>;
		// `_meta` sits BESIDE `arguments` on params — outside the tool's inputSchema, and therefore
		// outside anything the model can author. Carried opaquely from here to the guards; see Authorization.
		const meta = ( params?.[ '_meta' ] ?? {} ) as Record<string, unknown>;
		return this.invoke( name, args, meta );
	}

	/**
	 * Run a registered tool in-process by name — the dispatch a COMPOSING tool ( e.g. a batch ) uses
	 * without going over the wire. Same contract as a wire call: a handler that throws folds into an
	 * isError result, never propagating. An unknown tool is an isError result too — unlike a wire
	 * tools/call ( which raises a protocol error ), there is no protocol layer here, so a caller can
	 * treat every outcome uniformly as a ToolResult.
	 *
	 * `meta` MUST be threaded explicitly: a composing tool has to pass its own envelope through, or the
	 * inner call runs with LESS authority than the outer one. That direction is deliberate. A batch that
	 * forgets loses an exception; it can never INHERIT a stale one, because there is no ambient per-call
	 * state here to inherit from — which is exactly what an ambient stash would have made possible.
	 */
	async invoke( name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {} ): Promise<ToolResult> {
		const tool = this.tools.get( name );
		if ( !tool ) return { content: [ { type: 'text', text: `Unknown tool: ${ name }` } ], isError: true };
		try {
			return await tool.handler( args, meta );
		} catch ( e ) {
			return { content: [ { type: 'text', text: errorText( e ) } ], isError: true };
		}
	}

	// ── Wire I/O ──────────────────────────────────────────────────────────────────

	private reply( id: JsonRpcId, result: unknown ): void {
		this.write( { jsonrpc: '2.0', id, result } );
	}

	private sendError( id: JsonRpcId | null, code: number, message: string ): void {
		this.write( { jsonrpc: '2.0', id: id ?? undefined, error: { code, message } } );
	}

	private write( msg: JsonRpcMessage ): void {
		process.stdout.write( JSON.stringify( msg ) + '\n' );
	}
}

function errorText( e: unknown ): string {
	return e instanceof Error ? e.message : String( e );
}
