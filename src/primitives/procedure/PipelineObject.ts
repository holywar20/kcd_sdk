import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A pipeline: an ordered sequence of stages that chains generators or analyzers.
 * Must declare `## Stages` — the ordered stage list.
 */
export class PipelineObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'pipeline' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): PipelineObject {
		const obj = new PipelineObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): PipelineObject {
		const obj = new PipelineObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): PipelineObject {
		const obj = new PipelineObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'pipeline' ) {
			throw new KCDValidationError(
				`PipelineObject: frontmatter.type must be "pipeline"`,
				this.path,
				'"pipeline"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	protected requiredSections(): string[] { return ['Stages']; }
}

KCDPrimitive.register( 'pipeline', ( markdown, absPath ) => PipelineObject.parse( markdown, absPath ) );
