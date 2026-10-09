/**
 * SlotResolver — the habit-class cascade over a merged `TaggedBlock[]`: exactly one member of a class
 * applies — the most specific source layer wins and losers are dropped, not merged. Classless blocks
 * never enter it; `ContextAssembler` alone governs them.
 * `compilePlan()` is shared by `describe()` and `compile()` so they cannot drift. It is internal in
 * intent but never `private`: TS4094 breaks declaration emit on this anonymous-class singleton.
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

export interface SlotResolution {
	habitClass: string;
	winner: SlotCandidate;
	candidates: SlotCandidate[];
}

/** The shared plan both public methods read — never recomputed differently between them. */
export interface SlotPlan {
	slots: SlotResolution[];
	/** Classless blocks plus each slot's WINNING block, in ORIGINAL load order; a losing block is simply absent.
	 *  Feed straight to `ContextAssembler`. */
	survivors: TaggedBlock[];
}

export const SlotResolver = new class SlotResolver {

	/** Specificity ranking — lower wins a class: `injected`, then `agent` ( its own base-habit choice ), then `lens`.
	 *  Every ranking decision reads through `rank()`, so a new layer is a one-line edit. */
	RANK: Record<SourceLayer, number> = { injected: 0, agent: 1, lens: 2 };
	rank( layer: SourceLayer ): number { return this.RANK[ layer ]; }

	/** THE shared computation. The candidate unit is one ARTIFACT (grouped by `path`), not one block:
	 *  a classed habit's blocks stand or fall together. Same-rank ties go to the first-encountered artifact. */
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
	 *  survivors assembled by `ContextAssembler`. */
	compile( blocks: TaggedBlock[], sep = '\n\n---\n\n' ): string {
		return ContextAssembler.assemble( this.compilePlan( blocks ).survivors, sep );
	}
}();
