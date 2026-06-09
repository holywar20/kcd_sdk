import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Sections required on every pipeline. Edit this list to add or remove enforcement. */
const REQUIRED_SECTIONS = ['Stages'] as const;

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
		obj.frontmatter = { ...json.frontmatter };
		obj.sections   = { ...json.sections };
		obj.body       = json.body;
		obj.links      = [ ...json.links ];
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

	protected validateStructure(): void {
		for ( const section of REQUIRED_SECTIONS ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`PipelineObject: required section "${section}" is missing`,
					this.path,
					`## ${section} section`,
					null,
					{ section }
				);
			}
		}
	}
}

KCDPrimitive.register( 'pipeline', ( markdown, absPath ) => PipelineObject.parse( markdown, absPath ) );
