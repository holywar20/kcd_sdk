import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * An index: a navigational table that maps a folder of artifacts to their entries.
 * Organisational metadata, not procedural — loaded for orientation like a reference,
 * but typed distinctly so the parser, MCP, and UI can treat indexes as first-class.
 * No required sections — an index is a table, not a structured document.
 */
export class IndexObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'index' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): IndexObject {
		const obj = new IndexObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): IndexObject {
		const obj = new IndexObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): IndexObject {
		const obj = new IndexObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'index' ) {
			throw new KCDValidationError(
				`IndexObject: frontmatter.type must be "index"`,
				this.path,
				'"index"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	// requiredSections: none — an index is a navigational table, inherits the empty default.
	// getRole: inherits 'know' from KCDPrimitive — indexes are navigational, not procedural.
}

KCDPrimitive.register( 'index', ( markdown, absPath ) => IndexObject.parse( markdown, absPath ) );
