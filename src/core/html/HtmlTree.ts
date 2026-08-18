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
 * Node shape:  { type:'el', tag, attrs:{}, kids:[ … ], start?, end? }  |  { type:'text', value }
 *
 * `parse()` also records each element's source span ( `start`/`end` — byte offsets into the input
 * string ), so a caller can splice a node's exact span out of the original source without a lossy
 * re-serialize ( KcdExcise, the delete-cascade surgeon ). `fromDOM()` has no source, so those are
 * absent on renderer-built trees — span-based edits are a Node-side ( string-source ) operation.
 *
 * `parse()` is the placeholder MiniHtml reader, ported verbatim from the dev-utilities validator so
 * the substrate is proven. It handles the subset KCD docs use: nested elements, quoted attributes,
 * comments, doctype, void elements, and raw <script>/<style>.
 */

export type HtmlNode = HtmlEl | HtmlText;

export interface HtmlEl   { type: 'el';   tag: string; attrs: Record<string, string>; kids: HtmlNode[]; start?: number; end?: number; }
export interface HtmlText { type: 'text'; value: string; }

export const HtmlTree = new class HtmlTree {

	VOID = new Set( [ 'meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'col', 'area', 'base', 'wbr' ] );
	RAW  = new Set( [ 'script', 'style' ] );

	/**
	 * Elements that live INSIDE a line of text. Everything not named here is treated as block-level and
	 * gets its own line when `serialize` pretty-prints.
	 *
	 * The set is deliberately the inline one rather than the block one: the block vocabulary is open
	 * ( `section`, `article`, `figure`, and every `div` a document invents ), while the inline
	 * vocabulary is small and closed. Guessing wrong about a block costs a newline nobody sees;
	 * guessing wrong about an inline WELDS OR SPLITS WORDS — `</strong> <code>` collapsing to
	 * `canonical:_Claude` is the defect the parser's own whitespace rule already exists to prevent.
	 * So the safe default is "block", and this list is what opts out.
	 */
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
				// A whitespace-only run between two INLINE elements ( `</strong> <code>` ) is a significant
				// space — dropping it welds words together ( "canonical:_Claude" ). Collapse it to a single
				// space rather than discarding it. In BLOCK context that lone space renders to nothing
				// ( `KcdContext.inline` trims it away ), so keeping it is safe there. A truly empty run adds
				// nothing.
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

	/**
	 * Re-serialize an element's children back to an HTML string — the section-body payload.
	 * NORMALIZED, not byte-original: the source's incidental whitespace/quote style is not preserved.
	 * That is fine by ruling — the section body is the substrate-coupled half of the seam, free to
	 * change; parity is asserted on section NAMES / links / policy, never on body bytes.
	 *
	 * PRETTY-PRINTED since 2026-08-17. It used to concatenate with no separator at all, which — since
	 * `parse` collapses every whitespace-only run to a single space and `serialize` emitted no
	 * newlines — flattened each document onto ONE PHYSICAL LINE. A 6KB body on line 11 was the
	 * standing example. The cost was not cosmetic: `KcdSynth` built carefully indented markup and
	 * `KcdEmit.spliceFrontmatter` re-parsed it through here in the same call and discarded the
	 * formatting, so the two halves of one pipeline undid each other; and every diff of an
	 * agent-written document was one unreadable line.
	 */
	innerHtml( el: HtmlEl, indent: string = '' ): string {
		const kids = el.kids.filter( k => !this.isBlank( k ) );
		if ( !kids.length ) return '';
		const sep = kids.some( k => !this.isInline( k ) ) ? '\n' + indent : '';
		return kids.map( k => this.serialize( k, indent ) ).join( sep ).trim();
	}

	/** A text node that is only whitespace — `parse` emits these as a single space to keep adjacent
	 *  inline elements from welding. They carry no content, so a block layout drops them and rebuilds
	 *  the spacing structurally; an INLINE run keeps them, which is the whole reason they exist. */
	isBlank( n: HtmlNode ): boolean {
		return n.type === 'text' && n.value.trim() === '';
	}

	/** Text, or an element from the closed inline set. Anything else is block-level. */
	isInline( n: HtmlNode ): boolean {
		return n.type === 'text' || this.INLINE.has( n.tag );
	}

	/**
	 * Node tree → HTML string. The inverse of `parse`, and the two must agree on every text path or a
	 * save corrodes what it did not touch — see `HtmlTree.entities.test.ts` for the seam this locks.
	 */
	serialize( n: HtmlNode, indent: string = '' ): string {
		if ( n.type === 'text' ) return this.escapeText( n.value );
		const attrs = Object.entries( n.attrs )
			.map( ( [ k, v ] ) => v === '' ? ` ${ k }` : ` ${ k }="${ this.escapeAttr( v ) }"` )
			.join( '' );
		if ( this.VOID.has( n.tag ) ) return `<${ n.tag }${ attrs }>`;

		// RAW content round-trips VERBATIM, because `parse` captured it verbatim — its RAW branch is the
		// one text path that skips `decode`, so escaping here adds a layer nothing ever removes. Same
		// rule as the entity seam: what parse leaves alone, serialize leaves alone.
		//
		// Not cosmetic. Protocol §10 seed payloads are markdown inside <script type="text/kcd-md">, and
		// `>` is markdown's blockquote character — escaped here, it is written into a real CLAUDE.md by
		// the next `daedalus seed`. The corruption is one-time and then stable, so nothing ever gets
		// visibly worse and nothing prompts a look.
		//
		// `RAW` is script/style ONLY. <pre> is deliberately not raw, and the double-escape trade pinned
		// in HtmlTree.entities.test.ts stays exactly as it is.
		if ( this.RAW.has( n.tag ) ) {
			const raw = n.kids.map( k => k.type === 'text' ? k.value : this.serialize( k ) ).join( '' );
			this.assertRawContainable( n.tag, raw );
			return `<${ n.tag }${ attrs }>${ raw }</${ n.tag }>`;
		}

		// `<pre>` is whitespace-SIGNIFICANT — reformatting it changes what the reader sees, so its
		// children are concatenated exactly as an inline run and never indented. It is deliberately not
		// in RAW ( see the double-escape trade pinned in HtmlTree.entities.test.ts ); this is the other
		// half of that decision.
		if ( n.tag === 'pre' )
			return `<${ n.tag }${ attrs }>${ n.kids.map( k => this.serialize( k ) ).join( '' ) }</${ n.tag }>`;

		// THE ONE RULE: an element breaks lines only when it actually CONTAINS a block child. A run of
		// text and inline elements is emitted exactly as it was, on one line, because whitespace between
		// inline nodes is rendered content — injecting a newline there splits or welds words. Whitespace
		// BETWEEN blocks renders to nothing, so it is free to use for structure.
		const kids = n.kids.filter( k => !this.isBlank( k ) );
		if ( !kids.some( k => !this.isInline( k ) ) )
			return `<${ n.tag }${ attrs }>${ n.kids.map( k => this.serialize( k ) ).join( '' ) }</${ n.tag }>`;

		const inner = indent + '\t';
		const body  = kids.map( k => inner + this.serialize( k, inner ) ).join( '\n' );
		return `<${ n.tag }${ attrs }>\n${ body }\n${ indent }</${ n.tag }>`;
	}

	/**
	 * REFUSE to emit a raw element that would terminate itself — the raw-text breakout.
	 *
	 * There is no escape hatch to reach for here, which is why this refuses rather than repairs: entity
	 * references are NOT decoded inside raw text, so writing `&lt;/script` would leave those literal
	 * characters in the payload — broken JS, broken markdown — while making the document look fixed.
	 * The content is unrepresentable in HTML, not merely awkward.
	 *
	 * Emitting it anyway is the dangerous outcome, not a cosmetic one: the element ends early on the next
	 * read and everything after it is re-tokenized as markup, so the document that comes back is a
	 * DIFFERENT TREE from the one written. That is the shape every raw-text injection takes.
	 *
	 * `parse` can never produce this ( its lexer ends the element at the first `</tag` ), so reaching
	 * here means a hand-built or DOM-sourced node — a bug in the caller, which is exactly what should
	 * fail loudly. Throwing is safe at this layer: the tool handlers above catch and return a structured
	 * refusal, so a malformed write is declined whole and nothing lands.
	 *
	 * The test is the LEXER'S OWN condition, deliberately — `parse` searches for a bare `'</' + tag`
	 * with no following-character check, so a stricter-than-spec reader and this guard agree by
	 * construction. Leaving a gap between what the writer permits and what the reader stops at is the
	 * affordance a breakout needs.
	 */
	assertRawContainable( tag: string, raw: string ): void {
		// Both sides folded here rather than trusting the caller's normalization — this is public, and a
		// guard that only works when its input was already lowercased is a guard with a quiet edge.
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

	/**
	 * Escaping is IDEMPOTENT — an `&` that already opens an entity reference ( `&mdash;`, `&#8212;`,
	 * `&amp;` ) is left alone; only a BARE `&` is escaped.
	 *
	 * This is the other half of `decode` above, and the two must agree. `decode` knows a handful of
	 * entities and passes every other one through as literal text; escaping every `&` unconditionally
	 * therefore added a layer to `&mdash;` on the first parse → serialize round trip ( `&amp;mdash;` ),
	 * and the document rendered the literal text to the reader. Every `kcd_save` runs that round trip —
	 * `KcdEmit.spliceFrontmatter` re-parses and re-serializes the whole body — so an unowned entity was
	 * corroded by any edit that touched the file. The rule is now symmetric: what decode leaves alone,
	 * escape leaves alone. Widening `decode` to a named-entity table is the alternative and is worse —
	 * there are thousands of them and the list would rot.
	 *
	 * `escapeAttr` carries the same rule for the same reason: attribute values are re-serialized by the
	 * identical round trip. The quoting guarantee is untouched — `"` is still escaped unconditionally,
	 * so a value can never break out of its attribute.
	 */
	escapeText( s: string ): string { return s.replace( /&(?!#?\w+;)/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ); }
	escapeAttr( s: string ): string { return s.replace( /&(?!#?\w+;)/g, '&amp;' ).replace( /"/g, '&quot;' ); }
}();
