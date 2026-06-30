import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A contract: behavioral agreement between a lens and an agent. Declares its trigger
 * condition; structure is enforced at parse time by KcdValidate.
 */
export class ContractObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'contract' );
	}

	static fromSerialized( json: SerializedArtifact ): ContractObject {
		const obj = new ContractObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }
}
