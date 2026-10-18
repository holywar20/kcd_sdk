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
 * that it does not change. Its twin in starmind pins the outer join through a real dispatch; this one pins
 * block order, text and pricing, with every layer bound directly so each carries real content.
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
	// A def with no identity is not held: admitting one for lacking the field would make missing metadata a way in.
	// The fixture stamps identities the way the priced serve seam does.
	{ id: 'srv.probe',  name: 'probe',  description: 'Look at a thing.', inputSchema: { type: 'object' }, server: { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' } },
	{ id: 'srv.commit', name: 'commit', description: 'Change a thing.',  inputSchema: { type: 'object' }, server: { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' } }
];

/** An agent with every system layer populated, each with distinct greppable prose: a snapshot over empty layers would pass any reordering at all. */
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
		// The search tool's name, bound as the host binds it, so the manifest note names the mechanism the wire
		// carries rather than the mechanism-free form an unhosted agent falls back to.
		searchTool:  'tool_search',
		// One contributor declares the memory band itself: a contributor composes its own text.
		contributions: [ { id: 'semantic_memory', heading: 'Memory', text: 'A remembered thing.' } ],
		attachments: 'Attached: notes.md',
		// Structured rows, like every other manifest section: a composed string is silently dropped by the merge.
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

			A \`###\` heading may carry its package's own description. THAT DESCRIPTION IS NOT NARROWED TO YOU — it describes the whole package, so it can name tools, in prose and by name, that are not on your rows. THE ROWS ARE YOUR ROSTER. Where the two disagree the rows are right: a tool the description discusses and the rows do not list is one you DO NOT HOLD, however specifically it is described. Do not plan a deliverable around it, and say so plainly instead.

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
 * The environment layer, on an agent that binds it: `fullAgent` deliberately does not, so the snapshots above
 * keep characterizing the layers that existed before this one. What is held here is the POSITION and the
 * PRICING, not the text: a layer sorted into the lens band is charged to the wrong bucket and read as lens identity.
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
 * THE SKILL SPINE — an attached skill's name and description, in the context the agent is actually sent.
 *
 * Its own describe, as the environment layer has: `fullAgent` binds no skills, so an agent with none stays
 * byte-identical to one compiled before this layer existed. What is held is the POSITION, the PRICING and the
 * WHOLENESS of the description: a clipped description is a skill that silently stops firing.
 * The live claim is pinned in starmind's SkillSpineOnTheWire suite.
 */
describe( 'Agent.skillSpine — the attached-skill label', () => {

	const DESCRIPTION = 'Extract text, fill forms, merge, or otherwise manipulate PDF files.';

	function withSkill(): Agent {
		const agent = fullAgent();
		agent.bindEnv( { skills: [ { name: 'pdf-processing', description: DESCRIPTION } ] } );
		return agent;
	}

	it( 'puts the name and the whole description on the wire', () => {
		const wire = withSkill().wireSystem();

		expect( wire ).toContain( '## Your skills' );
		expect( wire ).toContain( `- pdf-processing — ${ DESCRIPTION }` );
	} );

	it( 'never truncates, at the spec bound or past it', () => {
		const agent = fullAgent();
		// 1024 is the spec's cap. 2000 is past it: the cap is the library's business, and this layer's job is
		// to carry whatever it is handed intact rather than to enforce a limit a second time.
		for ( const length of [ 1024, 2000 ] ) {
			const long = 'd'.repeat( length );
			agent.bindEnv( { skills: [ { name: 'long-one', description: long } ] } );
			expect( agent.wireSystem() ).toContain( `- long-one — ${ long }` );
		}
	} );

	it( 'carries no block at all when nothing is attached', () => {
		// Every layer in this tier has to return to EMPTY: `[]` is the off value, not a heading over nothing.
		expect( fullAgent().compiledContext().some( b => b.section === 'skills' ) ).toBe( false );

		const emptied = withSkill();
		emptied.bindEnv( { skills: [] } );
		expect( emptied.compiledContext().some( b => b.section === 'skills' ) ).toBe( false );
		// And back to byte-identical with the agent that never had one.
		expect( emptied.wireSystem() ).toBe( fullAgent().wireSystem() );
	} );

	it( 'is NOT a manifest section — it sits in the required-reading half', () => {
		// The whole design decision: the `# Manifest` band's heading says "not required reading now", and the
		// spine label is the discovery mechanism. Beneath that heading it would be defeated invisibly.
		const agent  = withSkill();
		const blocks = agent.compiledContext();
		const skills = blocks.findIndex( b => b.section === 'skills' );

		expect( skills ).toBeGreaterThan( -1 );
		// Filed as reach rather than as one of the routing tables — the breakdown says `tools`, not `index`.
		expect( Agent.segmentKey( blocks[ skills ] )?.source ).toBe( 'tools' );
		// Below the manifest tables, above the run-specific capability layer — beside the tool manifest.
		expect( blocks.findIndex( b => b.section === 'references' ) ).toBeLessThan( skills );
		expect( blocks.findIndex( b => b.section === 'tool-manifest' ) ).toBeLessThan( skills );
	} );

	it( 'prices as TOOLS — reach, not lens identity', () => {
		const before = fullAgent().compiledBudget();
		const agent  = withSkill();
		const after  = agent.compiledBudget();

		expect( Agent.bucketOf( agent.compiledContext().find( b => b.section === 'skills' )! ) ).toBe( 'tools' );
		// The label's own weight lands on TOOLS: a move of less than ten would mean the block was charged elsewhere.
		expect( after.tools - before.tools ).toBeGreaterThan( 10 );
		// The lens band moves by one divider (a pre-existing `bucketOf` property: sectionless blocks price as lenses),
		// so it is bounded, not equal. The claim that matters is that no lens CONTENT was recharged.
		expect( after.lenses - before.lenses ).toBeLessThanOrEqual( 2 );
	} );

	it( 'names itself in the breakdown, and still reproduces the wire exactly', () => {
		const agent = withSkill();

		expect( agent.contextSegments().filter( s => s.source === 'tools' ).map( s => s.label ) ).toContain( 'your skills' );
		expect( agent.contextSegments().map( s => s.text ).join( '\n\n' ) ).toBe( agent.wireSystem() );
	} );

	it( 'lists every attached skill, in the order it was handed them', () => {
		const agent = fullAgent();
		agent.bindEnv( { skills: [
			{ name: 'beta-skill',  description: 'Beta does another thing.' },
			{ name: 'alpha-skill', description: 'Alpha does a thing.' }
		] } );

		const wire = agent.wireSystem();
		expect( wire.indexOf( 'beta-skill' ) ).toBeLessThan( wire.indexOf( 'alpha-skill' ) );
	} );
} );

/**
 * The per-source breakdown, held to being a PROJECTION of the wire. The invariant is the gate, not the snapshot:
 * a snapshot can pass a breakdown that silently drops a block, so joining the segments must reproduce the wire.
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
 * The slug is held by the record and never shown to the agent: an invisible field needs a check that fails the
 * moment it becomes visible. The sentinel is unlike anything the compile emits, and it is checked against both
 * doors an agent's context leaves by: the assembled wire and every structured block, which can carry text the
 * wire has not joined yet.
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
 * The REASONING DEFAULT — the effort and mode a session spawned under this agent is born on. Persisted and
 * wired like the slug, and NOT shown to the agent. The clamp against a model's declared stops is not tested
 * here: it needs a model descriptor, and lives in `clampReasoningEffort`.
 */
describe( 'Agent.reasoning — a default a session inherits, not a fact the agent reads', () => {

	function dialled(): Agent {
		const agent     = fullAgent();
		agent.reasoning = { effort: 'xhigh', mode: 'show' };
		return agent;
	}

	it( 'is absent by default, and NULL does not mean medium', () => {
		const bare = Agent.create( { name: 'Lincoln', model: 'test.lorem' } );

		// `medium` was asserted on every agent's behalf by a fallback; only null can say "no default was stated".
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

		// Refused, not clamped: an off-roster effort means nothing, and guessing one would invent a default.
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
