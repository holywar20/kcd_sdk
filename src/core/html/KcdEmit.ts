/**
 * KcdEmit — object-model → HTML, the render/emit direction ( parser-family row 5, protocol §2/§4 ).
 *
 * The inverse of `KcdParse.frontmatter()`: given a `frontmatter` record it rebuilds the
 * `<dl data-kcd-frontmatter>` block, splices it into the artifact's existing `body` ( replacing the
 * stale one wholesale ), and wraps the result in a full HTML document. Everything below the
 * frontmatter — regions, sections, slots, params — passes through **untouched**: today's only editing
 * surface ( the Editor.vue POC ) edits frontmatter alone, so that is the only half this emitter
 * regenerates. A richer emit ( sections/regions rebuilt from structured state ) is a later, separate
 * design pass — see 05-sub §Phase 3.
 *
 * Declared `data-kcd-type`s are read straight off `KcdValidate.FRONTMATTER`, never a second table —
 * one spec, so an emitted field can never declare a type the validator itself would flag as drift.
 * The caller ( KcdService.save ) is expected to run the result back through `KcdValidate` before
 * writing — this module only builds the string; it does not enforce conformance itself.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdValidate } from './KcdValidate';
import type { SerializedArtifact } from '../../primitives/types';

export const KcdEmit = new class KcdEmit {

	/** A full artifact → a full HTML document string ( doctype through `</html>` ). */
	emit( artifact: SerializedArtifact ): string {
		const dl = this.frontmatterBlock( artifact.frontmatter );
		const article = this.spliceFrontmatter( artifact.body, dl );
		return this.document( artifact.type, this.titleOf( artifact ), article );
	}

	/** frontmatter → `<dl data-kcd-frontmatter>…</dl>`, the inverse of `KcdParse.frontmatter()`.
	 *  Keys are emitted in the record's own iteration order; an absent / empty-string value is
	 *  skipped ( never mint a key the source didn't carry — mirrors the parser's own skip rule ). */
	frontmatterBlock( frontmatter: Record<string, unknown> ): string {
		const rows = Object.entries( frontmatter )
			.filter( ( [ , v ] ) => v !== undefined && v !== '' && !( Array.isArray( v ) && v.length === 0 ) )
			.map( ( [ key, v ] ) => this.row( key, v ) );
		return `<dl data-kcd-frontmatter>\n${ rows.join( '\n' ) }\n</dl>`;
	}

	/** One `<dt>`+`<dd>` pair. Type comes from the locked `KcdValidate.FRONTMATTER` spec ( falling back
	 *  to `text` for a key outside the closed set — never fatal, just unenforced ). A `path`/`url` field
	 *  carries its value as a real `href` ( not just text ) so `KcdAddress.fieldValue` resolves it on
	 *  read-back — text-only would round-trip as an empty link per the addressing contract. */
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

	/** Replace the existing `<dl data-kcd-frontmatter>` inside a body-HTML fragment with a freshly
	 *  built one, leaving every sibling ( regions/sections/slots ) byte-for-byte as parsed. No existing
	 *  block ( shouldn't happen on a validated artifact ) falls back to prepending it. */
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
	 *  the sanitized body is styled by the renderer's own ported rules ), and the body. */
	document( type: string, title: string, articleInner: string ): string {
		return '<!DOCTYPE html>\n'
			+ '<html lang="en">\n'
			+ '<head>\n'
			+ '\t<meta charset="utf-8">\n'
			+ `\t<title>${ HtmlTree.escapeText( title ) }</title>\n`
			+ '\t<link rel="stylesheet" href="kcd.css">\n'
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
