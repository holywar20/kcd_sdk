import type { ScannedFile } from '../../scanner';
import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A template: a scaffold for authoring a specific KCD artifact type.
 * No required sections — templates vary by the artifact type they scaffold.
 * Type frontmatter check is skipped; templates are identified by directory
 * convention (`kcd/templates/`) and may carry various `type:` values.
 */
export class TemplateObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'template' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): TemplateObject {
		const obj = new TemplateObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): TemplateObject {
		const obj = new TemplateObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): TemplateObject {
		const obj = new TemplateObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// validateFrontmatter: lenient — no type check; directory convention is authoritative.
	// validateStructure: no required sections — structure varies by scaffolded type.
}

KCDPrimitive.register( 'template', ( markdown, absPath ) => TemplateObject.parse( markdown, absPath ) );
