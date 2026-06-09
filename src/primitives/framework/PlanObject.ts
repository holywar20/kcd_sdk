import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Sections required on every plan. Edit this list to add or remove enforcement. */
const REQUIRED_SECTIONS = ['Goal', 'Approach', 'Phases'] as const;

/**
 * A plan is a Know artifact: a digest of ongoing work, status, and intent.
 * Plans are loaded for context, not execution — they inform rather than direct.
 */
export class PlanObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'plan' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): PlanObject {
		const obj = new PlanObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): PlanObject {
		const obj = new PlanObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): PlanObject {
		const obj = new PlanObject( json.path );
		obj.frontmatter = { ...json.frontmatter };
		obj.sections   = { ...json.sections };
		obj.body       = json.body;
		obj.links      = [ ...json.links ];
		return obj;
	}

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'plan' ) {
			throw new KCDValidationError(
				`PlanObject: frontmatter.type must be "plan"`,
				this.path, '"plan"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	protected validateStructure(): void {
		for ( const section of REQUIRED_SECTIONS ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`PlanObject: required section "${section}" is missing`,
					this.path, `## ${section} section`, null,
					{ section }
				);
			}
		}
	}

	// getRole: inherits 'know' from KCDPrimitive — plans are informational, not procedural.
}

KCDPrimitive.register( 'plan', ( markdown, absPath ) => PlanObject.parse( markdown, absPath ) );
