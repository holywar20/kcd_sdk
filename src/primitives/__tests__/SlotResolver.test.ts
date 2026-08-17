import { describe, it, expect } from 'vitest';
import { SlotResolver } from '../framework/SlotResolver';
import type { TaggedBlock } from '../types';

const block = ( over: Partial<TaggedBlock> ): TaggedBlock => ( {
	region: 'do', section: null, mergeKey: null, text: 'x', sourceLayer: 'lens', path: 'p',
	artifactType: 'habit', habitClass: null, ...over
} );

describe( 'SlotResolver.compilePlan — the shared core', () => {
	it( 'classless blocks never enter a slot and always survive', () => {
		const b = block( { text: 'classless', habitClass: null } );
		const plan = SlotResolver.compilePlan( [ b ] );
		expect( plan.slots ).toHaveLength( 0 );
		expect( plan.survivors ).toEqual( [ b ] );
	} );

	it( 'the more specific source layer (injected) wins over a lens-carried member of the same class', () => {
		const lensMember     = block( { path: 'lens-habit.html', sourceLayer: 'lens', habitClass: 'log-session', text: 'aggressive' } );
		const injectedMember = block( { path: 'injected-habit.html', sourceLayer: 'injected', habitClass: 'log-session', text: 'never' } );
		const plan = SlotResolver.compilePlan( [ lensMember, injectedMember ] );

		expect( plan.slots ).toHaveLength( 1 );
		expect( plan.slots[ 0 ].habitClass ).toBe( 'log-session' );
		expect( plan.slots[ 0 ].winner.path ).toBe( 'injected-habit.html' );
		expect( plan.slots[ 0 ].candidates ).toHaveLength( 2 );
		expect( plan.slots[ 0 ].candidates.find( c => c.path === 'lens-habit.html' )?.won ).toBe( false );
		expect( plan.slots[ 0 ].candidates.find( c => c.path === 'injected-habit.html' )?.won ).toBe( true );

		// The loser is genuinely absent — not merged, not stacked.
		expect( plan.survivors ).toHaveLength( 1 );
		expect( plan.survivors[ 0 ].path ).toBe( 'injected-habit.html' );
	} );

	it( 'the winner keeps its own original position in load order — a per-position filter, not a reposition', () => {
		const before = block( { path: 'before.html', habitClass: null, text: 'before' } );
		const loser  = block( { path: 'lens-habit.html', sourceLayer: 'lens', habitClass: 'log-session', text: 'aggressive' } );
		const winner = block( { path: 'injected-habit.html', sourceLayer: 'injected', habitClass: 'log-session', text: 'never' } );
		const after  = block( { path: 'after.html', habitClass: null, text: 'after' } );

		const plan = SlotResolver.compilePlan( [ before, loser, winner, after ] );
		expect( plan.survivors.map( b => b.path ) ).toEqual( [ 'before.html', 'injected-habit.html', 'after.html' ] );
	} );

	it( 'two independent habit-classes resolve independently', () => {
		const sessionWinner   = block( { path: 's.html', sourceLayer: 'injected', habitClass: 'log-session', text: 's' } );
		const completedWinner = block( { path: 'c.html', sourceLayer: 'lens', habitClass: 'log-completed', text: 'c' } );
		const plan = SlotResolver.compilePlan( [ sessionWinner, completedWinner ] );
		expect( plan.slots ).toHaveLength( 2 );
		expect( plan.survivors ).toHaveLength( 2 );
	} );

	it( 'a single-candidate class still resolves trivially — the lone candidate wins its own slot', () => {
		const lone = block( { path: 'spawn-subagent-never.html', sourceLayer: 'lens', habitClass: 'spawn-subagent', text: 'no subagents' } );
		const plan = SlotResolver.compilePlan( [ lone ] );
		expect( plan.slots ).toHaveLength( 1 );
		expect( plan.slots[ 0 ].winner.path ).toBe( 'spawn-subagent-never.html' );
		expect( plan.survivors ).toEqual( [ lone ] );
	} );

	it( 'regression: a classed artifact that emits SEVERAL blocks (head + multiple sections) never competes against itself — all its blocks survive together', () => {
		// One habit, same path, three blocks (its head, its "when", its "action") — exactly what
		// KCDPrimitive.getContextBlocks() actually produces for a multi-section habit.
		const head   = block( { path: 'habit.html', habitClass: 'log-session', text: 'head' } );
		const when   = block( { path: 'habit.html', habitClass: 'log-session', text: 'when' } );
		const action = block( { path: 'habit.html', habitClass: 'log-session', text: 'action' } );

		const plan = SlotResolver.compilePlan( [ head, when, action ] );
		expect( plan.slots ).toHaveLength( 1 );
		expect( plan.slots[ 0 ].candidates ).toHaveLength( 1 );   // ONE artifact, not three competing blocks
		expect( plan.survivors ).toEqual( [ head, when, action ] );   // every block survives, in order
	} );

	it( 'regression: when a multi-block artifact LOSES, every one of its blocks is dropped — not just its head', () => {
		const loserHead   = block( { path: 'loser.html', sourceLayer: 'lens', habitClass: 'log-session', text: 'loser head' } );
		const loserWhen   = block( { path: 'loser.html', sourceLayer: 'lens', habitClass: 'log-session', text: 'loser when' } );
		const winner      = block( { path: 'winner.html', sourceLayer: 'injected', habitClass: 'log-session', text: 'winner text' } );

		const plan = SlotResolver.compilePlan( [ loserHead, loserWhen, winner ] );
		expect( plan.survivors ).toEqual( [ winner ] );
	} );
} );

describe( 'SlotResolver.describe / compile — thin reads of the same plan', () => {
	const lensMember     = block( { path: 'lens-habit.html', sourceLayer: 'lens', habitClass: 'log-session', text: 'aggressive text' } );
	const injectedMember = block( { path: 'injected-habit.html', sourceLayer: 'injected', habitClass: 'log-session', text: 'never text' } );

	it( 'describe() returns the plan\'s slots, unreduced', () => {
		const slots = SlotResolver.describe( [ lensMember, injectedMember ] );
		expect( slots ).toEqual( SlotResolver.compilePlan( [ lensMember, injectedMember ] ).slots );
	} );

	it( 'compile() contains the winner\'s text and never the loser\'s', () => {
		const out = SlotResolver.compile( [ lensMember, injectedMember ] );
		expect( out ).toContain( 'never text' );
		expect( out ).not.toContain( 'aggressive text' );
	} );

	it( 'describe() and compile() never disagree on who won — same plan, two reads', () => {
		const slots = SlotResolver.describe( [ lensMember, injectedMember ] );
		const out   = SlotResolver.compile( [ lensMember, injectedMember ] );
		const winnerText = [ lensMember, injectedMember ].find( b => b.path === slots[ 0 ].winner.path )!.text;
		expect( out ).toContain( winnerText );
	} );
} );
