import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Sections required on every contract. Edit this list to add or remove enforcement. */
const REQUIRED_SECTIONS = ['When'] as const;

/**
 * A contract: behavioral agreement between a lens and an agent.
 * Must declare `## When` — the trigger condition that activates the contract.
 */
export class ContractObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'contract' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): ContractObject {
		const obj = new ContractObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): ContractObject {
		const obj = new ContractObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): ContractObject {
		const obj = new ContractObject( json.path );
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

		if ( this.frontmatter['type'] !== 'contract' ) {
			throw new KCDValidationError(
				`ContractObject: frontmatter.type must be "contract"`,
				this.path,
				'"contract"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	protected validateStructure(): void {
		for ( const section of REQUIRED_SECTIONS ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`ContractObject: required section "${section}" is missing`,
					this.path,
					`## ${section} section`,
					null,
					{ section }
				);
			}
		}
	}
}

KCDPrimitive.register( 'contract', ( markdown, absPath ) => ContractObject.parse( markdown, absPath ) );
