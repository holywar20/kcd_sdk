/**
 * KcdEmit — object model → HTML, the render/emit direction ( parser-family row 5, protocol §2/§4 ).
 * Rebuilds only the `<dl data-kcd-frontmatter>` block, splicing it into the body; everything else passes **untouched**.
 * A richer emit is a separate design pass ( 05-sub §Phase 3 ).
 * Declared `data-kcd-type`s are read straight off `KcdValidate.FRONTMATTER`, never a second table.
 * This module only builds the string; the caller ( KcdService.save ) runs the result through `KcdValidate` before writing.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdValidate } from './KcdValidate';
import type { SerializedArtifact } from '../../primitives/types';

/** Fallback stylesheet name, correct only at the vault root. Legacy vaults keep the sheet under `kcd/`, which
 *  is why `cssHrefFor` takes the location as an argument. */
const CSS_FALLBACK = 'kcd.css';

/** TIER 1 of the stylesheet contract ( protocol §8.1 ): an inline baseline, LEGIBILITY NEVER DESIGN.
 *  Not a copy of `kcd.css`, which would go stale; KEEP IT UNDER TEN LINES or it becomes a second design language. */
const BASELINE_CSS =
	'\t\t/* KCD baseline — legibility only, never design. Overridden by kcd.css below. */\n' +
	'\t\tbody { background:#0d0d1c; color:#e6e6f2; font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;\n' +
	'\t\t       max-width:72rem; margin:2.5rem auto; padding:0 1.25rem; }\n' +
	'\t\ta    { color:#8b7ff0; }\n' +
	'\t\tcode { background:#17172e; border-radius:4px; padding:.05rem .3rem; }\n';

export const KcdEmit = new class KcdEmit {

	/**
	 * `cssHref` is TIER 2, the relative link built by `cssHrefFor`; TIER 1, the inline baseline, is emitted unconditionally.
	 * Omitted, `cssHref` falls back to the bare filename, correct only at the vault root: a WRITE path that omits it is a bug.
	 * The axis is not absolute versus relative. A viewer that renders a document detached from its directory cannot follow
	 * either, so the document carries a baseline and references the design language.
	 */
	emit( artifact: SerializedArtifact, cssHref: string = CSS_FALLBACK ): string {
		const dl = this.frontmatterBlock( artifact.frontmatter );
		const article = this.spliceFrontmatter( artifact.body, dl );
		return this.document( artifact.type, this.titleOf( artifact ), article, cssHref );
	}

	/** TIER 1 as written into a head, with the emitter's own indentation. ONE SOURCE, so no writer can drift from another. */
	baselineBlock(): string {
		return '\t<style>\n' + BASELINE_CSS + '\t</style>\n';
	}

	/** THE ONE COPY OF THIS MATH ( protocol §8.1 ). `cssVaultRel` varies: legacy vaults keep the sheet under `kcd/`,
	 *  and assuming the root would break every link in one. */
	cssHrefFor( vaultRelDocPath: string, cssVaultRel: string = CSS_FALLBACK ): string {
		const clean = ( s: string ) => s.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^\/+/, '' );
		const target = clean( cssVaultRel ) || CSS_FALLBACK;
		const depth  = clean( vaultRelDocPath ).split( '/' ).filter( Boolean ).length - 1;
		return depth > 0 ? '../'.repeat( depth ) + target : target;
	}

	/** THE ONE COPY OF THIS MATCH. Attribute order is irrelevant: treating it as significant was the defect.
	 *  An unreadable href returns `href: null`, which must stay distinct from no link at all. */
	stylesheetLink( raw: string ): { tag: string; href: string | null; index: number } | null {
		for ( const m of raw.matchAll( /<link\b[^>]*>/gi ) ) {
			const tag = m[ 0 ];
			if ( !/\brel\s*=\s*["']stylesheet["']/i.test( tag ) ) continue;
			const href = /\bhref\s*=\s*"([^"]*)"/i.exec( tag );
			return { tag, href: href ? href[ 1 ] : null, index: m.index ?? 0 };
		}
		return null;
	}

	/** Inverse of `cssHrefFor`: stripping the whole leading `../` run recovers the target, so a wrong href self-heals.
	 *  Null for URLs and root-absolute paths, which are a different repair and not a mover's to rewrite. */
	cssTargetFrom( href: string ): string | null {
		const clean = href.replace( /\\/g, '/' ).trim();
		if ( !clean || clean.includes( ':' ) || clean.startsWith( '/' ) ) return null;
		const target = clean.replace( /^(?:\.\.\/)+/, '' );
		return target && !target.startsWith( '../' ) ? target : null;
	}

	/** frontmatter → `<dl data-kcd-frontmatter>`, the inverse of `KcdParse.frontmatter()`. Empty values are skipped,
	 *  so no key is minted that the source did not carry. */
	frontmatterBlock( frontmatter: Record<string, unknown> ): string {
		const rows = Object.entries( frontmatter )
			.filter( ( [ , v ] ) => v !== undefined && v !== '' && !( Array.isArray( v ) && v.length === 0 ) )
			.map( ( [ key, v ] ) => this.row( key, v ) );
		return `<dl data-kcd-frontmatter>\n${ rows.join( '\n' ) }\n</dl>`;
	}

	/** One `<dt>`+`<dd>` pair. Type comes from `KcdValidate.FRONTMATTER`, falling back to `text` for an unknown key.
	 *  A `path`/`url` value must be a real `href`, or `KcdAddress.fieldValue` reads it back as an empty link. */
	row( key: string, value: unknown ): string {
		const type = KcdValidate.FRONTMATTER[ key ]?.type ?? 'text';

		if ( type === 'list' ) {
			const items = ( Array.isArray( value ) ? value : [ value ] ).map( String );
			const chips = items.map( v => `<li data-kcd-tag>${ HtmlTree.escapeText( v ) }</li>` ).join( '' );
			return `\t<dt>${ key }</dt><dd data-kcd-field="${ key }" data-kcd-type="list"><ul data-kcd-chips>${ chips }</ul></dd>`;
		}

		const text = HtmlTree.escapeText( String( value ) );
		if ( type === 'path' || type === 'url' ) {
			const href = HtmlTree.escapeAttr( String( value ) );
			return `\t<dt>${ key }</dt><dd data-kcd-field="${ key }" data-kcd-type="${ type }" href="${ href }">${ text }</dd>`;
		}
		return `\t<dt>${ key }</dt><dd data-kcd-field="${ key }" data-kcd-type="${ type }">${ text }</dd>`;
	}

	/** Siblings are RE-SERIALIZED, never byte-preserved: only raw `<script>` / `<style>` content round-trips verbatim.
	 *  Parity is asserted on names, links and policy, not body bytes. */
	spliceFrontmatter( body: string, dlHtml: string ): string {
		const root = HtmlTree.parse( body );
		const replacement = HtmlTree.parse( dlHtml ).kids.find( HtmlTree.isEl )!;
		if ( !this.replaceFirst( root, el => KcdAddress.isFrontmatter( el ), replacement ) ) {
			root.kids.unshift( replacement );
		}
		return HtmlTree.innerHtml( root );
	}

	/** Depth-first find-and-replace-in-place ( `HtmlTree` has no mutation helper — this is the one
	 *  emit-only exception, kept here rather than growing the shared reader's surface for one caller ). */
	replaceFirst( el: HtmlEl, pred: ( el: HtmlEl ) => boolean, replacement: HtmlEl ): boolean {
		for ( let i = 0; i < el.kids.length; i++ ) {
			const kid = el.kids[ i ];
			if ( !HtmlTree.isEl( kid ) ) continue;
			if ( pred( kid ) ) { el.kids[ i ] = replacement; return true; }
			if ( this.replaceFirst( kid, pred, replacement ) ) return true;
		}
		return false;
	}

	/** Wrap an `<article>`'s inner HTML in a full document — doctype, a minimal head ( the
	 *  `kcd.css` link mirrors every hand-authored artifact; Starmind itself never loads it live —
	 *  the sanitized body is styled by the renderer's own ported rules, which is why a wrong href
	 *  here stays invisible until someone opens the file in a browser ), and the body.
	 *
	 *  `cssHref` defaults to the bare filename ( vault-root only ). Callers reach this through `emit`,
	 *  which takes the configured absolute href from its own caller — see `emit`. */
	document( type: string, title: string, articleInner: string, cssHref: string = CSS_FALLBACK ): string {
		// THE ORDER IS LOAD-BEARING ( protocol §8.1 ): baseline FIRST, link SECOND, so kcd.css overrides the baseline.
		// Reversed, the baseline silently beats the real stylesheet in every browser, with nothing to indicate it.
		return '<!DOCTYPE html>\n'
			+ '<html lang="en">\n'
			+ '<head>\n'
			+ '\t<meta charset="utf-8">\n'
			+ `\t<title>${ HtmlTree.escapeText( title ) }</title>\n`
			+ this.baselineBlock()
			+ `\t<link rel="stylesheet" href="${ cssHref }">\n`
			+ '</head>\n'
			+ '<body>\n\n'
			+ `<article data-kcd="${ type }">\n`
			+ articleInner + '\n'
			+ '</article>\n\n'
			+ '</body>\n'
			+ '</html>\n';
	}

	/** The document `<title>` — cosmetic only ( dropped by `HtmlSanitize`, unread by `KcdParse` ) —
	 *  so a missing/blank name never breaks the write. */
	titleOf( artifact: SerializedArtifact ): string {
		const name = artifact.frontmatter[ 'name' ];
		return typeof name === 'string' && name ? name : artifact.type;
	}
}();
