import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A utility: a registered, runnable `.js` tool. The tier is folder-gated (`draft/` proposed,
 * `deployed/` approved), and a tool runs only if `registry.md` lists it.
 * The source of truth for what a utility is: its frontmatter accessors and role.
 * Its frontmatter is a comment block at the head of the file, `/*--- … ---*\/`, parsed like Markdown `---`.
 */
export class UtilityObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'utility' );
	}

	static fromSerialized( json: SerializedArtifact ): UtilityObject {
		const obj = new UtilityObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }

	// ── Typed frontmatter accessors ──────────────────────────────────────────
	// `name` comes from the base ( getName ); the rest are surfaced here so consumers skip the raw bag.

	getDescription(): string {
		return String( this.frontmatter['description'] ?? '' );
	}

	/** Lifecycle tier: `'draft'` (proposed) or `'deployed'` (approved + runnable). */
	getStatus(): string {
		return String( this.frontmatter['status'] ?? '' );
	}

	/** The utility's parameters — user-set, NODE-set and never agent-set: the security barrier. */
	getParams(): string[] {
		const raw = this.frontmatter['params'];
		if ( !raw ) return [];
		return String( raw ).split( /[\s,]+/ ).map( p => p.trim() ).filter( Boolean );
	}
}
