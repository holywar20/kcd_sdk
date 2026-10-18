import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import '../../primitives/index';   // registers the hydrators, so a load yields a real LensObject
import { Agent } from '../Agent';
import { LensObject } from '../../primitives/framework/LensObject';
import { KcdEdit } from '../../core/html/KcdEdit';
import type { ToolDef } from '../ToolDef';

/**
 * THE ONE AXIS A TOOL IS HELD ON — does this agent carry it, and how much of it rides. An agent has no
 * allowance to give: it is a PROTOTYPE, so allow / ask / deny belong to the passport and the project. What is
 * left is `off` / `on` / `preload`, and presence IS the answer: `off` is never stored, and a tool absent from
 * the map is one the agent does not carry. Identity rides on the def (`ToolDef.id`), stamped app-side, because
 * this package cannot import the app's tool vocabulary.
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
		// A bare key must stay unmatched: letting it resolve again would make two formats both work.
		// It is kept verbatim; it simply matches no served def.
		const agent = agentWith( { probe: 'on' } );
		expect( agent.carriedTools() ).toEqual( { probe: 'on' } );
		expect( Object.keys( agent.carriedTools() ) ).not.toContain( 'srv.probe' );
	} );

	it( 'does NOT re-check permission when it compiles — it compiles what it was bound', () => {
		// Main narrows the defs to what the run may call and binds that. A second permission check here would be
		// a second resolver that eventually disagrees with the passport, in the permissive direction.
		const agent = agentWith( { 'srv.probe': 'preload' } );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.probe' ] );
	} );

	it( 'DROPS an `off` rather than carrying it — nothing unheld survives assembly', () => {
		// `off` is never stored, but an older build's map can still hold one, and it must not read as carried.
		// Every downstream reader works from a list that cannot express a denial, so none can forget to check.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'off' } );
		expect( agent.carriedTools() ).toEqual( { 'srv.probe': 'on' } );
		expect( agent.toolModeFor( 'srv.commit' ) ).toBe( 'off' );
	} );

	it( 'answers `off` for a tool it has never heard of', () => {
		expect( agentWith( {} ).toolModeFor( 'srv.probe' ) ).toBe( 'off' );
	} );

	it( 'names BOTH tools in the manifest and marks only the deferred one', () => {
		// The manifest names every carried tool, and the mark carries the mode: what a mode decides is what a tool
		// COSTS, never whether it is identifiable.
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
		// The host binds the search tool's name; the note says which tool to call, because a model told the
		// mechanism only inside a tool result kept calling the one tool it had fetched.
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
		// The request decides what is deferred, not the mode: a mark read off the mode would disagree with what the
		// request carries, in either direction.
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

	/** A managed lane: the host owns the callable set, so neither our cut nor our door applies. Absence from the list is the only denial; a refusal on a listed row is a loading state. */
	it( 'marks NOTHING and names no door when the host manages loading', () => {
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'on' } );
		agent.bindEnv( { hostManagedTools: true } );
		const manifest = agent.toolManifest();

		// Both rows are present and NEITHER is marked — we do not know what the host loaded, and saying so
		// would be inventing the fact this flag exists to admit we lack.
		expect( manifest ).toContain( '- probe' );
		expect( manifest ).toContain( '- commit' );
		expect( manifest ).not.toContain( '[schema on request]' );
		// And no door of ours is named, because on this lane there is none to name.
		expect( manifest ).not.toContain( 'tool_search' );
	} );

	it( 'tells a managed lane that an unavailable LISTED tool is a loading state, not a denial', () => {
		// The sentence the defect cost. An agent read the host's refusal as a withheld capability, reported a
		// gap that did not exist, and took a worse repair confidently — so the note has to say all three
		// states and forbid both wrong moves by name.
		const agent = agentWith( { 'srv.probe': 'on' } );
		agent.bindEnv( { hostManagedTools: true } );
		const note = agent.toolManifest().split( '\n' ).find( l => l.startsWith( 'Everything you hold' ) );

		expect( note ).toBeDefined();
		expect( note ).toContain( 'LOADING STATE, NOT A DENIAL' );
		expect( note ).toContain( 'absent from this list entirely' );
		expect( note ).toContain( 'Do not conclude you lack it' );
		expect( note ).toContain( 'do not reach the same end another way' );
	} );

	it( 'keeps the managed note even when the host has bound a search tool and a deferred set', () => {
		// Unconditional on this lane: the host may load everything this turn and defer something next, so a note
		// waiting for evidence would lag. A stale `searchTool` must not win back a door this lane does not have.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'on' } );
		agent.bindEnv( { hostManagedTools: true, searchTool: 'tool_search', runDeferred: [ 'srv.commit' ] } );
		const manifest = agent.toolManifest();

		expect( manifest ).toContain( 'LOADING STATE, NOT A DENIAL' );
		expect( manifest ).not.toContain( '[schema on request]' );
		expect( manifest ).not.toContain( 'tool_search' );
	} );

	it( 'leaves the WIRE lane exactly as it was — the flag is absent, not false-by-accident', () => {
		// The regression guard. Everything above is additive and the ordinary lane must not have moved: a
		// deferred row is still marked and the door is still named.
		const agent = agentWith( { 'srv.probe': 'on', 'srv.commit': 'preload' } );
		agent.bindEnv( { searchTool: 'tool_search', runDeferred: [ 'srv.probe' ] } );
		const lines = agent.toolManifest().split( '\n' );

		expect( lines.find( l => l.startsWith( '- probe' ) ) ).toContain( '[schema on request]' );
		expect( agent.toolManifest() ).toContain( 'call tool_search with its exact name' );
		expect( agent.hostManagedTools ).toBe( false );
	} );

	it( 'falls back to the mode where there is no run to ask', () => {
		// A composition surface — an agent card, a preview — has no request to subtract from. The agent's own
		// mode is the best answer there, and it is what every case above this one already reads.
		const agent = agentWith( { 'srv.probe': 'on' } );
		expect( agent.runDeferred ).toBeNull();
		expect( agent.toolManifest().split( '\n' ).find( l => l.startsWith( '- probe' ) ) ).toContain( '[schema on request]' );
	} );

	it( 'does not hold a def that never crossed the serve seam', () => {
		// A double has no identity to file under, and admitting it for lacking the field would make missing metadata a way in.
		const doubles: ToolDef[] = [ { name: 'probe', description: 'Look at a thing.', inputSchema: { type: 'object' } } ];
		expect( agentWith( { probe: 'on' }, doubles ).toolManifest() ).toBe( '' );
	} );
} );

/**
 * A lens contributes no tools: an agent's tools live on its record. Read off the real lens, because the vault is the contract.
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
