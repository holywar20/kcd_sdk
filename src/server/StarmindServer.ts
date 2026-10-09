import { McpServer } from './McpServer';
import type { ToolDefinition, ToolResult } from './McpServer';
import type { ServerManifest } from './manifest';
import { runVerify } from './verify';
import type { Registration, TestSpec, VerifyReport } from './verify';

/**
 * StarmindServer — the abstract base every internal MCP server extends. It owns one McpServer (the wire), a registry of
 * tools-with-tests, and the three-verb lifecycle: build() (subclass hook), verify() (proves every tool against its
 * TestSpecs) and run() (build, then serve on stdio until the client disconnects).
 *
 * Registering a tool also attaches its TestSpecs, so the proof of correctness lives next to the tool.
 */
export abstract class StarmindServer {

	/**
	 * Declared by every subclass. Read statically so tooling can inventory a
	 * server without constructing one (the promotion script reads it directly).
	 */
	static manifest: ServerManifest;

	protected server: McpServer;
	private registrations: Registration[] = [];
	private built = false;

	constructor() {
		const m = this.ownManifest();
		this.server = new McpServer( { name: m.name, version: m.version } );
	}

	/** Subclass hook: register every tool here via registerTool(). Runs once. */
	abstract build(): void;

	/**
	 * Register a tool and (optionally) the TestSpecs that verify it. The wire fields pass through to the McpServer;
	 * the spec is stashed for verify().
	 */
	protected registerTool( def: ToolDefinition & { spec?: TestSpec[] } ): void {
		const { spec, ...tool } = def;
		// An explicit `example` wins; otherwise the first spec's input doubles as the inspector sample.
		const example = tool.example ?? spec?.[ 0 ]?.input;
		this.server.registerTool( example ? { ...tool, example } : tool );
		this.registrations.push( { def: tool, spec: spec ?? [] } );
	}

	/** Prove every tool against its TestSpecs, in-process. Delegated to verify.ts. */
	async verify(): Promise<VerifyReport> {
		this.ensureBuilt();
		return runVerify( this.registrations, this.ownManifest() );
	}

	/** The built wire tool surface, read without spawning the server. The promotion script snapshots it. */
	wireTools(): Record<string, unknown>[] {
		this.ensureBuilt();
		return this.server.listTools();
	}

	/** Build the tool surface, then serve it on stdio until the client disconnects. */
	async run(): Promise<void> {
		this.ensureBuilt();
		await this.server.connect();
	}

	/**
	 * Run a registered tool in-process by name, the seam a COMPOSING tool dispatches through. Same contract as a wire
	 * call, since it delegates to the McpServer's own dispatch.
	 */
	invoke( name: string, args: Record<string, unknown> ): Promise<ToolResult> {
		this.ensureBuilt();
		return this.server.invoke( name, args );
	}

	// ── Internals ─────────────────────────────────────────────────────────────────

	private ensureBuilt(): void {
		if ( this.built ) return;
		this.build();
		this.built = true;
	}

	/** The subclass's static manifest, reached through the instance's constructor. */
	private ownManifest(): ServerManifest {
		return ( this.constructor as typeof StarmindServer ).manifest;
	}

	// ── Live doc ──────────────────────────────────────────────────────────────────

	/**
	 * The server's doc-block as served right now. Default: the static manifest's authored `doc`, unchanged.
	 *
	 * ── NOTHING PER-SESSION MAY BE FOLDED IN HERE. READ THIS BEFORE OVERRIDING. ──
	 * One copy of a server answers for SEVERAL SESSIONS at once, and there is no call in scope to say whose doc is being
	 * asked for. Workspace state folded in is whichever session resolved last: one session's paths handed to another.
	 * MCP has no call that asks a running server for its documentation, so the host reads the static manifest doc off disk.
	 *
	 * Session-shaped answers belong in a TOOL, which receives the call's `_meta` and can answer per caller. A per-SERVER
	 * fact (a build stamp, a protocol version) belongs in the handshake, where a client reads it.
	 */
	liveDoc(): string {
		return this.ownManifest().doc ?? '';
	}
}
