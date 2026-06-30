import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A generator: a mechanical, manifest-driven builder procedure. Declares its execution
 * procedure; structure is enforced at parse time by KcdValidate.
 */
export class GeneratorObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'generator' );
	}

	static fromSerialized( json: SerializedArtifact ): GeneratorObject {
		const obj = new GeneratorObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }
}
