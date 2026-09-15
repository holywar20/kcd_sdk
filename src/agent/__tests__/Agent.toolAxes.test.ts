import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import '../../primitives/index';   // registers the hydrators, so a load yields a real LensObject
import { Agent } from '../Agent';
import { LensObject } from '../../primitives/framework/LensObject';
import { KcdEdit } from '../../core/html/KcdEdit';
import type { ToolDef } from '../ToolDef';

/**
 * THE TWO AXES A TOOL IS HELD ON — may it run, and what does it cost.
 *
 * This suite replaces the one that pinned which KEY a mode was filed under. That question is settled and
 * the identity rides on the def ( `ToolDef.id`, stamped app-side at the priced serve seam ), because this
 * package cannot import the app's tool vocabulary and would otherwise have to spell the separator itself —
 * which is exactly how there came to be two spellers, four readers, and a control that rendered "off" over
 * a tool that was still held.
 *
 * WHAT IT PINS NOW IS THE MODEL. Presence in `toolPolicies` IS the allowance; `off` is a subtraction of
 * something a lens supplied and never survives assembly; the cost axis composes INDEPENDENTLY, so tightening
 * a tool to `ask` says nothing about what it costs to carry.
 */

const SERVER = { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' };

const DEFS: ToolDef[] = [
	{ id: 'srv.probe',  name: 'probe',  description: 'Look at a thing.', inputSchema: { type: 'object' }, server: SERVER },
	{ id: 'srv.commit', name: 'commit', description: 'Change a thing.',  inputSchema: { type: 'object' }, server: SERVER }
];

function agentWith(
	toolPolicies: Record<string, 'off' | 'allow' | 'ask'>,
	toolSurfaces: Record<string, 'manifest' | 'preload'> = {},
	defs: ToolDef[] = DEFS
): Agent {
	const agent = Agent.create( { id: 'axes-agent', lenses: [], model: 'test.lorem', toolPolicies, toolSurfaces } );
	agent.bindEnv( { toolDefs: defs } );
	return agent;
}

describe( 'Agent — the two tool axes', () => {

	it( 'holds NOTHING when nothing was put on it', () => {
		// The hinge. Absence and denial are one fact, so a fresh agent reaches no tool at all — it does not
		// start holding everything and wait to be trimmed.
		expect( agentWith( {} ).toolAllowances() ).toEqual( {} );
	} );

	it( 'files an allowance by IDENTITY — a bare key names nothing that is served', () => {
		// A bare key silently working again would mean two formats both work, which is how the two writers
		// coexisted for as long as they did: each looked correct on the surface its own reader served. The
		// key is kept verbatim; what it fails to do is match any served def.
		const agent = agentWith( { probe: 'allow' } );
		expect( agent.toolAllowances() ).toEqual( { probe: 'allow' } );
		expect( Object.keys( agent.toolAllowances() ) ).not.toContain( 'srv.probe' );
	} );

	it( 'does NOT re-check policy when it compiles — it compiles what it was bound', () => {
		// The seam that makes deny-is-absence structural rather than repeated. Main narrows the defs to what
		// the run may call and binds THAT, so the compiler's only remaining question is cost. A manifest that
		// filtered by policy a second time would be a second resolver of the question the passport answered,
		// and the two would eventually disagree in the permissive direction.
		const agent = agentWith( {}, { 'srv.probe': 'preload' } );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.probe' ] );
	} );

	it( 'SPENDS a subtraction rather than carrying it — nothing denied survives assembly', () => {
		// The guarantee every downstream reader depends on. A denied tool is absent from the assembled map,
		// so the gate, the manifest, the preload and the harness cut all work from a list that cannot express
		// a denial — and none of them can be the one that forgets to check for one.
		const agent = agentWith( { 'srv.probe': 'allow', 'srv.commit': 'off' } );
		expect( agent.toolAllowances() ).toEqual( { 'srv.probe': 'allow' } );
	} );

	it( 'a lens\'s tools grant NOTHING live — only what was merged into the agent is held', () => {
		// Lens tools are merged into the agent's passport once, at authoring; `toolPolicies` mirrors it.
		const agent = agentWith( { 'srv.probe': 'allow' } );
		agent.composedToolPolicies = { 'srv.commit': 'allow' };
		expect( agent.toolAllowances() ).toEqual( { 'srv.probe': 'allow' } );
	} );

	it( 'keeps ASK in the allowances — a prompt is not an absence', () => {
		const agent = agentWith( { 'srv.probe': 'ask' } );
		expect( agent.toolAllowances() ).toEqual( { 'srv.probe': 'ask' } );
	} );

	it( 'defaults the COST axis to manifest, the cheap answer', () => {
		expect( agentWith( { 'srv.probe': 'allow' } ).toolSurfaceFor( 'srv.probe' ) ).toBe( 'manifest' );
	} );

	it( 'names BOTH tools in the manifest and marks only the deferred one', () => {
		// Both tools are equally permitted; what differs is what each spends. Under the diagonal this pair
		// of states was unreachable — there was no way to say "allowed, but do not spend a schema on it"
		// while another tool rode in whole.
		//
		// THIS PINNED THE OPPOSITE UNTIL 2026-09-05, and the inversion is the fix rather than a loosened
		// assertion. It asserted the manifest did NOT name a preloaded tool — and that omission was the
		// defect: the wire carries name, description and schema with no SERVER, so a preloaded tool named
		// nowhere else reached the model as a bare verb it could not place. An agent holding `learn` and
		// `recall` reported having no memory tool, correctly, because nothing in its context said Memory.
		//
		// So the manifest names everything and the MARK carries the axis. What the surface decides is what a
		// tool COSTS, never whether it is identifiable.
		const agent = agentWith(
			{ 'srv.probe': 'allow', 'srv.commit': 'allow' },
			{ 'srv.commit': 'preload' }
		);
		const lines     = agent.toolManifest().split( '\n' );
		const probeRow  = lines.find( l => l.startsWith( '- probe' ) );
		const commitRow = lines.find( l => l.startsWith( '- commit' ) );

		expect( probeRow ).toBeDefined();
		expect( commitRow ).toBeDefined();
		// Read off the ROW rather than the whole string: a substring check would pass on a manifest that
		// marked the wrong tool, which is the only way this can actually break.
		expect( probeRow ).toContain( '[schema on request]' );
		expect( commitRow ).not.toContain( '[schema on request]' );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.commit' ] );
	} );

	it( 'costs a tool INDEPENDENTLY of how tightly it is governed', () => {
		// The two axes are not one diagonal. An agent that made a tool ask first has said nothing about
		// whether its schema rides the prompt, and a reader that inferred one from the other would put the
		// expensive answer behind a security decision.
		const agent = agentWith( { 'srv.commit': 'ask' }, { 'srv.commit': 'preload' } );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.commit' ] );
	} );

	it( 'names the search tool in the manifest note once the host binds one, and no mechanism before', () => {
		// bug-report-9. The note used to say only "ask for its schema" — the tool that fetches one describes
		// itself on the wire, and a name spelled here would be a second copy. A local model told the mechanism
		// only inside a tool result kept calling the one tool it had fetched. So the host BINDS the name and
		// the note says which tool to call, that a server's name fetches all of that server's tools, and that
		// a tool already fetched is no stand-in for one that is not.
		const agent = agentWith( { 'srv.probe': 'allow' } );
		expect( agent.toolManifest() ).toContain( 'ask for its schema, then call it' );
		expect( agent.toolManifest() ).not.toContain( 'tool_search' );

		agent.bindEnv( { searchTool: 'tool_search' } );
		const note = agent.toolManifest().split( '\n' ).find( l => l.startsWith( 'Everything you hold' ) );
		expect( note ).toContain( 'call tool_search with its exact name' );
		expect( note ).toContain( 'server\'s name' );
		expect( note ).toContain( 'never stands in for one you have not fetched' );
	} );

	it( 'says nothing about fetching when nothing is deferred, whichever tool the host named', () => {
		// Both bound defs ride whole, so there is nothing to fetch and the note — mechanism and all — is absent.
		const agent = agentWith( { 'srv.probe': 'allow', 'srv.commit': 'allow' }, { 'srv.probe': 'preload', 'srv.commit': 'preload' } );
		agent.bindEnv( { searchTool: 'tool_search' } );
		expect( agent.toolManifest() ).not.toContain( 'tool_search' );
		expect( agent.toolManifest() ).not.toContain( 'Everything you hold' );
	} );

	it( 'does not hold a def that never crossed the serve seam', () => {
		// A double has no identity to be filed under, and admitting it BECAUSE it lacks the field everything
		// else is keyed by would make missing metadata a way in. This inverts the old fallback deliberately.
		const doubles: ToolDef[] = [ { name: 'probe', description: 'Look at a thing.', inputSchema: { type: 'object' } } ];
		expect( agentWith( { probe: 'allow' }, {}, doubles ).toolManifest() ).toBe( '' );
	} );
} );

/**
 * WHAT A LENS FILES A TOOL UNDER — the identity, read off the real floor lens rather than a fixture.
 *
 * `_lens-base` is the document every agent wears, so it is the contract: its Tools table names each tool as
 * `group.tool`, and that key must reach the agent unchanged and be the key an edit addresses. A fixture
 * could agree with the code and still disagree with the vault.
 */
describe( 'a lens contributes tools by IDENTITY', () => {
	const PROJECT_ROOT = path.resolve( __dirname, '../../../..' );   // kcd_sdk/src/agent/__tests__ → repo root
	const BASE_PATH    = path.join( PROJECT_ROOT, '_Claude/lenses/_lens-base.html' );

	function loadBase(): LensObject {
		return LensObject.load( BASE_PATH, { projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ) } );
	}

	it( 'composes the floor lens\'s tools onto the agent under their group.tool keys', () => {
		const agent = Agent.create( { lenses: [ loadBase() ] } );
		expect( agent.composedToolPolicies[ 'sm_documentation.get_doc' ] ).toBe( 'allow' );
		expect( agent.composedToolSurfaces[ 'sm_documentation.get_doc' ] ).toBe( 'preload' );
		// No bare key rides along beside the identity.
		expect( Object.keys( agent.composedToolPolicies ) ).not.toContain( 'kcd_get' );
	} );

	it( 'edits a tool row by its identity, and a bare name addresses nothing', () => {
		const body = loadBase().serialize().body;

		const removed = KcdEdit.setTool( body, 'sm_documentation.get_doc', 'off' );
		expect( removed ).not.toBeNull();
		expect( removed ).not.toContain( '>sm_documentation.get_doc<' );
		expect( removed ).toContain( '>sm_documentation.query_docs<' );

		expect( KcdEdit.setTool( body, 'kcd_get', 'off' ) ).toBeNull();
	} );
} );
