import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * An analyzer: a judgment pass that reads broadly and writes a report. Declares its execution
 * procedure; structure is enforced at parse time by KcdValidate.
 */
export class AnalyzerObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'analyzer' );
	}

	static fromSerialized( json: SerializedArtifact ): AnalyzerObject {
		const obj = new AnalyzerObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }
}
