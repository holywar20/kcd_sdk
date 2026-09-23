import { HtmlTree, type HtmlEl } from './HtmlTree';
import { KcdAddress } from './KcdAddress';

/**
 * LensMigration — the one-way rewrite of a Know / Care / Do lens into the flat lens ( plan agents-own-behaviour,
 * task 66 ): personality + philosophy + references, and nothing that behaves.
 *
 *   personality ← the lede under the title, then the Care region's Purpose
 *   philosophy  ← the Care region's Philosophy, then its Open Questions under a sub-heading
 *   references  ← the Know region's reference rows, then its Domains rows — code areas are references too
 *   dropped     ← the Do region whole ( habits, contracts, tools belong to the agent and the project ), every
 *                 region's own intro line, and the `base` frontmatter field
 *
 * SPLICED, NOT RE-SERIALIZED. Every piece that survives is cut from the source by its parsed span, so the prose
 * a person wrote comes across byte for byte; only the scaffolding around it is new. Null for a document that is
 * not a lens or is already flat.
 */
// The helpers below carry the `_` prefix and NOT `private`. This const is an anonymous-class instance, so
// declaration emit has no name to write for a private member and refuses the whole build ( TS4094 ). The `_`
// is the signal a reader acts on either way; `private` here buys nothing and costs `npm run build`.
export const LensMigration = new class LensMigration {

	flatten( html: string ): string | null {
		const root    = HtmlTree.parse( html );
		const article = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd' ) === 'lens' );
		if( !article || article.start === undefined || article.end === undefined ) return null;
		const regions = article.kids.filter( ( k ): k is HtmlEl => HtmlTree.isEl( k ) && KcdAddress.isRegion( k ) );
		if( !regions.length ) return null;

		const region  = ( name: string ): HtmlEl | undefined => regions.find( ( r ) => HtmlTree.get( r, 'data-kcd-region' ) === name );
		const section = ( reg: HtmlEl | undefined, name: string ): HtmlEl | null =>
			reg ? HtmlTree.first( reg, ( el ) => KcdAddress.isSection( el ) && HtmlTree.get( el, 'data-kcd-section' ) === name ) : null;

		const know = region( 'know' );
		const care = region( 'care' );

		const fm    = article.kids.find( ( k ): k is HtmlEl => HtmlTree.isEl( k ) && KcdAddress.isFrontmatter( k ) );
		const title = article.kids.find( ( k ): k is HtmlEl => HtmlTree.isEl( k ) && k.tag === 'h1' );
		const lede  = article.kids.filter( ( k ): k is HtmlEl => HtmlTree.isEl( k ) && k !== fm && k !== title && !KcdAddress.isRegion( k ) );

		const personality = [ ...lede.map( ( el ) => this._span( html, el ) ), this._content( html, section( care, 'purpose' ) ) ].filter( Boolean );
		const philoSec    = section( care, 'philosophy' );
		const questions   = this._content( html, section( care, 'open-questions' ) );
		const philosophy  = [ this._content( html, philoSec ), questions ? `<h4 data-kcd-heading>Open Questions</h4>\n${ questions }` : '' ].filter( Boolean );

		const refs = section( know, 'references' );
		const head = refs ? HtmlTree.first( refs, ( el ) => HtmlTree.has( el, 'data-kcd-head' ) ) : null;
		const rows = [ refs, section( know, 'domains' ) ]
			.flatMap( ( sec ) => sec ? HtmlTree.collect( sec, ( el ) => KcdAddress.isSlot( el ) ) : [] )
			.map( ( el ) => '\t\t' + this._span( html, el ) );

		const open  = html.slice( article.start, this._openEnd( html, article ) );
		const parts = [
			open,
			fm ? this._dropBase( this._span( html, fm ) ) : '',
			title ? this._span( html, title ) : '',
			this._section( 'personality', '<h3 data-kcd-heading>Personality</h3>', personality ),
			this._section( 'philosophy', philoSec ? this._heading( html, philoSec ) : '<h3 data-kcd-heading>Philosophy</h3>', philosophy ),
			rows.length ? this._section( 'references', '<h3>References</h3>', [
				'<div data-kcd-table>',
				'\t\t' + ( head ? this._span( html, head ) : '<div data-kcd-head><span>What</span><span>Where</span><span>Why</span></div>' ),
				...rows,
				'\t</div>',
			] ) : '',
			'</article>',
		].filter( Boolean );
		return html.slice( 0, article.start ) + parts.join( '\n' ) + html.slice( article.end );
	}

	// ── internals ────────────────────────────────────

	_section( name: string, heading: string, body: string[] ): string {
		if( !body.length ) return '';
		return [ `<section data-kcd-section="${ name }">`, `\t${ heading }`, ...body.map( ( b ) => b.startsWith( '\t' ) ? b : '\t' + b ), '</section>' ].join( '\n' );
	}

	/** An element's exact source. */
	_span( html: string, el: HtmlEl ): string {
		return html.slice( el.start!, el.end! ).trim();
	}

	/** Where an element's open tag ends. */
	_openEnd( html: string, el: HtmlEl ): number {
		return html.indexOf( '>', el.start! ) + 1;
	}

	/** A section's own heading, verbatim — the author's title stands. */
	_heading( html: string, sec: HtmlEl ): string {
		const h = this._firstHeading( sec );
		return h ? this._span( html, h ) : '';
	}

	_firstHeading( sec: HtmlEl ): HtmlEl | undefined {
		return sec.kids.find( ( k ): k is HtmlEl => HtmlTree.isEl( k ) && /^h[1-6]$/.test( k.tag ) );
	}

	/** What a section says, without its heading: the source between the heading ( or the open tag ) and the close. */
	_content( html: string, sec: HtmlEl | null ): string {
		if( !sec ) return '';
		const heading = this._firstHeading( sec );
		const from    = heading ? heading.end! : this._openEnd( html, sec );
		const close   = html.lastIndexOf( '</section>', sec.end! );
		return html.slice( from, close ).trim();
	}

	/** The frontmatter without its `base` row — a lens inherits from nothing. */
	_dropBase( dl: string ): string {
		return dl.replace( /[ \t]*<dt>\s*base\s*<\/dt>\s*<dd\b[^>]*data-kcd-field=["']base["'][^>]*>[^<]*<\/dd>[ \t]*\r?\n?/i, '' );
	}
}();
