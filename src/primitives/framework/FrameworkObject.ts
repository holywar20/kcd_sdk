import type { ScannedFile } from '../../scanner';
import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A framework document: conceptual foundation, conventions, and primitives for the KCD system.
 * No required sections — framework docs vary widely in structure.
 * Type frontmatter check is skipped; framework docs are identified by being under
 * `kcd/` (but not `kcd/templates/`) and may carry various `type:` values.
 */
export class FrameworkObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'framework' );
	}

	// ── Static entry points ──────────────────────────────────────────────────

	static parse( markdown: string, filePath: string ): FrameworkObject {
		const obj = new FrameworkObject( filePath );
		obj.runInit( markdown );
		return obj;
	}

	static fromScanned( scanned: ScannedFile ): FrameworkObject {
		const obj = new FrameworkObject( scanned.path );
		obj.runInitFromScanned( scanned );
		return obj;
	}

	static fromSerialized( json: SerializedArtifact ): FrameworkObject {
		const obj = new FrameworkObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// validateFrontmatter: lenient — no type check; directory convention is authoritative.
	// validateStructure: no required sections — structure varies by document.
}

KCDPrimitive.register( 'framework', ( markdown, absPath ) => FrameworkObject.parse( markdown, absPath ) );
