/**
 * HtmlTree — the Node-free HTML substrate the whole parser family sits on.
 *
 * ONE reader, ONE navigation surface. Both heads — KcdValidate ( binary conform check ) and
 * KcdParse ( object-model emit ) — walk THIS tree; neither re-implements HTML reading or node
 * traversal. This is the layer the parser lens defends: small total functions behind a clean seam,
 * never a regex pile re-grown in two places.
 *
 * TWO entry points, ONE node shape:
 *   • parse( html )   — a dependency-free reader for Node ( the SDK / converter / CLI ).
 *   • fromDOM( el )   — wraps a real DOM element/Document ( the Starmind renderer, where DOMParser
 *                       already produced the tree ). Same output shape, so every consumer is
 *                       environment-agnostic.
 *
 * Node shape:  { type:'el', tag, attrs:{}, kids:[ … ] }  |  { type:'text', value }
 *
 * `parse()` is the placeholder MiniHtml reader, ported verbatim from the dev-utilities validator so
 * the substrate is proven. It handles the subset KCD docs use: nested elements, quoted attributes,
 * comments, doctype, void elements, and raw <script>/<style>.
 */

export type HtmlNode = HtmlEl | HtmlText;

export interface HtmlEl   { type: 'el';   tag: string; attrs: Record<string, string>; kids: HtmlNode[]; }
export interface HtmlText { type: 'text'; value: string; }

export const HtmlTree = new class HtmlTree {

	VOID = new Set( [ 'meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'col', 'area', 'base', 'wbr' ] );
	RAW  = new Set( [ 'script', 'style' ] );

	// ── Construction ───────────────────────────────────────────────────────────

	/** Parse an HTML string into a normalized node tree. Returns the synthetic `#document` root. */
	parse( html: string ): HtmlEl {
		const root: HtmlEl = { type: 'el', tag: '#document', attrs: {}, kids: [] };
		const stack: HtmlEl[] = [ root ];
		const top = () => stack[ stack.length - 1 ];
		let i = 0;

		while ( i < html.length ) {
			if ( html[ i ] !== '<' ) {
				const next = html.indexOf( '<', i );
				const end  = next < 0 ? html.length : next;
				const text = html.slice( i, end );
				if ( text.trim() !== '' ) top().kids.push( { type: 'text', value: this.decode( text ) } );
				i = end;
				continue;
			}

			if ( html.startsWith( '<!--', i ) ) { const e = html.indexOf( '-->', i + 4 ); i = e < 0 ? html.length : e + 3; continue; }
			if ( html[ i + 1 ] === '!' )         { const e = html.indexOf( '>', i );       i = e < 0 ? html.length : e + 1; continue; }

			if ( html[ i + 1 ] === '/' ) {
				const e = html.indexOf( '>', i );
				const name = html.slice( i + 2, e < 0 ? html.length : e ).trim().toLowerCase();
				for ( let s = stack.length - 1; s > 0; s-- ) if ( stack[ s ].tag === name ) { stack.length = s; break; }
				i = e < 0 ? html.length : e + 1;
				continue;
			}

			const e = this.tagEnd( html, i );
			const inner = html.slice( i + 1, e ).trim();
			const selfClose = inner.endsWith( '/' );
			const { tag, attrs } = this.parseTag( selfClose ? inner.slice( 0, -1 ) : inner );
			const el: HtmlEl = { type: 'el', tag, attrs, kids: [] };
			top().kids.push( el );
			i = e + 1;

			if ( selfClose || this.VOID.has( tag ) ) continue;

			if ( this.RAW.has( tag ) ) {
				const close = html.toLowerCase().indexOf( '</' + tag, i );
				const end   = close < 0 ? html.length : close;
				if ( html.slice( i, end ) !== '' ) el.kids.push( { type: 'text', value: html.slice( i, end ) } );
				const gt = html.indexOf( '>', end );
				i = gt < 0 ? html.length : gt + 1;
				continue;
			}
			stack.push( el );
		}
		return root;
	}

	/** Wrap a real DOM element/Document into the same normalized node tree. */
	fromDOM( dom: any ): HtmlEl {
		const conv = ( n: any ): HtmlNode | null => {
			if ( n.nodeType === 3 ) return { type: 'text', value: n.nodeValue };
			if ( n.nodeType !== 1 ) return null;
			const attrs: Record<string, string> = {};
			for ( const at of n.attributes ) attrs[ at.name.toLowerCase() ] = at.value;
			const el: HtmlEl = { type: 'el', tag: n.tagName.toLowerCase(), attrs, kids: [] };
			for ( const c of n.childNodes ) { const k = conv( c ); if ( k ) el.kids.push( k ); }
			return el;
		};
		const root: HtmlEl = { type: 'el', tag: '#document', attrs: {}, kids: [] };
		const node = dom.documentElement ? dom.documentElement : dom;
		const top = conv( node );
		if ( top ) root.kids.push( top );
		return root;
	}

	// ── Navigation ( the shared traversal surface ) ──────────────────────────────

	isEl( n: HtmlNode | null | undefined ): n is HtmlEl { return !!n && n.type === 'el'; }
	has( el: HtmlNode, attr: string ): boolean { return this.isEl( el ) && attr in el.attrs; }
	get( el: HtmlNode, attr: string ): string | undefined { return this.isEl( el ) ? el.attrs[ attr ] : undefined; }

	/** Concatenated text of the whole subtree, descendants included. */
	textOf( el: HtmlNode ): string {
		if ( !this.isEl( el ) ) return el.value;
		let out = '';
		for ( const k of el.kids ) out += k.type === 'text' ? k.value : this.textOf( k );
		return out;
	}

	/** Depth-first walk over element descendants ( text nodes skipped ). */
	walk( el: HtmlEl, fn: ( el: HtmlEl ) => void ): void {
		for ( const k of el.kids ) if ( this.isEl( k ) ) { fn( k ); this.walk( k, fn ); }
	}

	/** Self + every element descendant matching `pred`, in document order. */
	collect( el: HtmlNode, pred: ( el: HtmlEl ) => boolean ): HtmlEl[] {
		const out: HtmlEl[] = [];
		if ( this.isEl( el ) && pred( el ) ) out.push( el );
		if ( this.isEl( el ) ) this.walk( el, d => { if ( pred( d ) ) out.push( d ); } );
		return out;
	}

	/** First match of `pred` in the subtree, or null. */
	first( el: HtmlNode, pred: ( el: HtmlEl ) => boolean ): HtmlEl | null {
		return this.collect( el, pred )[ 0 ] ?? null;
	}

	/**
	 * Re-serialize an element's children back to an HTML string — the section-body payload.
	 * NORMALIZED, not byte-original: the source's incidental whitespace/quote style is not preserved.
	 * That is fine by ruling — the section body is the substrate-coupled half of the seam, free to
	 * change; parity is asserted on section NAMES / links / policy, never on body bytes.
	 */
	innerHtml( el: HtmlEl ): string {
		let out = '';
		for ( const k of el.kids ) out += this.serialize( k );
		return out.trim();
	}

	serialize( n: HtmlNode ): string {
		if ( n.type === 'text' ) return this.escapeText( n.value );
		const attrs = Object.entries( n.attrs )
			.map( ( [ k, v ] ) => v === '' ? ` ${ k }` : ` ${ k }="${ this.escapeAttr( v ) }"` )
			.join( '' );
		if ( this.VOID.has( n.tag ) ) return `<${ n.tag }${ attrs }>`;
		const kids = n.kids.map( k => this.serialize( k ) ).join( '' );
		return `<${ n.tag }${ attrs }>${ kids }</${ n.tag }>`;
	}

	// ── Lexer internals ──────────────────────────────────────────────────────────

	tagEnd( html: string, i: number ): number {
		let q: string | null = null;
		for ( let j = i + 1; j < html.length; j++ ) {
			const c = html[ j ];
			if ( q ) { if ( c === q ) q = null; continue; }
			if ( c === '"' || c === "'" ) q = c;
			else if ( c === '>' ) return j;
		}
		return html.length;
	}

	parseTag( inner: string ): { tag: string; attrs: Record<string, string> } {
		const m = inner.match( /^([a-zA-Z0-9:_-]+)/ );
		const tag = m ? m[ 1 ].toLowerCase() : '';
		const attrs: Record<string, string> = {};
		const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|(\S+)))?/g;
		let a: RegExpExecArray | null, first = true;
		while ( ( a = re.exec( inner ) ) !== null ) {
			if ( first ) { first = false; continue; }   // skip the tag name itself
			const raw = a[ 3 ] !== undefined ? a[ 3 ] : a[ 4 ] !== undefined ? a[ 4 ] : a[ 5 ];
			attrs[ a[ 1 ].toLowerCase() ] = raw === undefined ? '' : this.decode( raw );
		}
		return { tag, attrs };
	}

	decode( s: string ): string {
		return s
			.replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
			.replace( /&quot;/g, '"' ).replace( /&#39;/g, "'" ).replace( /&apos;/g, "'" )
			.replace( /&#(\d+);/g, ( _, d ) => String.fromCharCode( +d ) )
			.replace( /&amp;/g, '&' );
	}

	escapeText( s: string ): string { return s.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ); }
	escapeAttr( s: string ): string { return s.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ); }
}();
