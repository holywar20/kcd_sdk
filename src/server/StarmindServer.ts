import { McpServer } from './McpServer';
import type { ToolDefinition } from './McpServer';
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

	/** Build the tool surface, then serve it on stdio until the client disconnects. */
	async run(): Promise<void> {
		this.ensureBuilt();
		await this.server.connect();
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
}
