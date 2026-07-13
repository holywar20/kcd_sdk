import { KCDPrimitive } from './KCDPrimitive';
import { KcdContext } from '../../core/html/KcdContext';
import type { SerializedArtifact } from '../types';

/**
 * A reference document: free-form prose, no required section structure.
 * References are loaded on demand by agents that need the content they describe.
 */
export class ReferenceObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'reference' );
	}

	static fromSerialized( json: SerializedArtifact ): ReferenceObject {
		const obj = new ReferenceObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	/** This reference's own `why` section, if it has one — the SAME "default inclusion reason, defer
	 *  unless overridden" pattern habits got ( `HabitObject.getWhy`, 2026-07-13 ), extended to references
	 *  per Bryan: "this is actually a pattern we will be using on the references later." OPTIONAL, unlike
	 *  a habit's ( references stay free-form, no required structure ) — `LensObject.resolveWhy()` is
	 *  already duck-typed on `getWhy`, so an empty string here just falls through to its existing
	 *  fallback ( the lens's own hand-written Why cell, or nothing ) with zero regression for a reference
	 *  that hasn't been migrated to carry one yet. */
	getWhy(): string {
		return KcdContext.habitSections( this.body )[ 'why' ]?.text ?? '';
	}
}
