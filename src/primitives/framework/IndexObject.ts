import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A nav-index: a navigational table that maps a folder of artifacts to their entries.
 * Organisational metadata, not procedural — loaded for orientation like a reference,
 * but typed distinctly so the parser, MCP, and UI can treat nav-indexes as first-class.
 * ( The class name is historical; the document type is `nav-index`. )
 */
export class IndexObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'nav-index' );
	}

	static fromSerialized( json: SerializedArtifact ): IndexObject {
		const obj = new IndexObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// getRole: inherits 'know' from KCDPrimitive — nav-indexes are navigational, not procedural.
}
