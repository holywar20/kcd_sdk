import { describe, it, expect } from 'vitest';
import { Agent } from '../Agent';
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

	it( 'keeps ASK in the allowances — a prompt is not an absence', () => {
		const agent = agentWith( { 'srv.probe': 'ask' } );
		expect( agent.toolAllowances() ).toEqual( { 'srv.probe': 'ask' } );
	} );

	it( 'defaults the COST axis to manifest, the cheap answer', () => {
		expect( agentWith( { 'srv.probe': 'allow' } ).toolSurfaceFor( 'srv.probe' ) ).toBe( 'manifest' );
	} );

	it( 'splits the manifest from the preloaded surface on COST alone', () => {
		// Both tools are equally permitted; what differs is what each spends. Under the diagonal this pair
		// of states was unreachable — there was no way to say "allowed, but do not spend a schema on it"
		// while another tool rode in whole.
		const agent = agentWith(
			{ 'srv.probe': 'allow', 'srv.commit': 'allow' },
			{ 'srv.commit': 'preload' }
		);
		expect( agent.toolManifest() ).toContain( 'probe' );
		expect( agent.toolManifest() ).not.toContain( 'commit' );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.commit' ] );
	} );

	it( 'costs a tool INDEPENDENTLY of how tightly it is governed', () => {
		// The two axes are not one diagonal. An agent that made a tool ask first has said nothing about
		// whether its schema rides the prompt, and a reader that inferred one from the other would put the
		// expensive answer behind a security decision.
		const agent = agentWith( { 'srv.commit': 'ask' }, { 'srv.commit': 'preload' } );
		expect( agent.preloadedToolIds() ).toEqual( [ 'srv.commit' ] );
	} );

	it( 'does not hold a def that never crossed the serve seam', () => {
		// A double has no identity to be filed under, and admitting it BECAUSE it lacks the field everything
		// else is keyed by would make missing metadata a way in. This inverts the old fallback deliberately.
		const doubles: ToolDef[] = [ { name: 'probe', description: 'Look at a thing.', inputSchema: { type: 'object' } } ];
		expect( agentWith( { probe: 'allow' }, {}, doubles ).toolManifest() ).toBe( '' );
	} );
} );
