import * as readline from 'readline';

/**
 * McpServer — a dependency-free MCP server over stdio, hand-rolled to escape the `@modelcontextprotocol/sdk` + zod type
 * graph, which OOMs `tsc` (the dist must be built with esbuild). Newline-delimited JSON-RPC 2.0, one UTF-8 JSON message
 * per line, with no embedded newlines.
 *
 * stdout carries protocol messages ONLY: all diagnostics go to stderr, or they corrupt the stream.
 *
 * Errors split the MCP way: a malformed call or unknown method is a protocol error the model never sees; a handler that
 * fails returns an `isError` result the model can act on. Handlers never throw across this boundary.
 */

/** A single block of tool output. Text is the only type this server emits. */
export type ContentBlock = { type: 'text'; text: string };

/** What a tool handler returns. Mirrors the MCP `tools/call` result shape. */
export type ToolResult = {
	content:  ContentBlock[];
	isError?: boolean;
};

/** Client-facing hints with no effect on execution, forwarded verbatim in `tools/list`. Mirrors the MCP spec's tool annotations. */
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
	/** A ready-to-run sample input, emitted in `tools/list` so an inspector can prefill a call. StarmindServer fills it
	 *  from the first verify spec, so the example a user sees is the one that was tested. */
	example?: Record<string, unknown>;
	/** The expanded doc-block: the tool's own account of its params, returns and edge cases. `description` is the one-liner
	 *  on the wire; `doc` is the full read a surface fetches on demand. */
	doc?:        string;
	/** `meta` is the call's out-of-band envelope: JSON-RPC's `_meta`, written by the CLIENT and never by the model (see
	 *  Authorization). A handler FORWARDS it and never reads it, since only a guard interprets an envelope: a tool holds
	 *  nothing it could strip, rewrite or synthesize. */
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

// Echoed in `initialize`. A client asking for another version gets its own echoed back: clients negotiate down.
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

		// Every read of `msg` sits inside a try: `null`, `7` and `"x"` parse cleanly and throw on the first property read,
		// and a rejected promise from here is a process fault under `void`. Two tries because there are two failures with
		// two answers: a frame that is not a request (INVALID_REQUEST, no id to answer on), and a handler that failed inside
		// a well-formed request (INVALID_PARAMS, answered on its id). One catch would make the two indistinguishable.
		// Kept in step with the vendored copy at starmind_dev/src/mcp/McpServer.ts.
		try {
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
		} catch {
			// REACHED ONLY BY A FRAME THAT IS NOT AN OBJECT — there is no `id` on it to answer against,
			// so the reply goes out id-less, exactly as the parse error above does.
			this.sendError( null, INVALID_REQUEST, 'Invalid request: frame is not a JSON-RPC object' );
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
	 * The wire tool surface, exposed so tooling can read a built server without spawning it: the promotion script regenerates
	 * the committed `tools.snapshot.json` from this, authoritative because it is the same projection the wire uses.
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
	 * The refusal for argument keys the tool does not declare, or null when they all check out. A mis-named parameter must
	 * be an error, not a silent answer to a question nobody asked.
	 */
	static unknownArgs( tool: ToolDefinition, args: Record<string, unknown> ): string | null {
		const schema = tool.inputSchema;

		// Opt-out is read at the TOP level only: a nested object that sets it means that object, not the call.
		if ( schema[ 'additionalProperties' ] === true ) return null;

		// Nothing to compare against is not a claim that nothing is allowed.
		const declared = Object.keys( ( schema[ 'properties' ] ?? {} ) as Record<string, unknown> );
		if ( declared.length === 0 ) return null;

		const unknown = Object.keys( args ).filter( ( key ) => !declared.includes( key ) );
		if ( unknown.length === 0 ) return null;

		return `${ tool.name } does not take ${ unknown.join( ', ' ) } — it takes ${ declared.join( ', ' ) }`;
	}

	/**
	 * Run a registered tool in-process by name, the dispatch a COMPOSING tool (e.g. a batch) uses. Same contract as a wire
	 * call: a throw folds into an isError result, and so does an unknown tool, since there is no protocol layer here.
	 * Unrecognised arguments are refused the same way, because the model has to SEE that one to correct it.
	 *
	 * `meta` MUST be threaded explicitly, and is not part of the argument check. A composing tool that forgets it runs its
	 * inner call with LESS authority, never a stale one: there is no ambient per-call state to inherit from.
	 */
	async invoke( name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {} ): Promise<ToolResult> {
		const tool = this.tools.get( name );
		if ( !tool ) return { content: [ { type: 'text', text: `Unknown tool: ${ name }` } ], isError: true };

		const badArgs = McpServer.unknownArgs( tool, args );
		if ( badArgs ) return { content: [ { type: 'text', text: badArgs } ], isError: true };

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
