/**
 * HtmlTree — the Node-free HTML substrate the parser family sits on. Both heads (KcdValidate, KcdParse) walk this tree;
 * neither re-implements HTML reading. `parse` (Node) and `fromDOM` (renderer) emit one node shape. Only `parse` records
 * source spans (`start`/`end`, for KcdExcise), so span-based edits are a Node-side operation.
 */

export type HtmlNode = HtmlEl | HtmlText;

export interface HtmlEl   { type: 'el';   tag: string; attrs: Record<string, string>; kids: HtmlNode[]; start?: number; end?: number; }
export interface HtmlText { type: 'text'; value: string; }

export const HtmlTree = new class HtmlTree {

	VOID = new Set( [ 'meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'col', 'area', 'base', 'wbr' ] );
	RAW  = new Set( [ 'script', 'style' ] );

	/** Elements inside a line of text; everything else pretty-prints as block. Guessing block wrong costs a newline,
	 *  guessing inline wrong welds or splits words, so the default is block and this list opts out. */
	INLINE = new Set( [
		'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img',
		'ins', 'kbd', 'label', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong',
		'sub', 'sup', 'time', 'u', 'var', 'wbr',
	] );

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
				// A whitespace-only run between two INLINE elements is a significant space: dropping it welds words together.
				// KcdContext.inline trims it away in block context, so keeping it there is safe.
				const value = text.trim() !== '' ? this.decode( text ) : ( text === '' ? '' : ' ' );
				if ( value ) top().kids.push( { type: 'text', value } );
				i = end;
				continue;
			}

			if ( html.startsWith( '<!--', i ) ) { const e = html.indexOf( '-->', i + 4 ); i = e < 0 ? html.length : e + 3; continue; }
			if ( html[ i + 1 ] === '!' )         { const e = html.indexOf( '>', i );       i = e < 0 ? html.length : e + 1; continue; }

			if ( html[ i + 1 ] === '/' ) {
				const e = html.indexOf( '>', i );
				const name = html.slice( i + 2, e < 0 ? html.length : e ).trim().toLowerCase();
				const closeEnd = e < 0 ? html.length : e + 1;
				// The matched element ( and any implicitly-closed children above it ) ends AT this close tag —
				// record each one's source end so a caller can splice its exact span ( KcdExcise ).
				for ( let s = stack.length - 1; s > 0; s-- ) if ( stack[ s ].tag === name ) {
					for ( let k = s; k < stack.length; k++ ) stack[ k ].end = closeEnd;
					stack.length = s;
					break;
				}
				i = closeEnd;
				continue;
			}

			const tagStart = i;
			const e = this.tagEnd( html, i );
			const inner = html.slice( i + 1, e ).trim();
			const selfClose = inner.endsWith( '/' );
			const { tag, attrs } = this.parseTag( selfClose ? inner.slice( 0, -1 ) : inner );
			// start = the '<'; provisional end = end of the open tag ( final for void/self-close; a
			// container's end is overwritten when its close tag is reached above ).
			const el: HtmlEl = { type: 'el', tag, attrs, kids: [], start: tagStart, end: e + 1 };
			top().kids.push( el );
			i = e + 1;

			if ( selfClose || this.VOID.has( tag ) ) continue;

			if ( this.RAW.has( tag ) ) {
				const close = html.toLowerCase().indexOf( '</' + tag, i );
				const end   = close < 0 ? html.length : close;
				if ( html.slice( i, end ) !== '' ) el.kids.push( { type: 'text', value: html.slice( i, end ) } );
				const gt = html.indexOf( '>', end );
				el.end = gt < 0 ? html.length : gt + 1;
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

	/** Re-serialize an element's children to HTML. NORMALIZED, not byte-original: parity is asserted on section
	 *  NAMES, links and policy, never on body bytes. */
	innerHtml( el: HtmlEl, indent: string = '' ): string {
		const kids = el.kids.filter( k => !this.isBlank( k ) );
		if ( !kids.length ) return '';
		const sep = kids.some( k => !this.isInline( k ) ) ? '\n' + indent : '';
		return kids.map( k => this.serialize( k, indent ) ).join( sep ).trim();
	}

	/** A whitespace-only text node. `parse` emits these to keep adjacent inline elements from welding; a block layout
	 *  drops them, and only an INLINE run keeps them. */
	isBlank( n: HtmlNode ): boolean {
		return n.type === 'text' && n.value.trim() === '';
	}

	/** Text, or an element from the closed inline set. Anything else is block-level. */
	isInline( n: HtmlNode ): boolean {
		return n.type === 'text' || this.INLINE.has( n.tag );
	}

	/** Node tree → HTML string, the inverse of `parse`. The two must agree on every text path, or a save corrodes
	 *  what it did not touch (see `HtmlTree.entities.test.ts`). */
	serialize( n: HtmlNode, indent: string = '' ): string {
		if ( n.type === 'text' ) return this.escapeText( n.value );
		const attrs = Object.entries( n.attrs )
			.map( ( [ k, v ] ) => v === '' ? ` ${ k }` : ` ${ k }="${ this.escapeAttr( v ) }"` )
			.join( '' );
		if ( this.VOID.has( n.tag ) ) return `<${ n.tag }${ attrs }>`;

		// RAW content round-trips VERBATIM: `parse` skips `decode` there, so escaping would corrupt markdown inside
		// <script type="text/kcd-md"> — its `>` is blockquote syntax. `RAW` is script/style ONLY; <pre> is not raw.
		if ( this.RAW.has( n.tag ) ) {
			const raw = n.kids.map( k => k.type === 'text' ? k.value : this.serialize( k ) ).join( '' );
			this.assertRawContainable( n.tag, raw );
			return `<${ n.tag }${ attrs }>${ raw }</${ n.tag }>`;
		}

		// `<pre>` is whitespace-SIGNIFICANT: its children are concatenated as an inline run, never indented.
		// It is deliberately not in RAW (see `HtmlTree.entities.test.ts`).
		if ( n.tag === 'pre' )
			return `<${ n.tag }${ attrs }>${ n.kids.map( k => this.serialize( k ) ).join( '' ) }</${ n.tag }>`;

		// An element breaks lines only when it CONTAINS a block child: whitespace between inline nodes is rendered
		// content, so a newline there would split or weld words. Whitespace between blocks renders to nothing.
		const kids = n.kids.filter( k => !this.isBlank( k ) );
		if ( !kids.some( k => !this.isInline( k ) ) )
			return `<${ n.tag }${ attrs }>${ n.kids.map( k => this.serialize( k ) ).join( '' ) }</${ n.tag }>`;

		const inner = indent + '\t';
		const body  = kids.map( k => inner + this.serialize( k, inner ) ).join( '\n' );
		return `<${ n.tag }${ attrs }>\n${ body }\n${ indent }</${ n.tag }>`;
	}

	/** REFUSE a raw element that would end itself: raw text has no entity escaping, so there is no repair, and emitting it
	 *  reparses as a different tree. Uses the LEXER'S OWN condition, so writer and reader agree by construction. */
	assertRawContainable( tag: string, raw: string ): void {
		// Folded here: this is public, and a guard that trusts lowercased input has a quiet edge.
		if ( !raw.toLowerCase().includes( '</' + tag.toLowerCase() ) ) return;
		throw new Error(
			`HtmlTree.serialize: <${ tag }> content contains "</${ tag }", which cannot be represented ` +
			`inside a raw text element — the emitted document would reparse into a different tree. ` +
			`Raw text has no entity escaping, so this must be split at the source ( in JS, "<\\/${ tag }" ).`
		);
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

	/** Escaping is IDEMPOTENT: an `&` opening an entity is left alone, as `decode` leaves it. A save round-trips the body
	 *  here, so an unowned `&mdash;` would corrode. Quotes are always escaped, so an attribute cannot break out. */
	escapeText( s: string ): string { return s.replace( /&(?!#?\w+;)/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ); }
	escapeAttr( s: string ): string { return s.replace( /&(?!#?\w+;)/g, '&amp;' ).replace( /"/g, '&quot;' ); }
}();
