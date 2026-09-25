import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import '../../primitives/index';   // registers the hydrators, so a load yields a real LensObject
import { Agent } from '../Agent';
import { LensObject } from '../../primitives/framework/LensObject';
import { KcdEdit } from '../../core/html/KcdEdit';
import type { ToolDef } from '../ToolDef';

/**
 * THE ONE AXIS A TOOL IS HELD ON — does this agent carry it, and how much of it rides.
 *
 * This suite replaces the one that pinned which KEY a mode was filed under. That question is settled and
 * the identity rides on the def ( `ToolDef.id`, stamped app-side at the priced serve seam ), because this
 * package cannot import the app's tool vocabulary and would otherwise have to spell the separator itself —
 * which is exactly how there came to be two spellers, four readers, and a control that rendered "off" over
 * a tool that was still held.
 *
 * IT PINNED TWO AXES UNTIL 2026-09-22 — an allowance beside a cost. An agent has no allowance to give: it
 * is a PROTOTYPE, and a run's papers are minted from it, so `allow` / `ask` / `deny` belong to the passport
 * and the project. What is left is `off` / `on` / `preload`, and the model this suite pins now is that
 * presence IS the answer: `off` is never stored, and a tool absent from the map is a tool the agent does
 * not carry and the passport is never minted with.
 */

const SERVER = { id: 'srv', name: 'Fixture server', doc: 'A fixture server.' };

const DEFS: ToolDef[] = [
	{ id: 'srv.probe',  name: 'probe',  description: 'Look at a thing.', inputSchema: { type: 'object' }, server: SERVER },
	{ id: 'srv.commit', name: 'commit', description: 'Change a thing.',  inputSchema: { type: 'object' }, server: SERVER }
];

function agentWith(
	toolModes: Record<string, 'off' | 'on' | 'preload'>,
	defs: ToolDef[] = DEFS
): Agent {
	const agent = Agent.create( { id: 'axes-agent', lenses: [], model: 'test.lorem', toolModes } );
	agent.bindEnv( { toolDefs: defs } );
	return agent;
}

describe( 'Agent — the one tool axis', () => {

	it( 'carries NOTHING when nothing was put on it', () => {
		// The hinge. Absence and denial are one fact, so a fresh agent reaches no tool at all — it does not
		// start holding everything and wait to be trimmed.
		expect( agentWith( {} ).carriedTools() ).toEqual( {} );
	} );

	it( 'files a mode by IDENTITY — a bare key names nothing that is served', () => {
		// A bare key silently working again would mean two formats both work, which is how the two writers
		// coexisted for as long as they did: each looked correct on the surface its own reader served. The
		// key is kept verbatim; what it fails to do is match any served def.
		const agent = agentWith( { probe: 'on' } );
		expect( agent.carriedTools() ).toEqual( { probe: 'on' } );
		expect( Object.keys( agent.carriedTools() ) ).not.toContain( 'srv.probe' );
	} );

	it( 'does NOT re-check permission when it compiles — it compiles what it was bound', () => {
		// The seam that makes deny-is-absence structural rather than repeated. Main narrows the defs to what
		// the run may call and binds THAT, so the compiler's only remaining question is how much rides. A
		// manifest that filtered by permission a second time would be a second resolver of the question the
		// passport answered, and the two would eventually disagree in the permissive direction.
		const agent = agentWith( { 'srv.probe': 'preload' } );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.probe' ] );
	} );

	it( 'DROPS an `off` rather than carrying it — nothing unheld survives assembly', () => {
		// The guarantee every downstream reader depends on. `off` is never stored, but a map written by an
		// older build can still hold one, and it must not read as carried. A tool that is not carried is
		// absent from the assembled map, so the mint, the manifest and the preload all work from a list that
		// cannot express a denial — and none of them can be the one that forgets to check for one.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'off' } );
		expect( agent.carriedTools() ).toEqual( { 'srv.probe': 'on' } );
		expect( agent.toolModeFor( 'srv.commit' ) ).toBe( 'off' );
	} );

	it( 'answers `off` for a tool it has never heard of', () => {
		expect( agentWith( {} ).toolModeFor( 'srv.probe' ) ).toBe( 'off' );
	} );

	it( 'names BOTH tools in the manifest and marks only the deferred one', () => {
		// Both tools are equally carried; what differs is what each spends.
		//
		// THIS PINNED THE OPPOSITE UNTIL 2026-09-05, and the inversion is the fix rather than a loosened
		// assertion. It asserted the manifest did NOT name a preloaded tool — and that omission was the
		// defect: the wire carries name, description and schema with no SERVER, so a preloaded tool named
		// nowhere else reached the model as a bare verb it could not place. An agent holding `learn` and
		// `recall` reported having no memory tool, correctly, because nothing in its context said Memory.
		//
		// So the manifest names everything and the MARK carries the mode. What the mode decides is what a
		// tool COSTS, never whether it is identifiable.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'preload' } );
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

	it( 'names the search tool in the manifest note once the host binds one, and no mechanism before', () => {
		// bug-report-9. The note used to say only "ask for its schema" — the tool that fetches one describes
		// itself on the wire, and a name spelled here would be a second copy. A local model told the mechanism
		// only inside a tool result kept calling the one tool it had fetched. So the host BINDS the name and
		// the note says which tool to call, that a server's name fetches all of that server's tools, and that
		// a tool already fetched is no stand-in for one that is not.
		const agent = agentWith( { 'srv.probe': 'on' } );
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
		const agent = agentWith( { 'srv.probe': 'preload', 'srv.commit': 'preload' } );
		agent.bindEnv( { searchTool: 'tool_search' } );
		expect( agent.toolManifest() ).not.toContain( 'tool_search' );
		expect( agent.toolManifest() ).not.toContain( 'Everything you hold' );
	} );

	it( 'marks what the RUN defers once a host binds it, whatever the mode says', () => {
		// The mode is the prototype's answer, and the request can disagree with it: a host puts a tool on the
		// wire for reasons no mode records, a person's grant among them. A mark read off the mode told the
		// model such a tool was not callable yet and to fetch it through a search tool the request did not
		// carry. So a bound deferred set is the whole answer — in BOTH directions, because a mode outranking
		// it either way is a prompt and a request disagreeing.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'preload' } );
		agent.bindEnv( { searchTool: 'tool_search', runDeferred: [] } );
		const quiet = agent.toolManifest();
		expect( quiet.split( '\n' ).find( l => l.startsWith( '- probe' ) ) ).not.toContain( '[schema on request]' );
		// Nothing deferred, so nothing to fetch and no mechanism named — the request carries no search tool.
		expect( quiet ).not.toContain( 'Everything you hold' );

		agent.bindEnv( { runDeferred: [ 'srv.commit' ] } );
		const lines = agent.toolManifest().split( '\n' );
		expect( lines.find( l => l.startsWith( '- commit' ) ) ).toContain( '[schema on request]' );
		expect( lines.find( l => l.startsWith( '- probe' ) ) ).not.toContain( '[schema on request]' );
	} );

	it( 'falls back to the mode where there is no run to ask', () => {
		// A composition surface — an agent card, a preview — has no request to subtract from. The agent's own
		// mode is the best answer there, and it is what every case above this one already reads.
		const agent = agentWith( { 'srv.probe': 'on' } );
		expect( agent.runDeferred ).toBeNull();
		expect( agent.toolManifest().split( '\n' ).find( l => l.startsWith( '- probe' ) ) ).toContain( '[schema on request]' );
	} );

	it( 'does not hold a def that never crossed the serve seam', () => {
		// A double has no identity to be filed under, and admitting it BECAUSE it lacks the field everything
		// else is keyed by would make missing metadata a way in. This inverts the old fallback deliberately.
		const doubles: ToolDef[] = [ { name: 'probe', description: 'Look at a thing.', inputSchema: { type: 'object' } } ];
		expect( agentWith( { probe: 'on' }, doubles ).toolManifest() ).toBe( '' );
	} );
} );

/**
 * A LENS CONTRIBUTES NO TOOLS ( plan agents-own-behaviour ) — read off the real lens rather than a fixture,
 * because the vault is the contract. An agent's tools live on its record; a lens that once carried a Tools
 * table carries none, and there is no longer any code path by which one could reach an agent.
 */
describe( 'a lens contributes no tools', () => {
	const PROJECT_ROOT = path.resolve( __dirname, '../../../..' );   // kcd_sdk/src/agent/__tests__ → repo root
	const LENS_PATH    = path.join( PROJECT_ROOT, '_Claude/lenses/sm-documentation/sm-documentation.html' );

	it( 'composes nothing onto the agent from a real lens it wears', () => {
		const lens  = LensObject.load( LENS_PATH, { projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ) } );
		const agent = Agent.create( { lenses: [ lens ] } );
		expect( agent.carriedTools() ).toEqual( {} );
		expect( lens.getToolModes() ).toEqual( {} );
		expect( KcdEdit.setTool( lens.serialize().body, 'sm_documentation.get_doc', 'off' ) ).toBeNull();
	} );
} );
