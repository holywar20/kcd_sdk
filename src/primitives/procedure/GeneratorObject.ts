import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A generator: a mechanical, manifest-driven builder procedure.
 * Must declare `## Do` — the step-by-step execution procedure.
 */
export class GeneratorObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'generator' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): GeneratorObject {
		const obj = new GeneratorObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): GeneratorObject {
		const obj = new GeneratorObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): GeneratorObject {
		const obj = new GeneratorObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'generator' ) {
			throw new KCDValidationError(
				`GeneratorObject: frontmatter.type must be "generator"`,
				this.path,
				'"generator"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	protected requiredSections(): string[] { return ['Do']; }
}

KCDPrimitive.register( 'generator', ( markdown, absPath ) => GeneratorObject.parse( markdown, absPath ) );
