/**
 * KcdText — HTML artifact → faithful readable prompt text ( parser-family, the AI-context READ
 * direction ). Walks the shared HtmlTree and emits block-structured plain text: headings as
 * markdown `#` lines, list items as `- ` bullets, paragraphs / blockquotes on their own lines,
 * table rows as ` · `-joined cells. The frontmatter `<dl>` and page chrome ( head / style / script )
 * are dropped; everything else inside the `<article>` is emitted in document order so no authored
 * content is lost.
 *
 * DELIBERATE PLACEHOLDER. The canonical dual-audience emitter ( the parser lens's Phase-3
 * AI-context head ) will supersede this — it is kept minimal and faithful for the one caller today:
 * a model's bound root context ( see the main-side ModelService.rootContextFor ). Prompt-level
 * special tags have no settled canonical form yet, so nothing here strips angle-bracket content
 * beyond ordinary HTML structure — whatever an artifact holds, its text rides through whole.
 */

import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';

export const KcdText = new class KcdText {

	private HEADINGS = new Set( [ 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] );
	// Chrome + machine-only structure — never part of the prompt body. `dl` is the frontmatter block.
	private SKIP     = new Set( [ 'head', 'style', 'script', 'link', 'meta', 'dl' ] );

	/** Emit an HTML string as faithful readable text. Prefers the `<article>` body; falls back to the
	 *  whole document when there is no article. Empty string for empty / unparseable input. */
	emit( html: string ): string {
		if ( !html || !html.trim() ) return '';
		const root    = HtmlTree.parse( html );
		const article = HtmlTree.first( root, ( el ) => el.tag === 'article' ) ?? root;
		const out: string[] = [];
		this.block( article, out );
		return out.join( '\n' ).replace( /\n{3,}/g, '\n\n' ).trim();
	}

	/** Walk one element's children, emitting block boundaries. Containers recurse; leaf blocks emit
	 *  their collapsed inline text and stop ( so a `<blockquote><p>…` is not counted twice ). */
	private block( el: HtmlEl, out: string[] ): void {
		for ( const kid of el.kids ) {
			if ( kid.type === 'text' ) { const t = this.inline( kid ); if ( t ) out.push( t ); continue; }

			const tag = kid.tag;
			if ( this.SKIP.has( tag ) ) continue;

			if ( this.HEADINGS.has( tag ) ) {
				out.push( '', '#'.repeat( Number( tag[ 1 ] ) ) + ' ' + this.inline( kid ), '' );
				continue;
			}
			if ( tag === 'li' ) { out.push( '- ' + this.inline( kid ) ); continue; }
			if ( tag === 'p' || tag === 'blockquote' ) { out.push( '', this.inline( kid ), '' ); continue; }
			if ( tag === 'tr' ) {
				const cells = kid.kids.filter( HtmlTree.isEl ).map( ( c ) => this.inline( c ) ).filter( Boolean );
				if ( cells.length ) out.push( '- ' + cells.join( ' · ' ) );
				continue;
			}
			// Container ( body, article, section, ul, ol, div, table, thead, tbody, … ) — recurse in.
			this.block( kid, out );
		}
	}

	/** Collapse a node's whole-subtree text to a single trimmed line. */
	private inline( n: HtmlNode ): string {
		return HtmlTree.textOf( n ).replace( /\s+/g, ' ' ).trim();
	}
}
