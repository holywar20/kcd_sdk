import { describe, it, expect } from 'vitest';
import '../../primitives/index';   // registers every type's fromSerialized hydrator ( fromHtml dispatches through it )
import { KCDPrimitive } from '../../primitives/framework/KCDPrimitive';
import type { LensObject } from '../../primitives/framework/LensObject';
import { Agent } from '../Agent';
import type { ToolDef } from '../ToolDef';

/**
 * `Agent.wireSystem` — the system half an agent puts on the wire, pinned byte-for-byte.
 *
 * A CHARACTERIZATION test, not a specification: it asserts nothing about what the string SHOULD say, only
 * that it does not change. Its job is the one-assembly refactor, which makes `compiledContext()` TOTAL —
 * the layers today joined outside it become blocks inside it. A pure refactor leaves these snapshots
 * untouched; anything else is a behaviour change wearing a refactor's clothes.
 *
 * This is the INNER half of the gate. Its twin in starmind pins the outer join through a real dispatch;
 * this one pins block order, text and pricing, because here every layer binds directly rather than
 * arriving through a model descriptor and a routed database — so root context, memory and the tool
 * surface can all carry real content instead of collapsing to empty.
 */

const LENS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Baseline Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">baseline</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture carrying real content in both regions.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Baseline Lens</h1>
<section data-kcd-region="care">
<section data-kcd-section="purpose">
<p>Why this lens exists.</p>
</section>
<section data-kcd-section="philosophy">
<p>What this lens defends.</p>
</section>
</section>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-slot="reference" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">Reference A</span><a data-kcd-field="where" data-kcd-type="path" href="ref-a.html">a</a><span data-kcd-field="why" data-kcd-type="text">when A applies</span></div>
</section>
</section>
</article>
</body></html>
`;

/** Two tools from one server, so the manifest's per-server grouping renders rather than falling into
 *  the unnamed fallback bucket. One rides `on` ( a manifest line ), one `suggested` ( a full schema ). */
const TOOLS: ToolDef[] = [
	// IDENTITIES ARE REQUIRED NOW. A def with no `group.tool` is not held — allowances key on it, and
	// admitting one because it lacks the field everything else is keyed by would make missing metadata a
	// way in. The fixture stamps them the way the priced serve seam does.
	{ id: 'srv.probe',  name: 'probe',  description: 'Look at a thing.', inputSchema: { type: 'object' }, server: { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' } },
	{ id: 'srv.commit', name: 'commit', description: 'Change a thing.',  inputSchema: { type: 'object' }, server: { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' } }
];

/**
 * An agent with EVERY system layer populated, each carrying distinct, greppable prose.
 *
 * The population is the whole point. A snapshot taken over an agent whose layers are empty would pass
 * through any reordering at all — it would prove the refactor changed nothing about nothing. Every layer
 * that can move has to be present and identifiable for the diff to mean anything.
 */
function fullAgent(): Agent {
	const lens  = KCDPrimitive.fromHtml( LENS_HTML, '/vault/_Claude/lenses/baseline/baseline.html' , '_Claude') as LensObject;
	const agent = Agent.create( {
		id:           'baseline-agent',   // fixed, so the snapshot does not churn on a fresh uuid
		lenses:       [ lens ],
		model:        'test.lorem',
		systemPrompt: 'The agent own authored instruction.',
		// ONE OF EACH SURFACE, so the snapshot carries both a manifest line and a preloaded schema — the two
		// layers this test exists to hold in order. Both are equally permitted; only the cost differs.
		toolPolicies: { 'srv.probe': 'allow', 'srv.commit': 'allow' },
		toolSurfaces: { 'srv.commit': 'preload' }
	} );
	agent.bindEnv( {
		hostPrompt:  'The host environment preamble.',
		rootContext: 'The model standing root context.',
		toolDefs:    TOOLS,
		// ONE CONTRIBUTOR, declaring the memory band for itself. The fixture used to bind `memory` +
		// `memoryTags` — a contributor compiled in by name — and the tag-vocabulary constant that headed the
		// band went with the memory module. A contributor composes its own text now.
		contributions: [ { id: 'semantic_memory', heading: 'Memory', text: 'A remembered thing.' } ],
		attachments: 'Attached: notes.md',
		// STRUCTURED, like every other manifest section's rows. This fixture passed a composed string, and
		// the expected wire below therefore showed `## Grants` with nothing under it — the bug, pinned as
		// correct. A row is what survives the merge; a string was silently dropped by it.
		grants:      [ { what: 'file', where: '/vault/notes.md', why: 'granted by the user for this session' } ]
	} );
	return agent;
}

describe( 'Agent.wireSystem — the pre-refactor baseline', () => {

	it( 'pins the assembled system half byte-for-byte', () => {
		expect( fullAgent().wireSystem() ).toMatchInlineSnapshot(`
			"The host environment preamble.

			---

			## Name
			You are baseline.

			---

			The agent own authored instruction.

			---

			The model standing root context.

			---

			# Purpose

			## baseline ( Primary )

			Why this lens exists.

			# Philosophy

			## baseline ( Primary )

			What this lens defends.

			## Memory

			A remembered thing.

			---

			# Manifest
			_Lookup surface — fetch these on demand; not required reading now._

			## Files
			- baseline — A lens fixture carrying real content in both regions. (/vault/_Claude/lenses/baseline/baseline.html)

			## References
			- Reference A — when A applies (ref-a.html)

			## Grants
			- file — granted by the user for this session (/vault/notes.md)

			---

			## Available tools

			Everything you hold is listed here. A tool marked [schema on request] is not in your callable set yet — ask for its schema, then call it.

			### Fixture server
			A fixture server.
			- probe — Look at a thing. [schema on request]
			- commit — Change a thing.

			---

			Attached: notes.md"
		`);
	} );

	it( 'pins the block ORDER by section tag — the readable half of the same gate', () => {
		expect( fullAgent().compiledContext().map( b => b.section ) ).toMatchInlineSnapshot(`
			[
			  "host-prompt",
			  null,
			  "agent-name",
			  null,
			  "system-prompt",
			  null,
			  "root-context",
			  null,
			  "purpose",
			  "philosophy",
			  "semantic_memory",
			  null,
			  null,
			  "files",
			  "references",
			  "grants",
			  null,
			  "tool-manifest",
			  null,
			  "attachments",
			]
		`);
	} );

	it( 'tells the agent its name, and carries no name block for an agent without one', () => {
		expect( fullAgent().compiledContext().find( b => b.section === 'agent-name' )?.text ).toBe( '## Name\nYou are baseline.' );

		const unnamed = fullAgent();
		unnamed.name = '  ';
		expect( unnamed.compiledContext().some( b => b.section === 'agent-name' ) ).toBe( false );
	} );

	it( 'pins the budget split, so a block that changes BUCKET is caught as well as one that moves', () => {
		expect( fullAgent().compiledBudget() ).toMatchInlineSnapshot(`
			{
			  "lenses": 127,
			  "system": 36,
			  "tools": 67,
			}
		`);
	} );
} );

/**
 * The per-source breakdown, held to being a PROJECTION of the wire rather than a second account of it.
 *
 * The first test here is the real gate, and it is an invariant rather than a snapshot: a snapshot can be
 * satisfied by a breakdown that silently drops a block, and dropping blocks is exactly how the old
 * hand-built version came to omit the tool manifest, the routing tables and the attachments. Joining the
 * segments has to reproduce the wire byte for byte — which is only possible if every block reaches
 * exactly one segment.
 */
describe( 'Agent.contextSegments — the breakdown is the wire, decomposed', () => {

	it( 'reproduces the wire exactly when its segments are joined back together', () => {
		const agent = fullAgent();

		expect( agent.contextSegments().map( s => s.text ).join( '\n\n' ) ).toBe( agent.wireSystem() );
	} );

	it( 'still reproduces it with the caller layers bound — the blocks folded in most recently', () => {
		const agent = fullAgent();
		agent.bindEnv( { frame: 'You are seated in a room with two others.', modeLine: 'Reason in the reply.' } );

		expect( agent.contextSegments().map( s => s.text ).join( '\n\n' ) ).toBe( agent.wireSystem() );
	} );

	it( 'files the caller layers under system, so a room frame is visible in the breakdown', () => {
		const agent = fullAgent();
		agent.bindEnv( { frame: 'You are seated in a room with two others.', modeLine: 'Reason in the reply.' } );

		const system = agent.contextSegments().filter( s => s.source === 'system' ).map( s => s.label );

		expect( system ).toContain( 'caller frame' );
		expect( system ).toContain( 'shaping line' );
	} );

	it( 'emits no segment for a divider — structure joins the segment it introduces', () => {
		const labels = fullAgent().contextSegments().map( s => s.label );

		expect( labels ).not.toContain( '' );
		expect( labels.every( l => l.trim().length > 0 ) ).toBe( true );
	} );

	it( 'pins the source/label roster — what a reader sees in the round drawer', () => {
		const agent = fullAgent();
		agent.bindEnv( { frame: 'You are seated in a room with two others.', modeLine: 'Reason in the reply.' } );

		expect( agent.contextSegments().map( s => `${ s.source } / ${ s.label }` ) ).toMatchInlineSnapshot(`
			[
			  "system / host prompt",
			  "system / name",
			  "system / agent instruction",
			  "system / root context",
			  "lens / purpose",
			  "lens / philosophy",
			  "injection / semantic_memory",
			  "index / files",
			  "index / references",
			  "index / grants",
			  "tools / available tools",
			  "system / attachments",
			  "system / caller frame",
			  "system / shaping line",
			]
		`);
	} );
} );
