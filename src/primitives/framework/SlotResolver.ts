/**
 * SlotResolver — the habit-class mutual-exclusion cascade over a merged `TaggedBlock[]`
 * ( context-optimization plan, Phase 3, protocol §6 ). A `habit-class` is a named group where
 * exactly one member may apply ( "textual radio buttons" — `log-session` = { session-log-
 * aggressive, log-session-never } ). Classless blocks are additive and never enter this cascade —
 * `ContextAssembler` alone governs them. Classed blocks compete: for each class, the most specific
 * source layer that contributes a member WINS; every other member of that class is dropped
 * (not merged, not stacked — genuinely absent from the compiled corpus), and the winner renders at
 * its own natural position (no repositioning needed for a per-position filter).
 *
 * ONE core computation, THREE-callable idiom: `compilePlan()` is the shared plan every public
 * method reads — computed once so the visualization and the compiled text can never drift against
 * each other. The same guarantee `Agent.compiledContext()` leans on: one list, projected to the wire
 * and to the per-source breakdown, rather than two derivations kept in step by hand.
 *   - `describe()` — the plan's `slots`, unreduced: every class, every candidate, who won and why.
 *     View-template-ready data for a Slot UI (Phase 5) to visualize the relationships — nothing here
 *     needs to render prose, just labels and a boolean.
 *   - `compile()` — the plan's survivors run through `ContextAssembler.assemble()`: the actual text
 *     corpus an orchestrator sends, losers already dropped.
 * `compilePlan()` itself is PRIVATE in intent, not in the TS keyword — `KcdContext` and
 * `ContextAssembler` establish the same precedent: TS forbids `private` members on an exported
 * anonymous-class singleton's declaration emit (`tsc`'s `declaration: true` errors with TS4094), so
 * this file never uses the keyword either. Treat it as "internal — call `describe()`/`compile()`."
 */

import type { TaggedBlock, SourceLayer, ArtifactType } from '../types';
import { ContextAssembler } from './ContextAssembler';

/** One contender for a habit-class slot — a UI-ready summary, not the block's full text. */
export interface SlotCandidate {
	path: string;
	artifactType: ArtifactType;
	sourceLayer: SourceLayer;
	won: boolean;
}

/** One habit-class's resolution: every candidate that declared this class, and which one won. */
export interface SlotResolution {
	habitClass: string;
	winner: SlotCandidate;
	candidates: SlotCandidate[];
}

/** The shared plan both public methods read — never recomputed differently between them. */
export interface SlotPlan {
	slots: SlotResolution[];
	/** Classless blocks, plus each slot's WINNING block, filtered from the input in ORIGINAL load
	 *  order (a losing block is simply absent — its winning rival already occupies that slot's one
	 *  natural position elsewhere in the list). Feed straight to `ContextAssembler`. */
	survivors: TaggedBlock[];
}

export const SlotResolver = new class SlotResolver {

	/** Specificity ranking — lower wins a class. `injected` ( session-dropped ) is most specific, then
	 *  `agent` ( a component the agent bolts on itself — its own base-habit choice ), then `lens` ( what
	 *  a lens contributes ). So an agent's habit supersedes the lens's in a contended slot: the
	 *  composability of behaviour. The plan's Constellation layer ( between injected and agent ) stays
	 *  unrealized — no distinct tag exists yet. Every ranking decision reads through `rank()`, so adding
	 *  it later is a one-line edit, not a redesign. */
	RANK: Record<SourceLayer, number> = { injected: 0, agent: 1, lens: 2 };
	rank( layer: SourceLayer ): number { return this.RANK[ layer ]; }

	/**
	 * THE shared computation. The CANDIDATE unit is one ARTIFACT ( grouped by `path` ), not one
	 * block — a classed habit routinely emits several blocks ( its head, its `when`, its `action`,
	 * … ), and those must all stand or fall together, never compete against EACH OTHER as if they
	 * were rival occupants of the same slot. For each `habitClass`, groups its blocks by `path`
	 * first, picks the winning artifact ( lowest-rank source layer; the first-encountered artifact
	 * breaks a same-rank tie ), then filters the ORIGINAL block list down to classless blocks plus
	 * EVERY block belonging to each class's one winning artifact, preserving load order throughout.
	 */
	compilePlan( blocks: TaggedBlock[] ): SlotPlan {
		const byClass = new Map<string, Map<string, TaggedBlock[]>>();   // habitClass -> path -> its blocks
		for ( const b of blocks ) {
			if ( !b.habitClass ) continue;
			if ( !byClass.has( b.habitClass ) ) byClass.set( b.habitClass, new Map() );
			const byPath = byClass.get( b.habitClass )!;
			if ( !byPath.has( b.path ) ) byPath.set( b.path, [] );
			byPath.get( b.path )!.push( b );
		}

		const winningPathOf = new Map<string, string>();   // habitClass -> the winning artifact's path
		const slots: SlotResolution[] = [];
		for ( const [ habitClass, byPath ] of byClass ) {
			// One representative block per candidate artifact — enough to rank/describe it by.
			const candidates = [ ...byPath.values() ].map( bs => bs[ 0 ] );
			const winner = candidates.reduce( ( best, m ) => this.rank( m.sourceLayer ) < this.rank( best.sourceLayer ) ? m : best );
			winningPathOf.set( habitClass, winner.path );
			slots.push( {
				habitClass,
				winner: this.toCandidate( winner, true ),
				candidates: candidates.map( m => this.toCandidate( m, m.path === winner.path ) )
			} );
		}

		const survivors = blocks.filter( b => !b.habitClass || winningPathOf.get( b.habitClass ) === b.path );
		return { slots, survivors };
	}

	toCandidate( b: TaggedBlock, won: boolean ): SlotCandidate {
		return { path: b.path, artifactType: b.artifactType, sourceLayer: b.sourceLayer, won };
	}

	/** The visualization view — every slot's candidates and winner. A thin read of `compilePlan()`;
	 *  never a separately-derived computation. */
	describe( blocks: TaggedBlock[] ): SlotResolution[] {
		return this.compilePlan( blocks ).slots;
	}

	/** The actual compilation an orchestrator consumes: losing habit-class members dropped, the
	 *  survivors merged (`data-kcd-merge-key`) and sorted (Care-first, injected-last) by
	 *  `ContextAssembler`. */
	compile( blocks: TaggedBlock[], sep = '\n\n---\n\n' ): string {
		return ContextAssembler.assemble( this.compilePlan( blocks ).survivors, sep );
	}
}();
