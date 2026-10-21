/**
 * KcdSynth — content in, conforming body HTML out ( parser-family, the synthesis direction ).
 * An author supplies content ( section name → prose, plus slot rows ); the markup is derived from `KcdShapes`:
 * section order from the table, heading depth from nesting, a `phase-2` placed inside `phases` by its parent's `nests` glob.
 * This owns SHAPE, not conformance: `KcdValidate` stays the only gate, so synthesis cannot become a second authority.
 * Prose is escaped unless it already opens with a block tag, so unrecognized input is never injected — except
 * for a small closed allowlist of INLINE tags ( `PROSE_INLINE_TAGS` ), which is the one vocabulary authored
 * prose may carry as real markup, and the one every description of this path is generated from.
 */

import { HtmlTree } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdShapes } from './KcdShapes';
import type { SectionSpec } from './KcdShapes';

/** One slot row — the addressable cells a faux-table record carries ( protocol §3 ). */
export interface SynthRow {
	what:   string;
	/** A vault-root-relative path. Emitted as a real `href` so the parser resolves it as a link. */
	where?: string;
	why?:   string;
	/** `off` | `on` | `load`. Absent ⇒ the slot's default. */
	mode?:  string;
	/** Composable-rule carrier; at most one slot per class per file ( §6 ). */
	habitClass?: string;
}

/** Rows destined for one slot-bearing section. `kind` defaults to the shape's declared kind. */
export interface SynthSlots {
	section: string;
	kind?:   string;
	rows:    SynthRow[];
}

/** What an author hands in. Everything except `title` is optional. */
export interface SynthInput {
	/** The document's `<h1>`. Falls back to the artifact name. */
	title?:    string;
	/** One line under the title, rendered as a blockquote — the artifact's own summary. */
	summary?:  string;
	/** Section name → body. Prose, or already-authored HTML. Unknown names are REPORTED, not dropped
	 *  silently — see `synthesize`'s return. */
	sections?: Record<string, string>;
	/** Rows for slot-bearing sections. */
	slots?:    SynthSlots[];
}

/** What synthesis produced, plus what it could not place. */
export interface SynthResult {
	body: string;
	/** Names the shape neither declares nor nests. Still EMITTED, since an open type legitimately carries them; a caller may warn on a closed type. */
	undeclared: string[];
}

/** Block-level tags that mark a body as already-authored HTML rather than plain text. */
const BLOCK_START = /^\s*<(p|div|ul|ol|section|table|pre|blockquote|h[1-6]|dl|figure)\b/i;

/** A section body that opens with its own heading — the author has titled it. */
const AUTHORED_HEADING = /^\s*<h[1-6]\b/i;

/**
 * Comment syntax in prose is STRIPPED, not escaped: comments are a human channel that agents neither read nor write,
 * and an authored body drops them at parse, so both input paths yield nothing. Not a security control.
 */
const COMMENT_SYNTAX = /<!--[\s\S]*?-->/g;

/**
 * THE INLINE ALLOWLIST — the one declaration of what authored prose may carry as real markup, and the source
 * every advertisement of it is built from. The escaper reads it, the markdown advisories below build their
 * right-hand side from it, and `save_doc`'s own `sections` description is generated from
 * `KcdSynth.inlineTagList()`. BUG-74 was this file promising a vocabulary a hundred lines from the code that
 * escaped it, so the set is declared ONCE and nothing restates it in prose.
 *
 * TEXT MAKE-UP ONLY — emphasis, code, links. Nothing structural, nothing that can carry script or style,
 * nothing that opens a block. The four members are exactly what the three markdown advisories promise, which
 * is the whole point of the set.
 *
 * WHAT WAS CONSIDERED AND LEFT OUT, each on its own argument:
 *  • `<b>` / `<i>` — presentational twins of `strong` / `em` carrying no meaning of their own. Two spellings
 *    of one thing is the drift this set exists to prevent, and an author told `<strong>` needs nothing else.
 *  • `<br>` — a void tag, so it cannot be balance-checked the way every other member is, and breaking a line
 *    is a decision this path already makes from blank lines and `- ` lines. A second, finer line break is a
 *    structural control wearing inline clothes.
 *  • `<span>` — carries nothing on its own. It is useful only with `class` or `style`, which is precisely
 *    what is forbidden here, so admitting it would be either pointless or the hole.
 *
 * A MEMBER'S VALUE IS ITS PERMITTED ATTRIBUTES, and an empty list means the tag takes none. `<a>` takes
 * `href` and nothing else — no `onclick`, no `style`, no `target`. An attribute outside the list refuses the
 * WHOLE tag, which then goes back to being the text it looks like.
 */
export const PROSE_INLINE_TAGS: Readonly<Record<string, readonly string[]>> = {
	strong: [],
	em:     [],
	code:   [],
	a:      [ 'href' ],
};

/** The only schemes an allowlisted `href` may NAME. A scheme-less href — a vault-relative path, the common
 *  case — is fine; one that names a scheme must name one of these, so `javascript:` and `data:` are refused
 *  by the rule rather than by a list of bad names somebody has to keep current. */
const HREF_SCHEMES = new Set( [ 'http', 'https', 'mailto' ] );

const INLINE_NAMES = Object.keys( PROSE_INLINE_TAGS ).join( '|' );

/** An allowlisted open tag, and nothing looser: the name, then only double-quoted attributes whose values
 *  carry no `<`, `>` or `"`, then `>`. Anything else that starts with `<` is not a tag here. */
const INLINE_OPEN = new RegExp( `^<(${ INLINE_NAMES })((?:\\s+[a-zA-Z-]+\\s*=\\s*"[^"<>]*")*)\\s*>`, 'i' );

const INLINE_CLOSE = new RegExp( `^</(${ INLINE_NAMES })\\s*>`, 'i' );

/** Any HTML-looking tag, open or close, allowlisted or not — used ONLY to NAME what the escaper is about to
 *  refuse, for a warning. It decides nothing about what is kept; `INLINE_OPEN` / `INLINE_CLOSE` alone decide
 *  that, earlier in the same scan. */
const GENERIC_TAG = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*>/;

/** One piece of a block mid-escape. `tag` is `''` for plain text; `html` is the canonical re-emission, built
 *  from the parsed parts rather than from `raw`, and used only once `keep` is set. */
interface InlineToken {
	tag:  string;
	open: boolean;
	raw:  string;
	html: string;
	keep: boolean;
}

/** One allowlisted tag as an author is TOLD it — `<strong>`, `<a href>`. The attribute list is part of the
 *  advertisement, so permitting one shows up in the advice with no second edit. Null for a tag the set does
 *  not hold, so nothing can advertise what the escaper would refuse. */
function advertise( tag: string ): string | null {
	const attrs = PROSE_INLINE_TAGS[ tag ];
	return attrs ? `<${ [ tag, ...attrs ].join( ' ' ) }>` : null;
}

/**
 * Markdown an author probably meant to be interpreted, which prose emission renders literally — paired with
 * the allowlisted tag that DOES work. `tag` names a member of the set rather than spelling the fix out, so a
 * row whose tag leaves the allowlist leaves the advice with it.
 */
const MARKDOWN_TELLS: { probe: RegExp; from: string; tag: string }[] = [
	{ probe: /\*\*\S[^*]*\*\*/,         from: '**bold**',       tag: 'strong' },
	{ probe: /`[^`\n]+`/,               from: '`code`',         tag: 'code' },
	{ probe: /\[[^\]\n]+\]\([^)\s]+\)/, from: '[text](target)', tag: 'a' },
].filter( t => t.tag in PROSE_INLINE_TAGS );

export const KcdSynth = new class KcdSynth {

	/**
	 * Build a body from content. The orchestrator — every real decision is delegated, so this stays
	 * readable and each step is testable on its own.
	 */
	synthesize( type: string, input: SynthInput ): SynthResult {
		const provided  = input.sections ?? {};
		const slotsBy   = this.indexSlots( input.slots );
		const undeclared = this.undeclaredOf( type, Object.keys( provided ) );

		const parts: string[] = [];
		parts.push( `<h1>${ HtmlTree.escapeText( input.title ?? type ) }</h1>` );
		if ( input.summary ) parts.push( `<blockquote>\n\t<p>${ HtmlTree.escapeText( input.summary ) }</p>\n</blockquote>` );

		const shape = KcdShapes.shapeFor( type );

		if ( shape?.regions ) {
			for ( const region of shape.regions ) {
				const inner = region.sections
					.map( spec => this.renderSection( spec, provided, slotsBy, 3 ) )
					.filter( Boolean );
				if ( inner.length ) parts.push( this.regionEl( region.name, inner.join( '\n' ) ) );
			}
		}
		else {
			for ( const spec of KcdShapes.sectionsFor( type ) ) {
				const html = this.renderSection( spec, provided, slotsBy, 2 );
				if ( html ) parts.push( html );
			}
		}

		// Undeclared sections ride at the end, in the author's order: an open type uses them for real content, so they are never dropped.
		for ( const name of undeclared )
			parts.push( this.sectionEl( name, this.bodyFor( name, provided, slotsBy, undefined ), 2 ) );

		return { body: parts.join( '\n\n' ), undeclared };
	}

	// ── Placement ─────────────────────────────────────────────────────────────────

	/** Rows keyed by their target section, so section rendering is a lookup rather than a scan. */
	indexSlots( slots: SynthSlots[] | undefined ): Record<string, SynthSlots> {
		const out: Record<string, SynthSlots> = {};
		for ( const s of slots ?? [] ) out[ s.section ] = s;
		return out;
	}

	/** Provided names that the shape neither declares nor nests. Order-preserving. */
	undeclaredOf( type: string, names: string[] ): string[] {
		const declared = new Set( KcdShapes.orderFor( type ) );
		return names.filter( n => !declared.has( n ) && !KcdShapes.isNestedChild( type, n ) );
	}

	/** Nested children in NUMERIC order ( `phase-2` before `phase-10` ), never the caller's order. */
	childrenOf( parent: SectionSpec, provided: Record<string, string> ): string[] {
		if ( !parent.nests ) return [];
		return Object.keys( provided )
			.filter( n => KcdShapes.globMatches( parent.nests!, n ) )
			.sort( ( a, b ) => this.naturalCompare( a, b ) );
	}

	/** Compare two names treating digit runs as numbers ( `phase-2` &lt; `phase-10` ). */
	naturalCompare( a: string, b: string ): number {
		const split = ( s: string ) => s.match( /\d+|\D+/g ) ?? [];
		const pa = split( a ), pb = split( b );

		for ( let i = 0; i < Math.max( pa.length, pb.length ); i++ ) {
			const x = pa[ i ], y = pb[ i ];
			if ( x === undefined ) return -1;
			if ( y === undefined ) return 1;

			const nx = /^\d/.test( x ), ny = /^\d/.test( y );
			if ( nx && ny ) {
				const d = Number( x ) - Number( y );
				if ( d !== 0 ) return d;
			}
			else if ( x !== y ) return x < y ? -1 : 1;
		}
		return 0;
	}

	/** Every supplied section, prose and slot-addressed alike. Slot-bearing sections arrive as rows, not `sections`, so auditing prose keys alone misreports them absent. */
	suppliedSections( input: SynthInput ): string[] {
		const names = Object.keys( input.sections ?? {} );
		for ( const s of input.slots ?? [] )
			if ( s.rows.length && !names.includes( s.section ) ) names.push( s.section );
		return names;
	}

	/**
	 * Advisories on markup in prose that will render literally. Advice, not conversion: interpreting `**bold**` would mint
	 * a markdown dialect to maintain. Sections that are already authored HTML are skipped.
	 */
	proseWarnings( input: SynthInput ): string[] {
		const out: string[] = [];

		for ( const [ name, text ] of Object.entries( input.sections ?? {} ) ) {
			if ( !text || BLOCK_START.test( text.trim() ) ) continue;
			const hits = MARKDOWN_TELLS.filter( t => t.probe.test( text ) ).map( t => `${ t.from } → ${ advertise( t.tag ) }` );
			if ( hits.length )
				out.push( `markdown in section "${ name }": ${ hits.join( ', ' ) } — markdown is not interpreted, so these render as literal characters; the tag named beside each is honoured in prose.` );
		}
		return out;
	}

	/**
	 * Advisories on STRUCTURAL markup `proseToHtml` entity-escaped without saying so — the silent half of
	 * BUG-74 ( filed as BUG-134 ). A `<table>` an author meant as real structure renders as literal angle
	 * brackets and nothing downstream notices; this names what was lost, per section, so the author can
	 * reach for the `body` path instead. Escaping itself is unchanged and still the default — this only
	 * reports it. A section already authored as HTML, or carrying none of the inline allowlist's tags
	 * either, produces no warning.
	 */
	escapedTagWarnings( input: SynthInput ): string[] {
		const out: string[] = [];

		for ( const [ name, text ] of Object.entries( input.sections ?? {} ) ) {
			if ( !text ) continue;
			const escaped = new Set<string>();
			this.proseToHtml( text, escaped );
			if ( escaped.size )
				out.push( `section "${ name }": escaped ${ [ ...escaped ].map( t => `<${ t }>` ).join( ', ' ) } — a section needing structure must use the body path` );
		}
		return out;
	}

	/** The inline allowlist as an author is told it, in declaration order — what every description of this
	 *  path renders, so no face writes the list out by hand. */
	inlineTagList(): string[] {
		return Object.keys( PROSE_INLINE_TAGS ).map( t => advertise( t ) as string );
	}

	// ── Rendering ─────────────────────────────────────────────────────────────────

	/** One declared section, or `''` when the author supplied nothing: an empty section would trip `empty-section`, and the required-tier check owns absence. */
	renderSection( spec: SectionSpec, provided: Record<string, string>, slotsBy: Record<string, SynthSlots>, depth: number ): string {
		const children = this.childrenOf( spec, provided );
		const body     = this.bodyFor( spec.name, provided, slotsBy, spec.slot );
		if ( !body && !children.length ) return '';

		const childHtml = children
			.map( name => this.sectionEl( name, this.bodyFor( name, provided, slotsBy, undefined ), depth + 1 ) )
			.join( '\n' );

		return this.sectionEl( spec.name, [ body, childHtml ].filter( Boolean ).join( '\n' ), depth );
	}

	/** A section's inner HTML: its slot table if it carries rows, otherwise its prose. */
	bodyFor( name: string, provided: Record<string, string>, slotsBy: Record<string, SynthSlots>, declaredKind: string | undefined ): string {
		const slots = slotsBy[ name ];
		if ( slots && slots.rows.length ) return this.slotTable( slots.kind ?? declaredKind ?? 'table-data', slots.rows );

		const text = provided[ name ];
		return text ? this.proseToHtml( text ) : '';
	}

	/** `<section data-kcd-section>` with its heading; depth sets the heading level only. Authored HTML that opens with a heading gets no second one. */
	sectionEl( name: string, inner: string, depth: number ): string {
		const level   = Math.min( Math.max( depth, 2 ), 6 );
		const heading = AUTHORED_HEADING.test( inner )
			? ''
			: `\t<h${ level } data-kcd-heading>${ HtmlTree.escapeText( this.headingFor( name ) ) }</h${ level }>\n`;
		return `<section data-kcd-section="${ HtmlTree.escapeAttr( name ) }">\n`
			+ heading
			+ this.indent( inner )
			+ `\n</section>`;
	}

	/** Lens-only Know/Care/Do wrapper ( protocol §4 ). */
	regionEl( name: string, inner: string ): string {
		return `<section data-kcd-region="${ HtmlTree.escapeAttr( name ) }">\n`
			+ `\t<h2 data-kcd-heading>${ HtmlTree.escapeText( this.headingFor( name ) ) }</h2>\n`
			+ this.indent( inner )
			+ `\n</section>`;
	}

	/** A faux-table of slot rows. Never a real `<table>` — the validator refuses canonical fields
	 *  inside one, because a `<table>` may hold non-canonical chrome only. */
	slotTable( kind: string, rows: SynthRow[] ): string {
		const body = rows.map( r => this.slotRow( kind, r ) ).join( '\n' );
		return `<div data-kcd-table>\n${ this.indent( body ) }\n</div>`;
	}

	/**
	 * One `<div data-kcd-slot="kind">`. `where` is emitted as a real `href` rather than text —
	 * a link cell carrying only text round-trips as an empty link and the validator flags it.
	 */
	slotRow( kind: string, row: SynthRow ): string {
		const attrs = [ `data-kcd-slot="${ HtmlTree.escapeAttr( this.kindOrDefault( kind ) ) }"` ];
		if ( row.mode )       attrs.push( `data-kcd-mode="${ HtmlTree.escapeAttr( row.mode ) }"` );
		if ( row.habitClass ) attrs.push( `data-kcd-habit-class="${ HtmlTree.escapeAttr( row.habitClass ) }"` );

		const cells = [ `<span data-kcd-field="what" data-kcd-type="text">${ HtmlTree.escapeText( row.what ) }</span>` ];
		if ( row.where ) cells.push( `<a data-kcd-field="where" data-kcd-type="path" href="${ HtmlTree.escapeAttr( row.where ) }">${ HtmlTree.escapeText( this.labelFor( row.where ) ) }</a>` );
		if ( row.why )   cells.push( `<span data-kcd-field="why" data-kcd-type="text">${ HtmlTree.escapeText( row.why ) }</span>` );

		return `<div ${ attrs.join( ' ' ) }>\n${ this.indent( cells.join( '\n' ) ) }\n</div>`;
	}

	// ── Text ──────────────────────────────────────────────────────────────────────

	/** Plain text → paragraphs and `- ` lists; authored HTML passes through. Anything outside the inline
	 *  allowlist is ESCAPED, so a stray `<` cannot open a tag. */
	proseToHtml( text: string, escaped?: Set<string> ): string {
		// Comments come off BEFORE the markup test, so a block that merely opens with one is still
		// recognized as authored HTML rather than escaped wholesale.
		const trimmed = text.replace( COMMENT_SYNTAX, '' ).trim();
		if ( !trimmed ) return '';
		if ( BLOCK_START.test( trimmed ) ) return trimmed;

		return trimmed
			.split( /\n\s*\n/ )
			.map( block => this.blockToHtml( block.trim(), escaped ) )
			.filter( Boolean )
			.join( '\n' );
	}

	/** One paragraph-or-list block. Both paths escape through `escapeInline`, never one through it and the
	 *  other not: where a run of prose happens to sit decided whether its markup survived, which is the
	 *  defect ( BUG-74 ) rather than a feature of lists. */
	blockToHtml( block: string, escaped?: Set<string> ): string {
		if ( !block ) return '';
		const lines = block.split( '\n' ).map( l => l.trim() ).filter( Boolean );

		if ( lines.length && lines.every( l => l.startsWith( '- ' ) ) ) {
			const items = lines.map( l => `\t<li>${ this.escapeInline( l.slice( 2 ).trim(), escaped ) }</li>` ).join( '\n' );
			return `<ul>\n${ items }\n</ul>`;
		}
		return `<p>${ this.escapeInline( lines.join( ' ' ), escaped ) }</p>`;
	}

	/**
	 * Escape a run of prose, letting the inline allowlist through as real markup. ESCAPING IS STILL THE
	 * DEFAULT and the allowlist is the exception: every character that is not part of an admitted tag goes
	 * through `escapeText` exactly as before, so a stray `<`, a `<script`, an attribute that was not
	 * permitted and an unbalanced allowlisted tag all render as the text they are.
	 *
	 * Two passes, because balance cannot be judged one tag at a time: tokenize, then pair. A tag is emitted
	 * only when it is paired, so the output is balanced BY CONSTRUCTION — an unclosed `<strong>` cannot
	 * escape its paragraph and swallow the document's structure.
	 */
	escapeInline( text: string, escaped?: Set<string> ): string {
		const tokens = this.inlineTokens( text, escaped );
		this.pairInline( tokens );
		return tokens.map( t => t.keep ? t.html : HtmlTree.escapeText( t.raw ) ).join( '' );
	}

	/** Split prose into text and candidate inline tags. A `<` that does not open an admitted tag is consumed
	 *  as ONE character of text and scanning carries on from the next, so the remainder of a refused tag is
	 *  escaped as the text it is rather than skipped. */
	inlineTokens( text: string, escaped?: Set<string> ): InlineToken[] {
		const out: InlineToken[] = [];
		let plain = '';
		const flush = (): void => {
			if ( plain ) out.push( { tag: '', open: false, raw: plain, html: '', keep: false } );
			plain = '';
		};

		for ( let i = 0; i < text.length; ) {
			if ( text[ i ] !== '<' ) { plain += text[ i ]; i += 1; continue; }

			const rest  = text.slice( i );
			const close = INLINE_CLOSE.exec( rest );
			if ( close ) {
				const tag = close[ 1 ]!.toLowerCase();
				flush();
				out.push( { tag, open: false, raw: close[ 0 ], html: `</${ tag }>`, keep: false } );
				i += close[ 0 ].length;
				continue;
			}

			const open = INLINE_OPEN.exec( rest );
			const html = open ? this.inlineOpenHtml( open[ 1 ]!.toLowerCase(), open[ 2 ] ?? '' ) : null;
			if ( open && html !== null ) {
				flush();
				out.push( { tag: open[ 1 ]!.toLowerCase(), open: true, raw: open[ 0 ], html, keep: false } );
				i += open[ 0 ].length;
				continue;
			}

			// Neither an admitted open nor close — what the escaper is about to refuse. Record the NAME for a
			// warning only; the consumption below ( one character, unchanged ) is what decides the escaped output.
			if ( escaped ) {
				const generic = GENERIC_TAG.exec( rest );
				if ( generic ) escaped.add( generic[ 1 ]!.toLowerCase() );
			}

			plain += text[ i ];
			i += 1;
		}
		flush();
		return out;
	}

	/**
	 * The canonical form of an allowlisted open tag, or null when it carries anything not permitted — which
	 * refuses the whole tag rather than stripping the offending part, because a tag an author wrote wrong
	 * should read back as what they wrote.
	 *
	 * RE-EMITTED FROM THE PARSED ATTRIBUTES, never from the author's raw text: the value is decoded and then
	 * re-escaped through `escapeAttr`, so nothing can break out of a quote it wrote itself.
	 */
	inlineOpenHtml( tag: string, attrText: string ): string | null {
		const permitted = PROSE_INLINE_TAGS[ tag ];
		if ( !permitted ) return null;

		const seen: string[] = [];
		const attrs: string[] = [];
		const re = /([a-zA-Z-]+)\s*=\s*"([^"<>]*)"/g;
		let m: RegExpExecArray | null;
		while ( ( m = re.exec( attrText ) ) !== null ) {
			const name = m[ 1 ]!.toLowerCase();
			// Not permitted, or said twice — a repeated attribute has two values and no rule about which wins.
			if ( !permitted.includes( name ) || seen.includes( name ) ) return null;
			const value = HtmlTree.decode( m[ 2 ]! );
			if ( name === 'href' && !this.hrefAllowed( value ) ) return null;
			seen.push( name );
			attrs.push( `${ name }="${ HtmlTree.escapeAttr( value ) }"` );
		}
		// `href` is not optional on an anchor: the advertised form is `<a href>`, and a link with no target is
		// an empty link the validator flags.
		if ( tag === 'a' && !seen.includes( 'href' ) ) return null;

		return `<${ [ tag, ...attrs ].join( ' ' ) }>`;
	}

	/**
	 * Whether an `href` may be emitted at all. Scheme-less passes — a vault-relative path is the common case
	 * — and one that NAMES a scheme must name a permitted one, so `javascript:` and `data:` are refused by
	 * the rule rather than by a blocklist.
	 *
	 * The probe is deliberately paranoid, because the browser is: numeric AND hex entities are decoded and
	 * every space and control character removed before the scheme is read, so `&#x6a;avascript:` and
	 * `java&#9;script:` refuse exactly as the plain spelling does. The probe only DECIDES; what is emitted is
	 * the plainly decoded value. A legitimate path loses nothing, and one that reads like a drive letter
	 * ( `C:/x` ) is refused and renders as text — vault links are vault-relative.
	 */
	hrefAllowed( href: string ): boolean {
		// No vault path carries these, and they are the characters an attribute break-out needs.
		if ( /[<>"]/.test( href ) ) return false;
		const probe = href
			.replace( /&#x([0-9a-f]+);?/gi, ( _, h: string ) => String.fromCharCode( parseInt( h, 16 ) ) )
			.replace( /&#(\d+);?/g, ( _, d: string ) => String.fromCharCode( Number( d ) ) )
			.replace( /[\s\u0000-\u001f\u007f]/g, '' )
			.toLowerCase();
		const scheme = /^([a-z][a-z0-9+.-]*):/.exec( probe );
		return !scheme || HREF_SCHEMES.has( scheme[ 1 ]! );
	}

	/** Mark the tags that may stand: a close pairs with the NEAREST unclosed open of the same name, and an
	 *  open with no close — or a close with no open, or a mis-nested pair — is not a tag and goes back to
	 *  being text. Nothing searches deeper than the top of the stack, which is what makes the kept set
	 *  provably balanced. */
	pairInline( tokens: InlineToken[] ): void {
		const open: InlineToken[] = [];
		for ( const token of tokens ) {
			if ( !token.tag ) continue;
			if ( token.open ) { open.push( token ); continue; }

			const opener = open[ open.length - 1 ];
			if ( !opener || opener.tag !== token.tag ) continue;

			open.pop();
			opener.keep = true;
			token.keep  = true;
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────────

	/** `current-state` → `Current State`. Hyphens out, words capitalized. */
	headingFor( name: string ): string {
		return name.split( '-' ).map( w => w ? w[ 0 ].toUpperCase() + w.slice( 1 ) : w ).join( ' ' );
	}

	/** A link's display label — the artifact's short name, per the base lens's link rule. */
	labelFor( href: string ): string {
		const last = href.split( '/' ).pop() ?? href;
		return last.replace( /\.html?$/i, '' );
	}

	/** An unknown slot kind falls back to the one kind that carries no dredge role, rather than
	 *  emitting a value the validator would reject outright. */
	kindOrDefault( kind: string ): string {
		return KcdAddress.SLOT_KINDS.includes( kind ) ? kind : 'table-data';
	}

	indent( html: string ): string {
		return html.split( '\n' ).map( l => l ? `\t${ l }` : l ).join( '\n' );
	}
}();
