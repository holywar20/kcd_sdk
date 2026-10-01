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
 * arriving through a model descriptor and a routed database — so memory and the tool
 * surface can both carry real content instead of collapsing to empty.
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
<section data-kcd-section="personality">
<p>Why this lens exists.</p>
</section>
<section data-kcd-section="philosophy">
<p>What this lens defends.</p>
</section>
<section data-kcd-section="references">
<div data-kcd-slot="reference" data-kcd-mode="on"><span data-kcd-field="what" data-kcd-type="text">Reference A</span><a data-kcd-field="where" data-kcd-type="path" href="ref-a.html">a</a><span data-kcd-field="why" data-kcd-type="text">when A applies</span></div>
</section>
</article>
</body></html>
`;

/** Two tools from one server, so the manifest's per-server grouping renders rather than falling into
 *  the unnamed fallback bucket. One rides `on` ( a manifest line ), one `load` ( a full schema ). */
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
		// ONE OF EACH MODE, so the snapshot carries both a manifest line and a preloaded schema — the two
		// layers this test exists to hold in order. Both are equally carried; only how much rides differs.
		toolModes: { 'srv.probe': 'on', 'srv.commit': 'preload' }
	} );
	agent.bindEnv( {
		hostPrompt:  'The host environment preamble.',
		toolDefs:    TOOLS,
		// THE SEARCH TOOL'S NAME, bound as the host binds it, so the manifest's note names the mechanism the
		// wire carries rather than the mechanism-free form an unhosted agent falls back to ( bug-report-9 ).
		searchTool:  'tool_search',
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

	/** Re-pinned 2026-09-15 for two deliberate changes to the tool manifest: the calling rule ( wire names,
	 *  2026-09-13 ) and the note naming the search tool the host bound ( bug-report-9 ). The agent's name
	 *  block landed the same day on another machine, and the two were pinned together at the merge. Re-pinned
	 *  2026-09-22 for the flat lens: a lens's Purpose is its Personality now ( plan agents-own-behaviour ). */
	it( 'pins the assembled system half byte-for-byte', () => {
		expect( fullAgent().wireSystem() ).toMatchInlineSnapshot(`
			"The host environment preamble.

			---

			## Name
			You are baseline.

			---

			The agent own authored instruction.

			---

			# Personality

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

			Call a tool by the exact name its row begins with — \`probe\`, letter for letter, server part included. A name that is not on this list is not a tool you hold.

			Everything you hold is listed here. A tool marked [schema on request] is not callable yet: call tool_search with its exact name, or with a server's name for all of that server's tools, then call it. A tool you already have never stands in for one you have not fetched.

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
			  "personality",
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
			  "lenses": 128,
			  "system": 28,
			  "tools": 140,
			}
		`);
	} );
} );

/**
 * The environment layer — what the host says about the INSTALLATION an agent is running in.
 *
 * Its own describe, on an agent that binds it, because `fullAgent` deliberately does not: the snapshots above
 * are a characterization of the layers that existed before this one, and adding a block to that fixture would
 * have re-pinned every one of them to prove a new layer works.
 *
 * WHAT IS WORTH HOLDING is the POSITION and the PRICING, not the text — the text is the host's, composed
 * main-side in starmind, and this side only carries it. A layer that quietly sorted into the lens band would
 * be charged to the wrong bucket in the gauge and read as lens identity in the breakdown, which are both
 * silent failures: everything still renders, and the numbers are wrong.
 */
describe( 'Agent — the environment layer', () => {

	function withEnvironment(): Agent {
		const agent = fullAgent();
		agent.bindEnv( { hostEnvironment: '## Environment\nYou are running inside Starmind Dev.' } );
		return agent;
	}

	it( 'sits directly beneath the host prompt, above the agent own identity', () => {
		const sections = withEnvironment().compiledContext().map( b => b.section ).filter( s => s !== null );

		// Adjacent, in this order, and ahead of the name — the prefix-cache argument the block is placed on:
		// shared by every agent in the instance, so it belongs above everything that varies per agent.
		expect( sections.slice( 0, 3 ) ).toEqual( [ 'host-prompt', 'host-environment', 'agent-name' ] );
	} );

	it( 'carries no block at all when nothing binds one', () => {
		// Every layer in this tier has to be able to go back to EMPTY — an SDK-built agent outside a dispatch
		// binds no environment, and must not carry a heading with nothing under it.
		expect( fullAgent().compiledContext().some( b => b.section === 'host-environment' ) ).toBe( false );
	} );

	it( 'prices as SYSTEM rather than as lens identity', () => {
		const agent = withEnvironment();

		expect( Agent.bucketOf( agent.compiledContext().find( b => b.section === 'host-environment' )! ) ).toBe( 'system' );
		expect( agent.compiledBudget().system ).toBeGreaterThan( fullAgent().compiledBudget().system );
	} );

	it( 'names itself in the breakdown, and still reproduces the wire exactly', () => {
		const agent = withEnvironment();

		expect( agent.contextSegments().filter( s => s.source === 'system' ).map( s => s.label ) ).toContain( 'environment' );
		expect( agent.contextSegments().map( s => s.text ).join( '\n\n' ) ).toBe( agent.wireSystem() );
	} );

	it( 'puts its text on the wire where the block sits', () => {
		const wire = withEnvironment().wireSystem();

		expect( wire ).toContain( 'You are running inside Starmind Dev.' );
		expect( wire.indexOf( 'You are running inside Starmind Dev.' ) ).toBeLessThan( wire.indexOf( 'You are baseline.' ) );
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
			  "lens / personality",
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

/**
 * The SLUG — a one-line description of what an agent is for, written by a third party FOR a third party.
 *
 * THE DELIVERABLE HERE IS THE INVISIBILITY TEST, not the field. A field that is supposed to be invisible
 * needs a check that fails the moment it becomes visible, or the invariant is quietly broken by the next
 * person to add a context block and nobody finds out until an agent is reading its own performance review.
 * The sentinel is deliberately unlike anything else the compile emits, so a match is a match and not a
 * coincidence, and it is checked against BOTH doors an agent's context leaves by — the assembled wire and
 * every block of the structured form, since a block can carry text the wire has not joined yet.
 *
 * It lives in this file because this is where the wire is pinned. The snapshots above are the other half of
 * the same gate: a slug folded into a context block would break one of them too. This one says WHY.
 */
describe( 'Agent.slug — held by the record, never shown to the agent', () => {

	/** Nothing in the compile emits a string like this, so a hit is the field leaking and not a false one. */
	const SENTINEL = 'ZZQX-SLUG-SENTINEL-DO-NOT-COMPILE-ZZQX';

	function slugged(): Agent {
		const agent = fullAgent();
		agent.slug  = SENTINEL;
		return agent;
	}

	it( 'appears nowhere in wireSystem() — the assembled half', () => {
		const agent = slugged();

		// The premise first: an agent that is NOT carrying the sentinel must not match it either, or this
		// test would pass against a compile that emits nothing at all.
		expect( agent.slug ).toBe( SENTINEL );
		expect( agent.wireSystem() ).not.toContain( SENTINEL );
	} );

	it( 'appears in no block of compiledContext() — the structured half', () => {
		const blocks = slugged().compiledContext();

		expect( blocks.length ).toBeGreaterThan( 0 );
		expect( blocks.some( b => b.text.includes( SENTINEL ) ) ).toBe( false );
		expect( blocks.some( b => ( b.section ?? '' ).includes( 'slug' ) ) ).toBe( false );
	} );

	it( 'appears in no segment of the breakdown either — the third door onto the same text', () => {
		const segments = slugged().contextSegments();

		expect( segments.some( s => s.text.includes( SENTINEL ) || s.label.includes( SENTINEL ) ) ).toBe( false );
	} );

	it( 'costs the context nothing — the budget is identical with and without it', () => {
		// The corollary of invisibility, and the one a reader can check at a glance. If a later change puts
		// the slug into a block, the price moves whether or not the sentinel survives the formatting.
		expect( slugged().compiledBudget() ).toEqual( fullAgent().compiledBudget() );
	} );

	it( 'round-trips through serialize and hydrate', () => {
		const back = Agent.fromSerialized( slugged().serializeForWire() );

		expect( back.slug ).toBe( SENTINEL );
		// And the RECORD form too — it is the one main persists.
		expect( Agent.fromSerialized( slugged().serializeRecord() ).slug ).toBe( SENTINEL );
	} );

	it( 'is absent by default, and synthesizes nothing in its place', () => {
		const bare = Agent.create( { name: 'Lincoln', model: 'test.lorem' } );

		expect( bare.slug ).toBeNull();
		expect( bare.serializeForWire().slug ).toBeNull();
		expect( Agent.fromSerialized( bare.serializeForWire() ).slug ).toBeNull();
	} );

	it( 'reads absent from a wire form that predates the field', () => {
		const wire = fullAgent().serializeForWire();
		delete wire.slug;

		expect( Agent.fromSerialized( wire ).slug ).toBeNull();
	} );

	it( 'clamps at the cap rather than refusing — a dropped edit is the worse answer', () => {
		const agent = fullAgent();
		agent.slug  = 'x'.repeat( Agent.SLUG_MAX + 40 );

		expect( agent.slug ).toHaveLength( Agent.SLUG_MAX );
		// And the clamp survives the wire, so nothing downstream sees the unclamped string.
		expect( Agent.fromSerialized( agent.serializeForWire() ).slug ).toHaveLength( Agent.SLUG_MAX );
	} );

	it( 'keeps a slug at the cap whole', () => {
		const agent = fullAgent();
		const exact = 'y'.repeat( Agent.SLUG_MAX );
		agent.slug  = exact;

		expect( agent.slug ).toBe( exact );
	} );

	it( 'folds blank, empty and undefined onto null — absent is ONE state', () => {
		const agent = fullAgent();

		agent.slug = '   ';
		expect( agent.slug ).toBeNull();
		agent.slug = '';
		expect( agent.slug ).toBeNull();
		agent.slug = undefined;
		expect( agent.slug ).toBeNull();
	} );

	it( 'is one line — a pasted newline is flattened, not carried into a roster read', () => {
		const agent = fullAgent();
		agent.slug  = '  fast, less capable\n\n— documentation and book-keeping  ';

		expect( agent.slug ).toBe( 'fast, less capable — documentation and book-keeping' );
	} );

	it( 'is normalized through Agent.create as well, not only through the accessor', () => {
		const made = Agent.create( { slug: `  ${ 'z'.repeat( Agent.SLUG_MAX + 5 ) }  ` } );

		expect( made.slug ).toHaveLength( Agent.SLUG_MAX );
	} );
} );

/**
 * The REASONING DEFAULT — the effort and mode a session spawned under this agent is born on.
 *
 * It sits beside the slug for the reason it follows the slug's discipline: persisted on the record, crossing
 * the wire, null when unset, nothing synthesized, normalized once through the accessor — and NOT shown to the
 * agent. The invisibility half matters slightly less here than it does for the slug ( nobody is told they are
 * less capable ) and is pinned anyway, because the field is a fact ABOUT the agent that the agent has no use
 * for, and an unasserted invariant is one the next context block quietly breaks.
 *
 * The TRAP this file's cases do NOT cover is the clamp against a model's declared stops. That needs a model
 * descriptor, which the record has no business resolving — it lives in `clampReasoningEffort` and is driven
 * from the session-creation path, where the suite can hand it a real descriptor.
 */
describe( 'Agent.reasoning — a default a session inherits, not a fact the agent reads', () => {

	function dialled(): Agent {
		const agent     = fullAgent();
		agent.reasoning = { effort: 'xhigh', mode: 'show' };
		return agent;
	}

	it( 'is absent by default, and NULL does not mean medium', () => {
		const bare = Agent.create( { name: 'Lincoln', model: 'test.lorem' } );

		// The whole reason the field exists: `medium` was being asserted on every agent's behalf by a
		// fallback, and "no default was stated" is a different fact that only null can hold.
		expect( bare.reasoning ).toBeNull();
		expect( bare.serializeForWire().reasoning ).toBeNull();
		expect( Agent.fromSerialized( bare.serializeForWire() ).reasoning ).toBeNull();
	} );

	it( 'round-trips through both wire forms', () => {
		expect( Agent.fromSerialized( dialled().serializeForWire() ).reasoning ).toEqual( { effort: 'xhigh', mode: 'show' } );
		// And the RECORD form — it is the one main persists.
		expect( Agent.fromSerialized( dialled().serializeRecord() ).reasoning ).toEqual( { effort: 'xhigh', mode: 'show' } );
	} );

	it( 'reads absent from a wire form that predates the field', () => {
		const wire = dialled().serializeForWire();
		delete wire.reasoning;

		expect( Agent.fromSerialized( wire ).reasoning ).toBeNull();
	} );

	it( 'REFUSES a stop that is not on the roster, rather than guessing which one was meant', () => {
		const agent = fullAgent();

		// Refused rather than repaired — the opposite of the slug's clamp, because a slug that is too long
		// still says what it meant and an effort off-roster means nothing at all. Guessing would invent a
		// default, which is exactly the assertion this field exists to stop.
		agent.reasoning = { effort: 'turbo', mode: 'chain' } as never;
		expect( agent.reasoning ).toBeNull();

		agent.reasoning = { effort: 'high', mode: 'loud' } as never;
		expect( agent.reasoning ).toBeNull();

		agent.reasoning = {} as never;
		expect( agent.reasoning ).toBeNull();
	} );

	it( 'accepts every declared stop, and both modes', () => {
		const agent = fullAgent();

		for( const effort of [ 'low', 'medium', 'high', 'xhigh', 'max' ] as const ) {
			agent.reasoning = { effort, mode: 'chain' };
			expect( agent.reasoning ).toEqual( { effort, mode: 'chain' } );
		}
		agent.reasoning = { effort: 'low', mode: 'show' };
		expect( agent.reasoning?.mode ).toBe( 'show' );
	} );

	it( 'is normalized through Agent.create as well, not only through the accessor', () => {
		expect( Agent.create( { reasoning: { effort: 'nope', mode: 'chain' } as never } ).reasoning ).toBeNull();
		expect( Agent.create( { reasoning: { effort: 'max', mode: 'chain' } } ).reasoning ).toEqual( { effort: 'max', mode: 'chain' } );
	} );

	it( 'reaches NEITHER door of the agent\'s own context, and costs it nothing', () => {
		const agent = dialled();

		// No sentinel string is available for a closed union, so the invariant is pinned the two other ways
		// the slug's is: the stop name appears in no block, and the budget does not move.
		expect( agent.compiledContext().some( b => b.text.includes( 'xhigh' ) ) ).toBe( false );
		expect( agent.wireSystem() ).not.toContain( 'xhigh' );
		expect( agent.compiledBudget() ).toEqual( fullAgent().compiledBudget() );
	} );
} );
