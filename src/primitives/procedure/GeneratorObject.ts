import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Sections required on every generator. Edit this list to add or remove enforcement. */
const REQUIRED_SECTIONS = ['Do'] as const;

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

	protected validateStructure(): void {
		for ( const section of REQUIRED_SECTIONS ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`GeneratorObject: required section "${section}" is missing`,
					this.path,
					`## ${section} section`,
					null,
					{ section }
				);
			}
		}
	}
}

KCDPrimitive.register( 'generator', ( markdown, absPath ) => GeneratorObject.parse( markdown, absPath ) );
