import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A plan is a Know artifact: a digest of ongoing work, status, and intent.
 * Plans are loaded for context, not execution — they inform rather than direct.
 * Structure ( Goal / Phases, gated by live status ) is enforced at parse time by KcdValidate.
 */
export class PlanObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'plan' );
	}

	static fromSerialized( json: SerializedArtifact ): PlanObject {
		const obj = new PlanObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// getRole: inherits 'know' from KCDPrimitive — plans are informational, not procedural.
}
