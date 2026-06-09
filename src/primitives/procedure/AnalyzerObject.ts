import type { ScannedFile } from '../../scanner';
import { KCDValidationError } from '../errors';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** Sections required on every analyzer. Edit this list to add or remove enforcement. */
const REQUIRED_SECTIONS = ['Do'] as const;

/**
 * An analyzer: a judgment pass that reads broadly and writes a report.
 * Must declare `## Do` — the execution procedure.
 */
export class AnalyzerObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'analyzer' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): AnalyzerObject {
		const obj = new AnalyzerObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): AnalyzerObject {
		const obj = new AnalyzerObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): AnalyzerObject {
		const obj = new AnalyzerObject( json.path );
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

		if ( this.frontmatter['type'] !== 'analyzer' ) {
			throw new KCDValidationError(
				`AnalyzerObject: frontmatter.type must be "analyzer"`,
				this.path,
				'"analyzer"',
				String( this.frontmatter['type'] ?? null ),
				{ field: 'type' }
			);
		}
	}

	protected validateStructure(): void {
		for ( const section of REQUIRED_SECTIONS ) {
			if ( !this.sections[section] ) {
				throw new KCDValidationError(
					`AnalyzerObject: required section "${section}" is missing`,
					this.path,
					`## ${section} section`,
					null,
					{ section }
				);
			}
		}
	}
}

KCDPrimitive.register( 'analyzer', ( markdown, absPath ) => AnalyzerObject.parse( markdown, absPath ) );
