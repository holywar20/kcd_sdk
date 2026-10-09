/**
 * KcdText — HTML artifact → faithful readable prompt text, the AI-context READ direction.
 * DELIBERATE PLACEHOLDER: the canonical dual-audience emitter will supersede it.
 * Nothing here strips angle-bracket content beyond ordinary HTML structure — whatever an artifact
 * holds, its text rides through whole. Prompt-level special tags have no settled canonical form yet.
 */

import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';

export const KcdText = new class KcdText {

	HEADINGS = new Set( [ 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] );
	// Chrome + machine-only structure — never part of the prompt body. `dl` is the frontmatter block.
	SKIP     = new Set( [ 'head', 'style', 'script', 'link', 'meta', 'dl' ] );

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
	block( el: HtmlEl, out: string[] ): void {
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

	inline( n: HtmlNode ): string {
		return HtmlTree.textOf( n ).replace( /\s+/g, ' ' ).trim();
	}
}
