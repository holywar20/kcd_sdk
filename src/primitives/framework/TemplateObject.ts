import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A template: a scaffold for authoring a specific KCD artifact type.
 * No required sections — templates vary by the artifact type they scaffold. Identified by
 * directory convention ( `kcd/templates/` ); a template carries placeholder values so it is
 * exempt from the conformance the validator demands of real artifacts.
 */
export class TemplateObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'template' );
	}

	static fromSerialized( json: SerializedArtifact ): TemplateObject {
		const obj = new TemplateObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}
}
