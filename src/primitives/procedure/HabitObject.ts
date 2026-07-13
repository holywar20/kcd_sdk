import { KCDPrimitive } from '../framework/KCDPrimitive';
import { KcdContext } from '../../core/html/KcdContext';
import type { SerializedArtifact } from '../types';

/**
 * A habit is a leaf node: atomic behavior, no dredge policy. Habits are intentionally
 * minimal — the body is the whole contract. Conformance ( type, structure ) is enforced
 * at parse time by KcdValidate; this class only carries the role.
 */
export class HabitObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'habit' );
	}

	static fromSerialized( json: SerializedArtifact ): HabitObject {
		const obj = new HabitObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }

	/** This habit's own `why` section — the SAME trigger prose the dense `suggested` form folds
	 *  into line one, read standalone so a lens's Why cell can default to it ( `mode:habit` ) without
	 *  fetching the full body into context. A cheap parse of a section already in memory ( this habit
	 *  was fetched to learn its `habit-class` regardless of mode ) — not a second dredge. */
	getWhy(): string {
		return KcdContext.habitSections( this.body )[ 'why' ]?.text ?? '';
	}
}
