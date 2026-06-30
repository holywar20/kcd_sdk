import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A pipeline: an ordered sequence of stages that chains generators or analyzers.
 * ( The vocab alignment retired `pipeline` from the HTML type set; the class is kept until the
 * type union is reconciled — see the html-substrate plan. ) Structure is a parse-time concern.
 */
export class PipelineObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'pipeline' );
	}

	static fromSerialized( json: SerializedArtifact ): PipelineObject {
		const obj = new PipelineObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }
}
