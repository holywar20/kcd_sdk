import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A framework document: conceptual foundation, conventions, and primitives for the KCD system.
 * No required sections — framework docs vary widely in structure. Identified by living under
 * `kcd/` (but not `kcd/templates/`); the directory convention is authoritative.
 */
export class FrameworkObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'framework' );
	}

	static fromSerialized( json: SerializedArtifact ): FrameworkObject {
		const obj = new FrameworkObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}
}
