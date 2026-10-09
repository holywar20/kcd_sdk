/**
 * KcdAddress — the addressing-contract vocabulary, defined ONCE and shared by both heads: KcdValidate asks
 * "is this a conforming field?", KcdParse asks "what is this field's value?". The FIELD validators and the closed
 * sets live here, not in either head, so `data-kcd-type` drives validation and the editor's SettingField controls alike.
 * It owns NO policy ("is `description` required?" is the validator's business) — only the grammar.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { SLOT_MODES } from '../../primitives/types';
import type { SlotMode } from '../../primitives/types';

export type FieldValidator = ( v: string ) => boolean;

export const KcdAddress = new class KcdAddress {

	// ── The closed sets ( protocol §2, §4 ) ──────────────────────────────────────
	/** Removing a type from this list is the sharp edge: a root type absent here makes `KcdParse.parse` THROW
	 *  (`unknown-type`), so retire one only once no document still declares it. */
	TYPES        = [ 'lens', 'plan', 'reference', 'framework', 'template', 'prompt-partial', 'nav-index', 'habit', 'contract', 'generator', 'analyzer', 'bug-report' ];
	STATUSES     = [ 'draft', 'active', 'observation', 'composed', 'disabled', 'deployed', 'complete', 'retired', 'paused' ];
	AUDIENCES    = [ 'human', 'agent', 'both' ];
	MERGES       = [ 'additive', 'declarative', 'union' ];
	/** The Know / Care / Do tiers are INTERNAL — `KcdContext` derives one from the section, never from a wrapper. */
	REGIONS      = [ 'know', 'care', 'do' ];
	/** A lens's whole, closed section vocabulary: personality + philosophy + references. Behaviour — habits,
	 *  tools, contracts — belongs to the agent, and a lens that carries it is refused. */
	LENS_SECTIONS = [ 'personality', 'philosophy', 'references' ];
	SLOT_FIELDS  = [ 'what', 'where', 'why' ];
	PARAM_FIELDS = [ 'name', 'type', 'default', 'description' ];
	/** The one idiom every routable artifact shares. Absent on a slot ⇒ 'on'.
	 *  Derived from `SLOT_MODES`, not restated: two independent literals let the validator and parser drift. */
	MODES: string[] = [ ...SLOT_MODES ];
	/** A second vocabulary on `data-kcd-mode` (§10 seeds; absent ⇒ `prepend`). Closed here: the parse casts unchecked,
	 *  and every miss folds to `prepend`, so a typo'd `create-only` silently does the other thing. */
	SEED_MODES   = [ 'prepend', 'create-only' ];
	/** The closed slot-KIND vocabulary (protocol §3). `domains` folds into `reference`.
	 *  Every slot MUST name one — a bare `data-kcd-slot` is invalid (KcdValidate: `unkinded-slot`). */
	SLOT_KINDS   = [ 'reference', 'habit', 'contract', 'tool', 'rule', 'link', 'table-data' ];

	/**
	 * The field names a slot row is READ from, shared by reader and validator: a legal field must be a readable one.
	 * `rule` is a fourth name for `what` (no Where, no Why) — see `KcdContext.readSlot`.
	 */
	ROW_FIELDS   = [ 'what', 'where', 'why', 'rule' ];

	/** The names that can supply a row's TEXT. A row carrying only `where` renders as a bare route. */
	ROW_TEXT     = [ 'what', 'rule' ];

	KNOWN_ATTRS = [
		'data-kcd', 'data-kcd-frontmatter', 'data-kcd-field', 'data-kcd-type',
		'data-kcd-region', 'data-kcd-section', 'data-kcd-heading', 'data-kcd-merge', 'data-kcd-merge-key', 'data-kcd-slot',
		'data-kcd-param', 'data-kcd-params', 'data-kcd-mode', 'data-kcd-habit-class',
		'data-kcd-table', 'data-kcd-head', 'data-kcd-chips', 'data-kcd-tag',
		'data-kcd-audience', 'data-kcd-chrome', 'data-kcd-live', 'data-kcd-script',
		'data-kcd-address',
		// The §10 host-seed idiom: a `<script type="text/kcd-md">` payload naming its host and target file.
		// Must be listed here, or the seed source fails validation and goes invisible to scan / health / get.
		'data-kcd-seed', 'data-kcd-target'
	];

	// ── Patterns ──────────────────────────────────────────────────────────────────
	// slug: kebab, optional single leading `_` sort-prefix ( `_lens-base` ); internal `_` is illegal.
	SLUG_RE   = /^_?[a-z0-9]+(?:-[a-z0-9]+)*$/;
	DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
	NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
	URL_RE    = /^(?:https?:)?\/\/\S+$/;

	// ── Field-type validators ( the SettingField-shared vocabulary, protocol §1.6 ) ──
	FIELD: Record<string, FieldValidator> = {
		text:   () => true,
		slug:   v => v === '' || this.SLUG_RE.test( v ),
		enum:   v => v !== '' && !/\s/.test( v ),
		number: v => this.NUMBER_RE.test( v ),
		date:   v => this.DATE_RE.test( v ),
		path:   v => v !== '',
		url:    v => this.URL_RE.test( v ),
		list:   () => true,
		// address ( protocol §1.1 ): a LOCATION, not an assertion that anything occupies it. Checked for
		// well-formedness only — occupancy is never validated, because vacancy is a legal state.
		address: v => v === '' || this.isAddressValue( v )
	};

	isFieldType( declared: string | undefined ): declared is string { return !!declared && declared in this.FIELD; }
	validates( declared: string, value: string ): boolean { const f = this.FIELD[ declared ]; return !!f && f( value ); }

	// ── Addresses ( protocol §1.1 ) ────────────────────────────────────────────────
	// A location that MAY be occupied: an artifact NAME (a slug, survives moves) or a root-relative PATH.
	// Well-formed means no whitespace, not absolute, and no `../` — which escapes the project root and can never resolve.

	/** A `../` segment anywhere in the value — the shape that cannot resolve from the project root. */
	DOTDOT_RE = /(?:^|\/)\.\.(?:\/|$)/;

	isAddressValue( v: string ): boolean {
		if ( v === '' || /\s/.test( v ) )               return false;
		if ( this.SLUG_RE.test( v ) )                   return true;    // an artifact name
		if ( v.startsWith( '/' ) || /^[A-Za-z]:/.test( v ) ) return false;    // absolute
		if ( this.DOTDOT_RE.test( v ) )                 return false;    // escapes the project root
		return true;                                                     // project-root-relative path
	}

	isAddress( el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-address' ); }

	/**
	 * The visible TEXT is the address by default; `data-kcd-address` overrides it only when the prose must read
	 * differently — the same escape hatch `href` provides.
	 */
	addressOf( el: HtmlEl ): string {
		const attr = HtmlTree.get( el, 'data-kcd-address' );
		return ( attr !== undefined && attr !== '' ? attr : HtmlTree.textOf( el ) ).trim();
	}

	// ── Component predicates ( protocol §2 ) ───────────────────────────────────────
	isArticle(     el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd' ); }
	isFrontmatter( el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-frontmatter' ); }
	isRegion(      el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-region' ); }
	isSection(     el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-section' ); }
	isSlot(        el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-slot' ); }
	isParam(       el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-param' ); }
	isField(       el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-field' ); }
	isTag(         el: HtmlEl ): boolean { return HtmlTree.has( el, 'data-kcd-tag' ); }

	/** This element's audience, default `both` ( protocol §5 — the dual-extraction strip control ). */
	audienceOf( el: HtmlEl ): string { return HtmlTree.get( el, 'data-kcd-audience' ) ?? 'both'; }
	isHumanOnly( el: HtmlEl ): boolean { return this.audienceOf( el ) === 'human'; }

	/**
	 * A raw `data-kcd-mode` against the closed slot set: `null` for absent AND for a non-mode; callers tell them apart.
	 * THE ONLY READER: the parser and validator must never disagree about a mode, so both read through here.
	 */
	readMode( raw: string | undefined ): SlotMode | null {
		if ( !raw ) return null;
		return this.MODES.includes( raw ) ? raw as SlotMode : null;
	}

	/**
	 * A section's cross-artifact fusion key, deliberately SEPARATE from `data-kcd-merge`: that attribute is the
	 * intra-file dedup strategy, and reusing its value would silently fuse unrelated sections loaded together.
	 */
	mergeKeyOf( el: HtmlEl ): string | undefined { return HtmlTree.get( el, 'data-kcd-merge-key' ); }

	// ── Value extraction ( the core law §1.1–§1.2: the field's content IS the value ) ──
	// Link fields ( an <a>, or a path/url type ) yield their href; everything else yields its text.
	fieldValue( el: HtmlEl, declared: string | undefined ): { isLink: boolean; value: string } {
		// `address` is never a link, even on an <a> — an address asserts no occupancy, so it cannot
		// take its value from an href without becoming the very thing it exists to replace.
		if ( declared === 'address' ) return { isLink: false, value: this.addressOf( el ) };
		const isLink = el.tag === 'a' || declared === 'path' || declared === 'url';
		if ( !isLink ) return { isLink: false, value: HtmlTree.textOf( el ).trim() };
		let href = HtmlTree.get( el, 'href' );
		if ( href === undefined ) { const a = HtmlTree.first( el, d => d.tag === 'a' && HtmlTree.has( d, 'href' ) ); href = a ? HtmlTree.get( a, 'href' ) : ''; }
		return { isLink: true, value: ( href ?? '' ).trim() };
	}

	/** A field's ( key, declaredType, value ) triple — the unit both heads read. */
	readField( el: HtmlEl ): { key: string; declared: string | undefined; value: string; isLink: boolean } {
		const key = HtmlTree.get( el, 'data-kcd-field' ) ?? '';
		const declared = HtmlTree.get( el, 'data-kcd-type' );
		const { isLink, value } = this.fieldValue( el, declared );
		return { key, declared, value, isLink };
	}

	/** The chip texts of a `list`-type field ( <ul data-kcd-chips><li data-kcd-tag>… ). */
	chipsOf( el: HtmlEl ): string[] {
		return HtmlTree.collect( el, d => this.isTag( d ) ).map( t => HtmlTree.textOf( t ).trim() ).filter( v => v !== '' );
	}
}();
