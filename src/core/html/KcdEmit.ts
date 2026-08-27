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

/** The stylesheet's default location relative to the vault root. A pre-2026-07-26 vault keeps it at
 *  `kcd/kcd.css` instead, which is why `cssHrefFor` takes it as an argument rather than assuming it.
 *  Used bare when no destination is supplied ( `KCDPrimitive.toHtml()`, the emit tests ) — correct for
 *  a document AT the vault root, and the safest guess when the depth is unknown. */
const CSS_FALLBACK = 'kcd.css';

/**
 * TIER 1 of the stylesheet contract ( protocol §8.1, amended 2026-08-17 ) — the baseline every emitted
 * document carries inline. LEGIBILITY, NEVER DESIGN.
 *
 * It exists because the surface most readers actually use cannot load an external stylesheet at all:
 * a document rendered detached from its directory has nothing for a `<link>` to resolve against, and
 * it fails SILENTLY — no warning, just an unstyled page. Relative or absolute made no difference, so
 * the answer is to carry the minimum and reference the rest.
 *
 * KEEP IT UNDER TEN LINES. Past that it has stopped being a baseline and become a second design
 * language that must then be kept in step with `kcd.css` — the exact failure this tier avoids. It is
 * deliberately NOT a copy of the real stylesheet: a full inline copy would be ~10KB per document,
 * would go stale the moment `kcd.css` changed, and would put a corpus one commit from an every-file
 * diff. Two colours and a measure never go stale, because an out-of-date "dark background, light
 * text" is still correct.
 */
const BASELINE_CSS =
	'\t\t/* KCD baseline — legibility only, never design. Overridden by kcd.css below. */\n' +
	'\t\tbody { background:#0d0d1c; color:#e6e6f2; font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;\n' +
	'\t\t       max-width:72rem; margin:2.5rem auto; padding:0 1.25rem; }\n' +
	'\t\ta    { color:#8b7ff0; }\n' +
	'\t\tcode { background:#17172e; border-radius:4px; padding:.05rem .3rem; }\n';

export const KcdEmit = new class KcdEmit {

	/**
	 * A full artifact → a full HTML document string ( doctype through `</html>` ).
	 *
	 * `cssHref` is TIER 2 — the relative link to the real stylesheet, built by `cssHrefFor` from the
	 * destination's vault-relative path. TIER 1, the inline baseline, is emitted unconditionally and
	 * takes no argument: it is the same nine lines in every document by design.
	 *
	 * Omitted, `cssHref` falls back to the bare filename — correct only at the vault root, and meant
	 * for a caller that never lands a file. A WRITE path that omits it is a bug.
	 *
	 * HISTORY, because this has been settled three times and twice on the wrong axis. Depth-relative
	 * originally; replaced 2026-07-29 by one configured ABSOLUTE `file:///` value to stop two copies of
	 * the depth math drifting; reversed to relative on 2026-08-17 by a session that had not read §8.1
	 * and reverted the same day. The axis was never absolute-versus-relative — a viewer that renders a
	 * document detached from its directory cannot follow a reference of EITHER kind. §8.1 was amended
	 * on evidence: carry a baseline, reference the design language, and put the depth math in ONE
	 * function so the original duplication objection is answered rather than sidestepped.
	 */
	emit( artifact: SerializedArtifact, cssHref: string = CSS_FALLBACK ): string {
		const dl = this.frontmatterBlock( artifact.frontmatter );
		const article = this.spliceFrontmatter( artifact.body, dl );
		return this.document( artifact.type, this.titleOf( artifact ), article, cssHref );
	}

	/** TIER 1 as it is actually written into a head — `<style>` open, the baseline, `</style>`, all with
	 *  the emitter's own indentation. ONE SOURCE: `document()` and `VaultUtilities.fixStylesheetLinks`
	 *  both call this, so a swept document and a freshly-emitted one carry the identical block and the
	 *  sweep cannot drift from the writer. */
	baselineBlock(): string {
		return '\t<style>\n' + BASELINE_CSS + '\t</style>\n';
	}

	/**
	 * TIER 2's href — one `../` per directory level from the document up to the vault root, then the
	 * stylesheet's own location within it.
	 *
	 * THE ONE COPY OF THIS MATH ( protocol §8.1 ). The emitter and `VaultUtilities.fixStylesheetLinks`
	 * both call this rather than each computing a run of `../`, which is the drift the 2026-07-29
	 * absolute-href ruling was actually trying to prevent — it removed the relativity instead of the
	 * duplication, and lost portability to buy it.
	 *
	 * `cssVaultRel` is where the stylesheet sits RELATIVE TO THE VAULT ROOT, and it is a parameter
	 * rather than a constant because it genuinely varies: a current vault keeps `kcd.css` at the root,
	 * while a vault created before 2026-07-26 keeps it at `kcd/kcd.css` and is not wrong. Assuming the
	 * root would emit a confidently broken link into every document of an older vault.
	 *
	 * So `references/patterns/x.html` → `../../kcd.css`, and the same document in a legacy vault →
	 * `../../kcd/kcd.css`. A root-level or empty path yields the location unchanged.
	 */
	cssHrefFor( vaultRelDocPath: string, cssVaultRel: string = CSS_FALLBACK ): string {
		const clean = ( s: string ) => s.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^\/+/, '' );
		const target = clean( cssVaultRel ) || CSS_FALLBACK;
		const depth  = clean( vaultRelDocPath ).split( '/' ).filter( Boolean ).length - 1;
		return depth > 0 ? '../'.repeat( depth ) + target : target;
	}

	/**
	 * FIND the tier-2 stylesheet link in a document — the one matcher both readers of it share.
	 *
	 * THE ONE COPY OF THIS MATCH, for the same reason `cssHrefFor` is the one copy of the depth math.
	 * Two callers used to declare the identical regex privately —
	 * `VaultUtilities.fixStylesheetLinks` and `Vault.restampStylesheet` — and it was
	 * `/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/`: FIRST MATCH ONLY, EXACT ATTRIBUTE ORDER.
	 * A tag putting `href` before `rel`, or carrying any third attribute, matched nothing and was
	 * skipped **without a report** — indistinguishable from a document that has no link at all.
	 *
	 * The gap survived because the emitter writes the attributes in exactly the order the old pattern
	 * expected, so every document this system AUTHORED matched. What did not was a HAND-EDITED head,
	 * which is precisely the document a person cared enough to touch. It also widened silently: when
	 * `Vault.restampStylesheet` shipped, a documented gap in one tidiness command became a gap on every
	 * MOVE, behind a best-effort `catch` that reports the move as a success either way.
	 *
	 * ATTRIBUTE ORDER IS IRRELEVANT HERE and treating it as significant was the defect. Returns the tag,
	 * its offset, and its `href` — `null` for a stylesheet link whose href cannot be read, which is a
	 * DIFFERENT answer from no link at all and must stay distinguishable: a caller that cannot tell
	 * them apart is the failure this whole comment is about.
	 */
	stylesheetLink( raw: string ): { tag: string; href: string | null; index: number } | null {
		for ( const m of raw.matchAll( /<link\b[^>]*>/gi ) ) {
			const tag = m[ 0 ];
			if ( !/\brel\s*=\s*["']stylesheet["']/i.test( tag ) ) continue;
			const href = /\bhref\s*=\s*"([^"]*)"/i.exec( tag );
			return { tag, href: href ? href[ 1 ] : null, index: m.index ?? 0 };
		}
		return null;
	}

	/**
	 * The INVERSE of `cssHrefFor` — recover the vault-relative stylesheet target from an emitted href.
	 *
	 * Kept beside its inverse for the reason the forward direction is here at all: these are one piece
	 * of math and separating them is how the two drift. A caller that has a document's existing link
	 * and needs to re-express it somewhere else ( a MOVE, which changes depth ) must not re-derive the
	 * target from configuration — the document already says what it points at, and reading it back is
	 * both cheaper and correct for a vault whose stylesheet does not sit at the root.
	 *
	 * The leading `../` run is pure depth padding, so stripping ALL of it recovers the target whatever
	 * depth it was written for. That is deliberate rather than incidental: an href that was already
	 * WRONG for its location still names the right target, so re-expressing it self-heals instead of
	 * faithfully carrying the error to the new path.
	 *
	 * Null for anything that is not a plain relative reference — a protocol URL ( `file:///…`, `http://` )
	 * or a root-absolute path. Those are a different repair with a different ruling behind them, and a
	 * mover silently rewriting one would be making that decision on its own authority.
	 */
	cssTargetFrom( href: string ): string | null {
		const clean = href.replace( /\\/g, '/' ).trim();
		if ( !clean || clean.includes( ':' ) || clean.startsWith( '/' ) ) return null;
		const target = clean.replace( /^(?:\.\.\/)+/, '' );
		return target && !target.startsWith( '../' ) ? target : null;
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
		// THE ORDER IS LOAD-BEARING ( protocol §8.1 ): baseline FIRST, link SECOND. Both set `body` at
		// identical specificity, so the later declaration wins and kcd.css overrides the baseline.
		// Reversed, nine lines silently beat the real stylesheet in every browser — a page that looks
		// fine, styled by the wrong sheet, with nothing anywhere to indicate it.
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
