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

/** The fallback stylesheet href — the bare filename, correct only for a document sitting AT the vault
 *  root. A real write path passes the configured absolute href instead; this exists so a caller that
 *  never lands a file ( `KCDPrimitive.toHtml()`, the emit tests ) still produces a well-formed head. */
const CSS_FALLBACK = 'kcd.css';

export const KcdEmit = new class KcdEmit {

	/**
	 * A full artifact → a full HTML document string ( doctype through `</html>` ).
	 *
	 * `cssHref` is the stylesheet link, handed in whole. It used to be COMPUTED here from the
	 * document's own depth ( one `../` per level up to the vault root ), and that shape was wrong twice
	 * over: the depth math had to be MIRRORED in a corpus-wide sweep to stay honest, and a document
	 * that moved carried a link that silently stopped resolving. The href is now one configured
	 * ABSOLUTE value every document shares — resolved by whoever knows the install ( `Config`, in
	 * daedalus ), passed down, never derived. kcd_sdk sits below that config and does not read it.
	 *
	 * Omitted, it falls back to the bare filename — correct only at the vault root, and meant for a
	 * caller that never lands a file. A WRITE path that omits it is a bug.
	 */
	emit( artifact: SerializedArtifact, cssHref: string = CSS_FALLBACK ): string {
		const dl = this.frontmatterBlock( artifact.frontmatter );
		const article = this.spliceFrontmatter( artifact.body, dl );
		return this.document( artifact.type, this.titleOf( artifact ), article, cssHref );
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

	/** Replace the existing `<dl data-kcd-frontmatter>` inside a body-HTML fragment with a freshly built
	 *  one. No existing block ( shouldn't happen on a validated artifact ) falls back to prepending it.
	 *
	 *  SIBLINGS ARE RE-SERIALIZED, NOT PRESERVED — this said "byte-for-byte as parsed" until 2026-08-13
	 *  and that was never true. It re-parses the whole body and rebuilds it through `HtmlTree.innerHtml`,
	 *  which normalizes incidental whitespace and quote style ( its own doc-comment says so: "NORMALIZED,
	 *  not byte-original" ). Fine by ruling — parity is asserted on section names, links and policy, never
	 *  on body bytes — but a guarantee stated here that the code did not keep is how the raw-content
	 *  escape defect stayed invisible: anyone auditing the save path read this line and stopped.
	 *
	 *  What IS byte-exact is raw content ( `<script>` / `<style>` ), which `serialize` now round-trips
	 *  verbatim to match how `parse` captured it. */
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
