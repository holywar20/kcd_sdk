import { KCDPrimitive } from './KCDPrimitive';
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
}
