import { KCDPrimitive } from '../framework/KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A utility: a registered, runnable tool — an executable `.js` code file the human runs and
 * (eventually) the interface triggers as a button. The tier is folder-gated (`draft/` proposed,
 * `deployed/` approved) and allowlisted by `registry.md`; a tool runs only if listed there.
 *
 * This class is the SOURCE OF TRUTH for what a utility IS — its expected frontmatter and role —
 * so the parser, MCP, and UI treat utilities as first-class instead of falling back to a base
 * primitive. The expected frontmatter (typed accessors below): `type`, `name`, `description`,
 * `status`, and the optional `params` — a utility's parameters (today: a name list; tomorrow a
 * SettingField-typed variable surfaced in the work block, see the `parameters` idiom).
 *
 * NOTE — disk form: utilities carry COMMENT-frontmatter, a `/*--- … ---*\/` block at the head of
 * the `.js` file, parsed exactly like Markdown `---` frontmatter. Wiring that comment-frontmatter
 * read path into the scanner/pipeline is a follow-up fill; this class is the model now.
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
	// The basic properties a utility is expected to carry. `name` comes from the base
	// ( getName ); the rest are surfaced here so consumers read a utility's shape without
	// reaching into the raw frontmatter bag.

	/** Human-facing summary — what the tool does. Empty string when absent. */
	getDescription(): string {
		return String( this.frontmatter['description'] ?? '' );
	}

	/** Lifecycle tier: `'draft'` (proposed) or `'deployed'` (approved + runnable). */
	getStatus(): string {
		return String( this.frontmatter['status'] ?? '' );
	}

	/** The utility's parameters — user-set inputs (NODE-set, never agent-set: the security
	 *  barrier). Stored as a comma/space-separated `params` list; returned split, [] when absent.
	 *  These are the seed of the general `parameters` idiom (a SettingField-typed variable). */
	getParams(): string[] {
		const raw = this.frontmatter['params'];
		if ( !raw ) return [];
		return String( raw ).split( /[\s,]+/ ).map( p => p.trim() ).filter( Boolean );
	}
}
