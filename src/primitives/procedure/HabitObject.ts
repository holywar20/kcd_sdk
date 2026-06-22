import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A habit is a leaf node: atomic behavior, no required sections, no dredge policy.
 * Habits are intentionally minimal — the body is the whole contract.
 */
export class HabitObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'habit' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): HabitObject {
		const obj = new HabitObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): HabitObject {
		const obj = new HabitObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): HabitObject {
		const obj = new HabitObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// ── Validation hooks ─────────────────────────────────────────────────────

	protected validateFrontmatter(): void {
		super.validateFrontmatter();

		if ( this.frontmatter['type'] !== 'habit' ) {
			throw new KCDValidationError(
				`HabitObject: frontmatter.type must be "habit"`,
				this.path,
				'"habit"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	getRole() { return 'do' as const; }

	// validateStructure: no required sections — habits are leaf nodes.
	// getPolicy: inherits base [] — habits never dredge.
}

KCDPrimitive.register( 'habit', ( markdown, absPath ) => HabitObject.parse( markdown, absPath ) );
