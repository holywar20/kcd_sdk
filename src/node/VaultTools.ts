import * as path from 'path';
import { Vault } from './Vault';
import { VaultUtilities } from './VaultUtilities';
import { Survey } from './Survey';
import { KCDPrimitive } from '../primitives';
import type { SerializedArtifact } from '../primitives';
import { KcdContext, KcdEmit, KcdValidate, KcdShapes, KcdSynth, VaultLayout } from '../core';
import type { ArtifactType, SynthInput } from '../core';
import type { ToolResult } from '../server/McpServer';

/**
 * VaultTools — the KCD tool engine: one implementation of the ten vault tools, wired by two faces.
 *
 * The Daedalus server registers these over stdio for Claude Code; Starmind's `sm_documentation`
 * keystones call them in-process for its own agents. Both faces are wiring. What a tool DOES — the path
 * jail, the write-time type check, the lean-or-verbatim read, the synth advisories, the validate-before-
 * write gate, the batch sequencing — lives here once, so the two faces cannot drift while both are live.
 *
 * WHAT A FACE OWNS. Where the vault is ( Daedalus resolves a config ladder; Starmind reads the call's
 * project ), what each tool is CALLED ( `kcd_get` on one face, `get_doc` on the other ), and how a
 * result is delivered. Everything a face owns arrives through the constructor or through `spec`.
 *
 * NAMES ARE PER FACE, AND THE PROSE FOLLOWS THEM. A refusal that says "use kcd_query" is wrong on a face
 * that calls it `sm_documentation__query_docs`, so every sibling reference — in a doc, a schema
 * description, an example, a refusal — is written as a `{{op}}` token and rendered against the face's
 * own names. One copy of the prose, correct on every face.
 *
 * RETURNS THE WIRE ENVELOPE. Every op hands back a `ToolResult` — the MCP `tools/call` shape, which is
 * also what a keystone returns — so a face is one line per tool. Refusals are written for the model
 * reading them: what was wrong, then what would be right, in one message.
 *
 * NOTHING CACHES. Every op reads the vault fresh; the one thing held is the Vault binding itself.
 */

/** The ten operations, in the order the wire lists them. */
export const VAULT_TOOL_OPS = [ 'query', 'get', 'links', 'health', 'compile', 'survey', 'save', 'move', 'delete', 'batch' ] as const;
export type VaultToolOp = typeof VAULT_TOOL_OPS[ number ];

/** What each op is called on ONE face — the name a model writes, and the name the prose renders. */
export type VaultToolNames = Record<VaultToolOp, string>;

/** What one tool SAYS on the wire, rendered for a face: the one-liner, the full doc, the schema, the
 *  hints, and ( where the op ships one ) an idiomatic example. */
export interface VaultToolSpec {
	description: string;
	doc:         string;
	inputSchema: Record<string, unknown>;
	annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
	example?:    Record<string, unknown>;
}

/** A face's own dispatch, handed to `batch` — how THIS face runs a sibling by name. */
export type VaultToolInvoke = ( name: string, args: Record<string, unknown> ) => Promise<ToolResult>;

export interface VaultToolsOptions {
	/** Where the stylesheet sits relative to the vault root — `KcdEmit.cssHrefFor`'s second argument.
	 *  Absent means the vault's own `kcd.css`. */
	cssVaultRel?: string;
	/** Told after a write LANDS, with the absolute path of every file it touched — the artifact written,
	 *  moved or removed, and every referrer a heal rewrote. A host holding an index invalidates off it. */
	onWrite?:     ( paths: string[] ) => void;
}

export class VaultTools {

	constructor(
		readonly vault: Vault,
		private readonly names: VaultToolNames,
		private readonly opts: VaultToolsOptions = {}
	) {}

	// ── What a tool says ──────────────────────────────────────────────────────

	/** One op's wire spec, rendered for a face. Throws on a token naming no op — an authoring error. */
	static spec( op: VaultToolOp, names: VaultToolNames ): VaultToolSpec {
		const raw = SPECS[ op ];
		const rendered = JSON.stringify( raw ).replace( /\{\{(\w+)\}\}/g, ( _, key: string ) => {
			const name = names[ key as VaultToolOp ];
			if ( !name ) throw new Error( `VaultTools.spec: "${ op }" references an op "${ key }" that has no name on this face` );
			return name;
		} );
		return JSON.parse( rendered ) as VaultToolSpec;
	}

	// ── Discovery ─────────────────────────────────────────────────────────────

	query( args: Record<string, unknown> ): ToolResult {
		try {
			// One engine, two faces: this same call backs the CLI `query` command.
			return VaultTools.result( VaultUtilities.query( this.vault, {
				glob:    typeof args[ 'glob' ] === 'string' ? args[ 'glob' ] as string : undefined,
				type:    typeof args[ 'type' ] === 'string' ? args[ 'type' ] as string : undefined,
				text:    typeof args[ 'text' ] === 'string' ? args[ 'text' ] as string : undefined,
				groupBy: args[ 'groupBy' ] === 'type' ? 'type' : undefined,
			} ) );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	get( args: Record<string, unknown> ): ToolResult {
		const filePath = String( args[ 'path' ] ?? '' );
		try {
			this.jail( filePath );

			const depth = typeof args[ 'depth' ] === 'number' ? args[ 'depth' ] as number : undefined;
			const type  = this.vault.classify( filePath );

			// The default read is LEAN — `full` is the opt-in back to the verbatim shape, because the reader is
			// the common caller and the editor is the rare one. Where the projection lives is the SDK's business
			// ( KcdContext owns every AI-audience projection ); this is the gate choosing between two of them.
			const project = ( a: SerializedArtifact ) => args[ 'full' ] === true ? a : KcdContext.leanArtifact( a );

			if ( type === 'lens' ) {
				// vault.loadLens injects the real fs reader — a bare load leaves disk-read unset and throws on dredge.
				const lens = this.vault.loadLens( filePath, { depth: depth ?? 1 } );
				return VaultTools.result( project( lens.serialize() ) );
			}

			const artifact = KCDPrimitive.fromHtml( this.vault.read( filePath ), this.vault.toAbs( filePath ), this.vault.docRoot );
			return VaultTools.result( project( artifact.serialize() ) );
		} catch ( e ) {
			const message = errorText( e );
			// A raw ENOENT hands back an ABSOLUTE path the caller never wrote, which tells an agent nothing it
			// can act on — it reads as "the vault is broken" rather than "that artifact is not there". Name the
			// path AS ASKED FOR and point at the tool that answers "what exists", so the next call is a search
			// rather than a second guess at a filename.
			if ( message.includes( 'ENOENT' ) ) {
				return VaultTools.error(
					`No artifact at "${ filePath }". Paths are vault-relative ` +
					`( "plans/x.html", not an absolute path ). Use ${ this.names.query } to find it by glob or by text.`
				);
			}
			return VaultTools.error( message );
		}
	}

	links( args: Record<string, unknown> ): ToolResult {
		const filePath = String( args[ 'path' ] ?? '' );
		try {
			this.jail( filePath );
			// One engine, two faces: this same call backs the CLI `links` command.
			return VaultTools.result( VaultUtilities.links( this.vault, filePath ) );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	health( args: Record<string, unknown> ): ToolResult {
		try {
			const inputPath = typeof args[ 'path' ] === 'string' ? args[ 'path' ] as string : '';
			if ( inputPath ) this.jail( inputPath );
			// One engine, two faces: this same call backs the CLI `validate` command.
			return VaultTools.result( VaultUtilities.health( this.vault, inputPath || undefined ) );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	compile( args: Record<string, unknown> ): ToolResult {
		try {
			const lenses = Array.isArray( args[ 'lenses' ] ) ? ( args[ 'lenses' ] as unknown[] ).map( String ) : [];
			// One engine, two faces: this same call backs the CLI `compile` command.
			//
			// NO `lane` HERE, and the absence IS the mechanism. The CLI face carries `--lane`, which swaps the
			// inheritance floor for `_lane-base` — the floor authored for an agent running with nobody in the
			// session. That face is driven by a harness. This one is driven by agents, and an agent that can
			// name its own floor can name the lenient one. Picking your own guardrails is not a capability
			// worth having, so the choice is simply not expressible here.
			return VaultTools.result( VaultUtilities.compile( this.vault, lenses ) );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	survey( args: Record<string, unknown> ): ToolResult {
		try {
			// The survey walks the PROJECT ROOT ( the code ), not the vault — the opposite scope from every
			// other tool, which read the artifact store. One engine, two faces: this same call backs the CLI
			// `survey` command.
			const report = Survey.run( this.vault.projectRoot, { skipPaths: VaultUtilities.installedPaths( this.vault ) } );
			return args[ 'full' ] === true
				? VaultTools.result( report )
				: VaultTools.text( Survey.project( report ) );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	// ── Writes ────────────────────────────────────────────────────────────────

	save( args: Record<string, unknown> ): ToolResult {
		const filePath = String( args[ 'path' ] ?? '' );
		try {
			const raw      = ( args[ 'artifact' ] ?? {} ) as Record<string, unknown>;
			const declared = String( raw[ 'type' ] ?? '' );

			this.jail( filePath );
			this.checkType( filePath, raw );

			// TWO WAYS IN, one write. `content` is the AUTHORING path: sections and rows go to KcdSynth and the
			// markup is DERIVED from the type's shape, so an author supplies content and never markup. `body`
			// is the EDIT path ( get with `full: true` → mutate → save ), where the body is already structured
			// and its CONTENT must survive — not its bytes: `KcdEmit` re-parses and re-serializes the whole body
			// through `HtmlTree`, which normalizes whitespace and quote style. Supplying both would silently
			// discard one, so the combination is refused rather than resolved by a precedence rule nobody can see.
			const content = raw[ 'content' ] as SynthInput | undefined;
			const hasBody = typeof raw[ 'body' ] === 'string' && ( raw[ 'body' ] as string ).trim() !== '';
			if ( content && hasBody )
				return VaultTools.error( `${ this.names.save } refused "${ filePath }": supply either "content" ( synthesized ) or "body" ( passthrough ), not both.` );

			// An absent body is a create with no content ( validation then rejects it with a helpful message,
			// not a parse crash ).
			let body = typeof raw[ 'body' ] === 'string' ? raw[ 'body' ] : '';
			const advisories: string[] = [];

			if ( content ) {
				const fm    = ( raw[ 'frontmatter' ] ?? {} ) as Record<string, unknown>;
				const title = content.title ?? String( fm[ 'name' ] ?? declared );
				const synth = KcdSynth.synthesize( declared, { ...content, title } );
				body = synth.body;

				// A CLOSED type ( only `lens` today ) still EMITS an undeclared section, but the compiler will
				// not read it — say so here rather than let the content go quiet.
				const shape = KcdShapes.shapeFor( declared );
				if ( synth.undeclared.length && shape && !shape.open )
					advisories.push( `sections not declared by the "${ declared }" shape: ${ synth.undeclared.join( ', ' ) } — the compiler will not read them. Declared: ${ KcdShapes.orderFor( declared ).join( ', ' ) }` );

				// Advisory only — KcdValidate stays the SOLE gate. This names the gap while the author still
				// holds the content, which is the cheapest moment to close it. Audit what was SUPPLIED, prose and
				// rows alike — a slot-bearing section arrives as rows and never appears in `sections`.
				const audit = KcdShapes.audit( declared, KcdSynth.suppliedSections( content ) );
				if ( audit.missing.length ) advisories.push( `missing required section(s): ${ audit.missing.join( ', ' ) }` );
				if ( audit.thin.length )    advisories.push( `missing expected section(s): ${ audit.thin.join( ', ' ) }` );

				// The other half of the advisory: `audit` asks whether the right SECTIONS are here, this asks
				// whether what is inside them will read as intended. Markdown markers in prose emit as literal
				// characters.
				advisories.push( ...KcdSynth.proseWarnings( content ) );
			}

			const artifact = { ...raw, body } as unknown as SerializedArtifact;

			// TIER 2 of the stylesheet contract ( protocol §8.1 ): a depth-relative link, derived from this
			// document's own destination and from where the stylesheet sits in THIS vault. Tier 1, the inline
			// baseline, is emitted unconditionally and needs nothing from here.
			const html = KcdEmit.emit( artifact, KcdEmit.cssHrefFor( filePath, this.opts.cssVaultRel ) );
			// `docRoot` matters HERE, not only in reports: without it the ephemeral-link law was evaluated
			// against the wrong vault name, so a save refused legal documents and accepted illegal ones.
			const report = KcdValidate.validate( html, { path: filePath, docRoot: this.vault.docRoot } );
			if ( !report.ok ) {
				const detail = report.errors.map( e => `${ e.code } @ ${ e.where }: ${ e.msg }` ).join( '; ' );
				return VaultTools.error( `${ this.names.save } refused "${ filePath }": artifact failed validation — ${ detail }` );
			}

			const saved = this.vault.write( filePath, html );
			this.wrote( [ this.vault.toAbs( filePath ) ] );
			return VaultTools.result( { saved, warnings: [ ...report.warnings, ...advisories ] } );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	move( args: Record<string, unknown> ): ToolResult {
		const from = String( args[ 'from' ] ?? '' );
		const to   = String( args[ 'to' ] ?? '' );
		try {
			this.jail( from );
			this.jail( to );
			const plan = this.vault.move( from, to );
			this.wrote( [ from, to, ...plan.edits.map( e => e.file ) ].map( p => this.vault.toAbs( p ) ) );
			return VaultTools.result( plan );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	delete( args: Record<string, unknown> ): ToolResult {
		const filePath = String( args[ 'path' ] ?? '' );
		try {
			this.jail( filePath );
			const plan = this.vault.delete( filePath );
			this.wrote( [ filePath, ...plan.edits.map( e => e.file ) ].map( p => this.vault.toAbs( p ) ) );
			return VaultTools.result( plan );
		} catch ( e ) {
			return VaultTools.error( errorText( e ) );
		}
	}

	// ── Batch ─────────────────────────────────────────────────────────────────

	/**
	 * Run `calls` in order through the FACE's own dispatch, stopping at the first failure. The batch touches
	 * nothing itself; every dispatched call runs its own op, jail included. A face passes `invoke` because
	 * only the face knows how a name resolves to a sibling on it.
	 */
	async batch( args: Record<string, unknown>, invoke: VaultToolInvoke ): Promise<ToolResult> {
		const calls = Array.isArray( args[ 'calls' ] ) ? args[ 'calls' ] as Array<Record<string, unknown>> : [];
		const completed: Array<{ tool: string; output: string }> = [];

		for ( let i = 0; i < calls.length; i++ ) {
			const call     = calls[ i ] ?? {};
			const tool     = typeof call[ 'tool' ] === 'string' ? call[ 'tool' ] as string : '';
			const callArgs = ( call[ 'args' ] ?? {} ) as Record<string, unknown>;

			const fail = ( error: string ) => VaultTools.result( {
				completed,
				failed:    { index: i, tool, error },
				remaining: calls.slice( i + 1 ).map( c => typeof c?.[ 'tool' ] === 'string' ? c[ 'tool' ] : '?' ),
			} );

			if ( !tool )                     return fail( 'call is missing a "tool" name' );
			if ( tool === this.names.batch ) return fail( `${ this.names.batch } cannot be nested` );

			const result = await invoke( tool, callArgs );
			if ( result.isError ) return fail( textOf( result ) );

			completed.push( { tool, output: textOf( result ) } );
		}

		return VaultTools.result( { completed, failed: null, remaining: [] } );
	}

	// ── The guard ─────────────────────────────────────────────────────────────
	// Two rules, in this order: the path jail, then ( on a save ) the write-type check. They were a guard
	// chain the Daedalus server ran before every handler; they are part of the ops now, so no face can
	// forget to run them.

	/** Assert a path resolves inside the vault root. Throws with the FORM named, not just the failure. */
	private jail( inputPath: string ): void {
		if ( this.vault.isInside( inputPath ) ) return;

		// This is the most-hit refusal there is, and it used to report the offending path and the root and
		// stop there — true, and no help. What a caller actually needs is the currency ( paths are
		// vault-RELATIVE ) and where to look up a real one, so both ride the rejection.
		throw new Error(
			`Path "${ inputPath }" is outside the vault ("${ this.vault.root }") — paths here are vault-RELATIVE `
			+ `( "references/domain/note.html" ), not absolute and never "../"-escaped; a leading "${ path.basename( this.vault.root ) }/" `
			+ `is tolerated. Use ${ this.names.query } to find an artifact's real path.`
		);
	}

	/**
	 * On a save, assert the target directory ACCEPTS the artifact's declared type — a lens cannot be saved
	 * into references/. A missing declared type is left to KcdValidate downstream; this only catches a real
	 * category error.
	 *
	 * Asks `accepts`, not `classify`: `references/` implies `reference` and legitimately holds how-tos and
	 * notes, so comparing against the single implied type refused valid documents. The message names the
	 * whole accepted set, so the fix is in the error.
	 */
	private checkType( writePath: string, artifact: unknown ): void {
		const fm = typeof artifact === 'object' && artifact !== null
			? ( artifact as Record<string, unknown> )[ 'frontmatter' ]
			: undefined;
		const declaredType = typeof fm === 'object' && fm !== null
			? String( ( fm as Record<string, unknown> )[ 'type' ] ?? '' )
			: '';

		if ( !declaredType ) return;
		if ( this.vault.accepts( writePath, declaredType as ArtifactType ) ) return;

		const allowed = this.vault.acceptedTypes( writePath ).map( t => `"${ t }"` ).join( ' | ' );

		// One type is decided by the FILENAME, not the folder, so for it the accepted-set message names the
		// wrong cause and invites the wrong fix. Name the real condition.
		const hint = declaredType === 'nav-index' && !writePath.replace( /\\/g, '/' ).endsWith( '/' + VaultLayout.NAV_INDEX_FILE )
			? ` — a nav-index is identified by its filename, so it must be named "${ VaultLayout.NAV_INDEX_FILE }"`
			: '';

		throw new Error( `Type mismatch at "${ writePath }": directory accepts ${ allowed }, artifact declares "${ declaredType }"${ hint }` );
	}

	/** Tell the host what landed. Never lets a listener cost the write that already happened. */
	private wrote( absPaths: string[] ): void {
		try {
			this.opts.onWrite?.( absPaths );
		} catch {
			// A host's index bookkeeping failing is the host's problem to notice; the write is done.
		}
	}

	// ── Envelopes ─────────────────────────────────────────────────────────────

	/** Wrap any serialisable value in the text-content envelope, as pretty JSON. */
	static result( data: unknown ): ToolResult {
		return { content: [ { type: 'text', text: JSON.stringify( data, null, 2 ) } ] };
	}

	/** Already-formatted prose AS-IS — for a payload meant to be read as text, where JSON's quotes and
	 *  escaped newlines would defeat the format. */
	static text( body: string ): ToolResult {
		return { content: [ { type: 'text', text: body } ] };
	}

	/** A refusal the model sees and can act on. */
	static error( message: string ): ToolResult {
		return { content: [ { type: 'text', text: message } ], isError: true };
	}
}

function errorText( e: unknown ): string {
	return e instanceof Error ? e.message : String( e );
}

function textOf( r: ToolResult ): string {
	return r.content.map( c => c.text ).join( '' );
}

// ── What each tool says ───────────────────────────────────────────────────────────────────────────
// One copy of the prose, with every sibling reference written as a `{{op}}` token. `spec` renders it
// against a face's names, so a doc that says "read one with {{get}}" names `kcd_get` on the Daedalus
// wire and `sm_documentation__get_doc` in Starmind.

const SPECS: Record<VaultToolOp, VaultToolSpec> = {
	query: {
		annotations: { readOnlyHint: true },
		example:     { type: 'lens' },
		description: 'Find artifacts by path glob, type, and body text — the place to start when you don\'t know the path.',
		doc:
			'The single read-query over the vault — subsumes the old glob/list/search/types tools. Any of ' +
			'`glob` ( vault-relative path pattern; `*` within a segment, `**` across ), `type` ( artifact ' +
			'classifier: lens, plan, habit, reference, contract, generator, analyzer, template, framework, ' +
			'nav-index ), and `text` ( case-insensitive substring across body + serialized frontmatter ) may ' +
			'be combined; they AND together. With no filter it returns the whole live vault. Returns an array ' +
			'of refs ( path + type + name ) — read one with {{get}}, walk its edges with {{links}}. Pass ' +
			'`groupBy: "type"` to get `{ type, count }[]` ( sorted by count, descending ) instead of refs — ' +
			'the cheapest orientation call. ARCHIVAL buckets ( plans/plans_complete, plans/plans_deferred ) ' +
			'are EXCLUDED unless the glob names one — retired and parked plans answer "what did we do", not ' +
			'"what is true now". So `type: "plan"` returns the live plans, and ' +
			'`glob: "plans/plans_complete/**"` returns the retired ones. Read-only.',
		inputSchema: {
			type:       'object',
			properties: {
				glob:    { type: 'string', description: 'Vault-relative path glob; * within a segment, ** across segments.' },
				type:    {
					type:        'string',
					enum:        [ 'lens', 'plan', 'habit', 'reference', 'contract', 'generator', 'analyzer', 'audit', 'bug-report', 'template', 'framework', 'nav-index' ],
					description: 'Artifact-type filter.',
				},
				text:    { type: 'string', description: 'Case-insensitive substring across body + serialized frontmatter.' },
				groupBy: { type: 'string', enum: [ 'type' ], description: 'Return { type, count }[] instead of refs.' },
			},
			required: [],
		},
	},

	get: {
		annotations: { readOnlyHint: true },
		description: 'Load one artifact; for a lens, `depth` pulls in the context it always brings with it.',
		doc:
			'Load one artifact by vault-relative `path`, parse it, and return its serialized shape ' +
			'(frontmatter + sections + resolved links). For a lens, `depth` controls dredge: ' +
			'1 (default) returns the lens alone; 2+ pulls its always-policy children that many levels ' +
			'deep, so the returned object carries the composed Know set. Non-lens types ignore `depth`. ' +
			'TWO SHAPES. By DEFAULT the read is LEAN: each section keeps its `h3`, its list tags and any ' +
			'`pre`, and loses every other tag and all formatting whitespace — and `body` is absent, ' +
			'because a stripped body fed back to {{save}} would save the document with its structure ' +
			'gone. Nothing is lost that the shape does not already hold: `sections` is the body\'s keyed ' +
			'decomposition, the `<h1>` is `frontmatter.name`, and every href is in `links`. Pass ' +
			'`full: true` for the verbatim SerializedArtifact — structured HTML and all — which is what ' +
			'{{save}}\'s `body` edit path ({{get}} → mutate → {{save}}) requires; reach for it when you ' +
			'intend to EDIT, and leave it off when you intend to READ. ' +
			'The path is PathGuard-jailed to the vault; an out-of-vault path returns a structured error. ' +
			'Use {{links}} instead when you only need the link graph, not the sections. Read-only.',
		inputSchema: {
			type:       'object',
			properties: {
				path:  { type: 'string', description: 'Vault-relative path to the artifact.' },
				depth: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: 'Lens dredge depth; 1 = artifact only.' },
				full:  { type: 'boolean', default: false, description: 'Return the verbatim artifact, `body` included — required to EDIT via {{save}}. Omit to read.' },
			},
			required: [ 'path' ],
		},
	},

	links: {
		annotations: { readOnlyHint: true },
		description: 'See an artifact\'s outbound links, and everything pointing back at it.',
		doc:
			'Resolve the link graph around one artifact. Returns `{ outbound, inbound }`: outbound = the ' +
			'links the artifact itself declares (resolved to their targets); inbound = every other file ' +
			'in the vault whose links resolve TO this one (backlinks), found by scanning + resolving the ' +
			'whole vault. The graph primitive behind the editor\'s reference fan and the backlink panel. ' +
			'Cheaper than {{get}} when you only need edges, not the sections. Read-only.',
		inputSchema: {
			type:       'object',
			properties: { path: { type: 'string', description: 'Vault-relative path to the artifact.' } },
			required:   [ 'path' ],
		},
	},

	health: {
		annotations: { readOnlyHint: true },
		description: 'Validate one artifact, or the whole vault, for dangling links and broken refs.',
		doc:
			'Validate artifacts on two axes. STRUCTURAL ( per file ): required frontmatter, sections, ' +
			'and type rules — a parse failure becomes an error issue rather than aborting the run. ' +
			'REFERENCE INTEGRITY ( cross-file, advisory warnings ): internal links whose target is missing ' +
			'on disk ( code-file links count; external URLs, #anchors, and {placeholder} hrefs are skipped ), ' +
			'and `base`/`lens` slugs that name no artifact ( the `cross` sentinel is skipped ). Pass `path` ' +
			'to check one file; omit it to sweep the whole vault. Returns `{ issues, summary }` — each issue ' +
			'carries its path, severity (error/warn), and message; the summary totals errors vs warnings. ' +
			'The pre-flight before a save or move sweep, and the observable form of the "always viable" ' +
			'invariant. Read-only.',
		inputSchema: {
			type:       'object',
			properties: { path: { type: 'string', description: 'Optional vault-relative path; omit to check the whole vault.' } },
			required:   [],
		},
	},

	compile: {
		annotations: { readOnlyHint: true },
		description: 'Compile one or more lenses into one composed context string — first lens is primary.',
		doc:
			'The LENS compiler — Daedalus\'s basic context-compilation surface. Give it lens names ' +
			'( a bare `parser` maps to `lenses/parser/parser.html`; a vault path is used as-is ) and it ' +
			'dredges each lens to its OWN authored depth, folds their context blocks together, resolves ' +
			'habit-class contention, and assembles one context string ( Care-first, manifest tables ). ' +
			'Multiple lenses compose into one, first = primary. The BASE LENS is always included and cannot ' +
			'be suppressed — it is the vault\'s inheritance floor ( project-wide stance plus the universal ' +
			'habits ), appended last so a named lens\'s own habit wins its class. Returns ' +
			'`{ lenses, text, tokens }`, where `lenses` reports what actually compiled, `_lens-base` ' +
			'included. This is lens composition only — the live runtime layers ( model root context, active ' +
			'MCP tool schemas, session memory ) are Starmind\'s job, not the vault\'s. Read-only.',
		inputSchema: {
			type:       'object',
			properties: {
				lenses: {
					type:        'array',
					items:       { type: 'string' },
					description: 'Lens names or vault-relative paths to compile; the first is primary.',
					minItems:    1,
				},
			},
			required: [ 'lenses' ],
		},
	},

	survey: {
		annotations: { readOnlyHint: true },
		description: 'Reconnoitre the project beside the vault — a filename-level census of components, languages, and entry points.',
		doc:
			'Walk the configured project root and return a structured reconnaissance of it. This is a ' +
			'CENSUS: it reads filenames and small manifests only — no source is parsed and no model runs — ' +
			'so it produces a real answer on a Python, Go or C# project exactly as on TypeScript. The unit ' +
			'is the COMPONENT ( the root, plus every directory carrying its own package manifest ); each ' +
			'file is attributed to the deepest component containing it, so a monorepo reads as its real ' +
			'parts. By default returns the LEAN TEXT PROJECTION — the orientation read, geometry-free, the ' +
			'form a small model reasons over best. Pass `full: true` for the complete `SurveyReport` object ' +
			'( components with languages, entryPoints, tests, contains, stats ). What a survey does NOT tell ' +
			'you: what the code does, which component matters, or that an absent thing is truly absent — ' +
			'treat it as orientation, not authority ( see the read-a-survey reference ). Read-only; surveys ' +
			'the project, writes nothing. The CLI `survey` command writes the same data as a JSON tree.',
		inputSchema: {
			type:       'object',
			properties: {
				full: { type: 'boolean', default: false, description: 'Return the full structured SurveyReport instead of the lean text projection.' },
			},
			required: [],
		},
	},

	save: {
		annotations: { destructiveHint: true },
		example:     {
			path:     'references/domain/my-note.html',
			artifact: {
				type:        'reference',
				frontmatter: { name: 'my-note', description: 'A worked example.', type: 'reference', status: 'active' },
				body:        '<h1>My Note</h1>\n<p>The body content.</p>',
			},
		},
		description: 'Write an artifact, validated first — a malformed one is refused and nothing lands.',
		doc:
			'Persist one artifact by vault-relative `path` from its `artifact` ( a SerializedArtifact — the ' +
			'shape {{get}} returns under `full: true` ). Emits HTML with KcdEmit: frontmatter is rebuilt from `artifact.frontmatter`, ' +
			'the `body` is re-parsed and re-emitted — an existing body has its frontmatter block replaced ( the ' +
			'edit path: {{get}} with `full: true` → mutate → {{save}} ), a body with none gets one prepended ( the create path ). ' +
			'The head is regenerated wholesale every write, so a document self-corrects its stylesheet on any ' +
			'save. The result ' +
			'is validated with KcdValidate BEFORE any write: a structural failure returns a structured error and ' +
			'writes NOTHING ( the write-time gate — can\'t save a malformed artifact ). On success it writes and ' +
			'returns `{ saved, warnings }`. PathGuard jails the path and checks the target directory ACCEPTS the ' +
			'declared type — a refusal names the accepted set, so the fix is in the error. ' +
			'TWO WAYS IN, exactly one per call. Pass `artifact.content` to AUTHOR: give sections as prose ' +
			'( plus rows for the record-bearing ones ) and the structure — section order, nesting, heading ' +
			'levels, faux-tables, the whole data-kcd grammar — is DERIVED from that type\'s declared shape, so ' +
			'you supply content and never markup. Pass `artifact.body` instead to EDIT, where existing ' +
			'structured HTML is kept — content, structure and attributes ' +
			'survive, while indentation and line breaks are NORMALIZED to house format, so expect the ' +
			'file you get back to be formatted rather than byte-identical to what you sent. Supplying both is ' +
			'refused rather than resolved by precedence. Content mode also returns advisories naming any ' +
			'required or expected section left out, and — on a closed type — any section the compiler will not ' +
			'read. NOTE: agent-authored body HTML is not yet sanitized here ( the render layer sanitizes on ' +
			'display; a save-time sanitize pass is a named deferral ).',
		inputSchema: {
			type:       'object',
			properties: {
				path:     { type: 'string', description: 'Vault-relative destination path.' },
				artifact: {
					type:        'object',
					description: 'The SerializedArtifact to write.',
					properties: {
						type:        { type: 'string', description: 'Artifact type (lens, plan, habit, reference, …) — must match the target directory.' },
						frontmatter: { type: 'object', additionalProperties: true, description: 'Frontmatter fields (name, description, status, …) — rebuilt into the HTML header block.' },
						body:    { type: 'string', description: 'EDIT path — body HTML, no frontmatter block. Content, structure and attributes are preserved; whitespace is reformatted to house style, so the stored file will not be byte-identical to what you send. Use for an edit — and source it from {{get}} with `full: true`, since the default lean read carries no `body` at all. Mutually exclusive with `content`.' },
						content: {
							type:        'object',
							description: 'AUTHORING path — supply CONTENT and the structure is derived from the type\'s shape (section order, nesting, headings, faux-tables). Mutually exclusive with `body`.',
							properties: {
								title:    { type: 'string', description: 'The document\'s <h1>. Defaults to frontmatter.name.' },
								summary:  { type: 'string', description: 'One line under the title, rendered as a blockquote.' },
								sections: { type: 'object', additionalProperties: { type: 'string' }, description: 'Section name → prose. Plain text is fine: blank lines become paragraphs, "- " lines a list. MARKDOWN IS NOT INTERPRETED — **bold**, `code` and [text](link) render as literal characters; use <strong>, <code>, <a href> instead, or write the whole section as HTML. HTML comments are stripped. Names and order come from the type\'s shape; a nested child like "phase-2" is placed inside its parent automatically.' },
								slots: {
									type:        'array',
									description: 'Rows for the sections that carry records rather than prose (a lens\'s habits, a nav-index\'s entries).',
									items: {
										type: 'object',
										properties: {
											section: { type: 'string', description: 'Which section these rows belong to.' },
											kind:    { type: 'string', description: 'Slot kind; defaults to the kind the shape declares for that section.' },
											rows: {
												type:  'array',
												items: {
													type: 'object',
													properties: {
														what:  { type: 'string', description: 'The label.' },
														where: { type: 'string', description: 'Vault-root-relative path (_Claude/...), emitted as a real link.' },
														why:   { type: 'string', description: 'When or why this row applies.' },
														mode:  { type: 'string', description: 'off | on | suggested.' },
													},
													required: [ 'what' ],
												},
											},
										},
										required: [ 'section', 'rows' ],
									},
								},
							},
						},
					},
					required: [ 'type', 'frontmatter' ],
				},
			},
			required: [ 'path', 'artifact' ],
		},
	},

	move: {
		annotations: { destructiveHint: true },
		example:     { from: 'references/domain/old-name.html', to: 'references/domain/new-name.html' },
		description: 'Move or rename an artifact, healing every inbound link across the vault.',
		doc:
			'Rename or relocate one artifact by vault-relative `from` → `to`, then HEAL every reference to ' +
			'it, so no backlink rots. TWO PASSES, because neither sees the whole corpus: the GRAPH pass ' +
			'reads links out of parsed artifacts and matches on resolved identity ( so any authored form ' +
			'counts ), and the TEXT pass sweeps raw bytes for the canonical path — which is the only thing ' +
			'that reaches a markdown todo, a `.js` utility, a `data-kcd-address`, the project-root ' +
			'CLAUDE.md, or a document that FAILS TO PARSE and therefore needs repair most. Swaps preserve ' +
			'hand-authored formatting. Returns the HealPlan — `{ op, from, to, edits, reported }`: `edits` ' +
			'is what changed ( referrer + old/new href ), `reported` is what was FOUND AND DELIBERATELY ' +
			'LEFT, each carrying `untouched` saying why. Today that means `quoted` — a reference sitting ' +
			'in `<code>`/`<pre>` content or a markdown fence, i.e. quoted speech the corpus uses to teach ' +
			'agents what to SAY, never rewritten. An empty `edits` alongside an empty `reported` therefore ' +
			'means nothing pointed at it, not that nothing could be seen. Ephemeral space is swept only ' +
			'where ruled in ( `logs/*/todo/` ); `logs/session.md` and `completed/` are historical records ' +
			'and are left alone. Refuses if `from` is missing or `to` already exists ( structured error ), ' +
			'and asserts afterward that no rewritable reference still resolves to `from` — a residual ' +
			'fails loud rather than leaving the vault dangling. Both paths are PathGuard-jailed. ' +
			'Destructive: it writes referrers and renames the file.',
		inputSchema: {
			type:       'object',
			properties: {
				from: { type: 'string', description: 'Current vault-relative path.' },
				to:   { type: 'string', description: 'Destination vault-relative path.' },
			},
			required: [ 'from', 'to' ],
		},
	},

	delete: {
		annotations: { destructiveHint: true },
		example:     { path: 'references/domain/obsolete-note.html' },
		description: 'Delete an artifact, cascading the removal through every referrer.',
		doc:
			'Remove one artifact by vault-relative `path` and CASCADE the removal: every inbound reference ' +
			'is excised from its referrer so the graph stays viable — a slot-field link takes its whole ' +
			'record row, a bare prose <a> unwraps to its text, span-precise so surrounding formatting is ' +
			'untouched. BLOCKS ( structured error, nothing deleted ) if any artifact references the target ' +
			'by IDENTITY ( a base/lens slug naming it ) — those are not movable links and must be repointed ' +
			'or renamed first. Returns the HealPlan — `{ op:"delete", from, edits, reported }`. `edits` is ' +
			'every referrer EXCISED, which is parse-and-splice and therefore covers parsed HTML/`.js` only. ' +
			'`reported` is every other reference the raw text sweep found and deliberately did not touch, ' +
			'each carrying `untouched`: `not-excisable` ( a markdown todo, an unparseable file, an address, ' +
			'CLAUDE.md — there is no span-precise way to cut a reference out of a sentence, so THESE WILL ' +
			'DANGLE and are named rather than discovered later ) or `quoted` ( quoted speech in ' +
			'`<code>`/`<pre>` or a fence ). Refuses a missing target, PathGuard-jails the path, and asserts ' +
			'afterward that no excisable link still resolves to it ( a residual fails loud ). ' +
			'Destructive: it writes referrers and removes the file.',
		inputSchema: {
			type:       'object',
			properties: { path: { type: 'string', description: 'Vault-relative path to the artifact to delete.' } },
			required:   [ 'path' ],
		},
	},

	batch: {
		// No fixed destructiveHint would be honest either way — a batch of reads is harmless, one that
		// dispatches a move or a delete is not. Defensively true: a client that trusts the hint should be
		// warned, not surprised.
		annotations: { destructiveHint: true },
		example: {
			calls: [
				{ tool: '{{query}}', args: { type: 'lens' } },
				{ tool: '{{get}}',   args: { path: 'lenses/mcp/mcp.html' } },
			],
		},
		description: 'Run an ordered sequence of tool calls, stopping at the first failure.',
		doc:
			'Execute `calls` — `[{ tool, args? }]` — IN ORDER through the server\'s internal dispatch, as a ' +
			'single tool call, so an agent that stacks a few operations gets one round-trip. Stops at the ' +
			'FIRST failure ( a step whose result is an error ). Returns `{ completed, failed, remaining }`: ' +
			'`completed` is `[{ tool, output }]` for every step that succeeded ( output is that tool\'s own ' +
			'result text ); `failed` is `{ index, tool, error }` or null; `remaining` is the tool names never ' +
			'reached. A nested {{batch}} is rejected. This tool is only as destructive as the tools it ' +
			'invokes — bundle heals ( move/delete ) and reads freely — but the sequence is NOT atomic: a ' +
			'mid-sequence failure leaves the earlier steps applied.',
		inputSchema: {
			type:       'object',
			properties: {
				calls: {
					type:        'array',
					description: 'Ordered tool calls; the batch stops at the first that fails.',
					items: {
						type:       'object',
						properties: {
							tool: { type: 'string', description: 'Registered tool name to invoke.' },
							args: { type: 'object', additionalProperties: true, description: 'Arguments for that tool.' },
						},
						required: [ 'tool' ],
					},
				},
			},
			required: [ 'calls' ],
		},
	},
};
