import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
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

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): ReferenceObject {
		const obj = new ReferenceObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): ReferenceObject {
		const obj = new ReferenceObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): ReferenceObject {
		const obj = new ReferenceObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'reference' ) {
			throw new KCDValidationError(
				`ReferenceObject: frontmatter.type must be "reference"`,
				this.path,
				'"reference"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	// validateStructure: no required sections — references are free-form prose.
}

KCDPrimitive.register( 'reference', ( markdown, absPath ) => ReferenceObject.parse( markdown, absPath ) );
