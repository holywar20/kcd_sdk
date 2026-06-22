import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Statuses that mark a plan as still live — these also require a Phases section.
 *  A completed/retired plan is a record, so it needs only its Goal. (L2) */
const LIVE_STATUSES = ['draft', 'active', 'paused'];

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
		obj.hydrateFrom( json );
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

	/**
	 * Goal is always required; Phases is required only while the plan is live (L2). `Approach`
	 * is recommended but no longer enforced — a plan can describe its work without a fixed
	 * approach section. The base loop reads this list.
	 */
	protected requiredSections(): string[] {
		const live = LIVE_STATUSES.includes( String( this.frontmatter['status'] ?? '' ) );
		return live ? ['Goal', 'Phases'] : ['Goal'];
	}

	// getRole: inherits 'know' from KCDPrimitive — plans are informational, not procedural.
}

KCDPrimitive.register( 'plan', ( markdown, absPath ) => PlanObject.parse( markdown, absPath ) );
