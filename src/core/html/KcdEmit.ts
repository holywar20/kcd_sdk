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

/** The vault-wide stylesheet's home, relative to the vault root — the same filename
 *  `InstallManifest` deploys and `VaultUtilities.fixStylesheetLinks` sweeps toward. It moved out of
 *  `kcd/` on 2026-07-26; documents still pointing at `kcd/kcd.css` predate that and are stale. */
const CSS_HOME = 'kcd.css';

export const KcdEmit = new class KcdEmit {

	/**
	 * A full artifact → a full HTML document string ( doctype through `</html>` ).
	 *
	 * `vaultPath` is the artifact's VAULT-RELATIVE destination ( `plans/x.html` ), and it exists for
	 * one reason: the stylesheet link is a plain relative href, so its correct value depends on how
	 * deep the document sits. Omit it and the link is emitted bare — correct only at the vault root.
	 * Every caller that WRITES TO DISK must pass it; a preview or a test that never lands a file can
	 * leave it off. ( Deliberately not inferred from `artifact.path`: that field is absent on the
	 * agent-supplied save shape and carries a different form depending on who built it, so guessing
	 * from it would emit a confidently wrong depth. )
	 */
	emit( artifact: SerializedArtifact, vaultPath?: string ): string {
		const dl = this.frontmatterBlock( artifact.frontmatter );
		const article = this.spliceFrontmatter( artifact.body, dl );
		return this.document( artifact.type, this.titleOf( artifact ), article, this.cssHref( vaultPath ) );
	}

	/**
	 * The stylesheet href for a document living at `vaultPath` — one `../` per directory level, then
	 * `kcd.css` at the vault root. The mirror of `VaultUtilities.fixStylesheetLinks`'s depth math, so
	 * a freshly emitted document already agrees with what the corpus-wide sweep would rewrite it to.
	 *
	 * An absent or root-level path yields the bare filename. Backslashes are normalized first, since
	 * a Windows-shaped path would otherwise count as a single segment and silently emit depth 0.
	 */
	cssHref( vaultPath?: string ): string {
		const rel = ( vaultPath ?? '' ).replace( /\\/g, '/' ).replace( /^\/+/, '' );
		if( !rel ) return CSS_HOME;
		return '../'.repeat( rel.split( '/' ).length - 1 ) + CSS_HOME;
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
	 *  the sanitized body is styled by the renderer's own ported rules, which is why a wrong href
	 *  here stays invisible until someone opens the file in a browser ), and the body.
	 *
	 *  `cssHref` defaults to the bare filename ( vault-root depth ). Callers reach this through
	 *  `emit`, which computes it from the destination path — see `cssHref`. */
	document( type: string, title: string, articleInner: string, cssHref: string = CSS_HOME ): string {
		return '<!DOCTYPE html>\n'
			+ '<html lang="en">\n'
			+ '<head>\n'
			+ '\t<meta charset="utf-8">\n'
			+ `\t<title>${ HtmlTree.escapeText( title ) }</title>\n`
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
