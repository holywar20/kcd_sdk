import { McpServer } from './McpServer';
import type { ToolDefinition, ToolResult } from './McpServer';
import type { ServerManifest } from './manifest';
import { runVerify } from './verify';
import type { Registration, TestSpec, VerifyReport } from './verify';

/**
 * StarmindServer — the abstract base every internal MCP server extends.
 *
 * It owns one McpServer (the wire), a registry of tools-with-tests, and the
 * three-verb lifecycle a server needs:
 *
 *   build()   — subclass hook; register every tool here.
 *   verify()  — prove every tool against its TestSpecs (delegated to verify.ts).
 *   run()     — build, then serve on stdio until the client disconnects.
 *
 * A server author writes a subclass, declares `static manifest`, and fills
 * build() with registerTool() calls. The inversion from a plain MCP server:
 * registering a tool also attaches its TestSpecs, so the proof of correctness
 * lives next to the tool.
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
	 * Register a tool and (optionally) the TestSpecs that verify it, in one call.
	 * Config-object shape — mirrors Anthropic's tool descriptor. The wire fields
	 * pass through to the McpServer; the spec is stashed for verify().
	 */
	protected registerTool( def: ToolDefinition & { spec?: TestSpec[] } ): void {
		const { spec, ...tool } = def;
		// House convention: the first verify input doubles as the tool's inspector sample — the
		// example you prove a tool with is the example a user sees prepopulated. An explicit
		// `example` on the def wins; otherwise borrow the first spec's input.
		const example = tool.example ?? spec?.[ 0 ]?.input;
		this.server.registerTool( example ? { ...tool, example } : tool );
		this.registrations.push( { def: tool, spec: spec ?? [] } );
	}

	/** Prove every tool against its TestSpecs, in-process. Delegated to verify.ts. */
	async verify(): Promise<VerifyReport> {
		this.ensureBuilt();
		return runVerify( this.registrations, this.ownManifest() );
	}

	/**
	 * The built wire tool surface — the exact `tools/list` array, without spawning the server. Builds
	 * first (idempotent), then reads it off the underlying McpServer. The promotion script uses this to
	 * regenerate the committed tool snapshot authoritatively (the cache the app boots dormant from).
	 */
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
	 * Run a registered tool in-process by name — the seam a COMPOSING tool ( e.g. a batch ) dispatches
	 * through to run other tools in sequence. Builds first ( idempotent ), then delegates to the
	 * McpServer's own dispatch, so an internal call obeys the exact same contract as a wire call. A
	 * subclass wires this into such a tool at build() time ( `batchTools( ( n, a ) => this.invoke( n, a ) )` ).
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
	 * The server's doc-block as served right now — the recursive parent of its tools' docs, generated
	 * fresh rather than frozen at author-time. Default: the static manifest's authored `doc`, unchanged.
	 *
	 * ── NOTHING PER-SESSION MAY BE FOLDED IN HERE. READ THIS BEFORE OVERRIDING. ──
	 * Three servers once did exactly that — the file server folded in its readable ROOT PATHS, the browser
	 * its enabled origins, Daedalus its vault root and census — each to save an agent a discovery call. All
	 * three were removed, and the reason is structural rather than stylistic: a server doc is per-SERVER,
	 * and one copy of a server now answers for SEVERAL SESSIONS at once. There is no call in scope here, so
	 * there is no way to know whose doc is being asked for, and any workspace state folded in is whichever
	 * one resolved last. That is not a leak of configuration; it is one session's paths handed to another.
	 *
	 * IT NEVER FIRED, WHICH IS THE ONLY REASON THIS IS A NOTE AND NOT AN INCIDENT. MCP has no call that
	 * asks a running server for its documentation — `initialize` returns `serverInfo { name, version }` and
	 * nothing more — so this seam was written against a protocol affordance that does not exist, and the
	 * host reads the STATIC manifest doc off disk at discovery instead.
	 *
	 * The correct home for anything session-shaped is a TOOL, which receives the call's `_meta` and can be
	 * answered per caller. `starmind_file` already had one — `roots` — that gave the same answer correctly
	 * the whole time the override existed beside it.
	 *
	 * A per-SERVER fact ( a build stamp, a protocol version ) has no such problem, but it belongs in the
	 * handshake, where a client actually reads it.
	 */
	liveDoc(): string {
		return this.ownManifest().doc ?? '';
	}
}
