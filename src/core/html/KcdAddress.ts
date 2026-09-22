/**
 * KcdAddress — the addressing-contract vocabulary, defined ONCE.
 *
 * This is the closed `data-kcd-*` world from the KCD Document Protocol §1–§3, expressed as small
 * total functions over an HtmlTree node. It is the SHARED layer: KcdValidate asks it "is this a
 * conforming field?"; KcdParse asks it "what is this field's value?". The field-type validators
 * ( FIELD ) and the closed sets live here, not inside either head — the protocol's promise ( §1.6 )
 * that the same `data-kcd-type` vocabulary drives document validation AND the inline editor's
 * SettingField controls is only real if there is one definition.
 *
 * It owns NO policy ( "is `description` required?" is the validator's business ) — only the grammar:
 * what the components are, what a field's value IS, and whether a raw value satisfies its type.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { SLOT_MODES } from '../../primitives/types';
import type { SlotMode } from '../../primitives/types';

export type FieldValidator = ( v: string ) => boolean;

export const KcdAddress = new class KcdAddress {

	// ── The closed sets ( protocol §2, §4 ) ──────────────────────────────────────
	/** `note` and `how-to` were retired 2026-07-30 — they duplicated what the folder already says
	 *  ( see ArtifactType ). Twelve documents declared one; all became `reference`. */
	TYPES        = [ 'lens', 'plan', 'reference', 'framework', 'template', 'prompt-partial', 'nav-index', 'habit', 'contract', 'generator', 'analyzer', 'audit', 'bug-report' ];
	STATUSES     = [ 'draft', 'active', 'observation', 'composed', 'disabled', 'deployed', 'complete', 'retired', 'paused' ];
	AUDIENCES    = [ 'human', 'agent', 'both' ];
	MERGES       = [ 'additive', 'declarative', 'union' ];
	/** The Know / Care / Do tiers — INTERNAL now. No document carries a `data-kcd-region` wrapper any more
	 *  ( plan agents-own-behaviour, 2026-09-22 ); the projector still tags blocks with a tier to sort a
	 *  compile, and `KcdContext` derives it from the section. */
	REGIONS      = [ 'know', 'care', 'do' ];
	/** A lens's whole, closed section vocabulary: personality + philosophy + references. Behaviour — habits,
	 *  tools, contracts — belongs to the agent, and a lens that carries it is refused. */
	LENS_SECTIONS = [ 'personality', 'philosophy', 'references' ];
	SLOT_FIELDS  = [ 'what', 'where', 'why' ];
	PARAM_FIELDS = [ 'name', 'type', 'default', 'description' ];
	/** The one idiom every routable artifact ( reference, habit, contract, plan, anything else a
	 *  slot can point at ) shares. Absent on a slot ⇒ 'on', the default. DERIVED from `SLOT_MODES`
	 *  rather than restated: these were two independent literals until 2026-09-16, so the set the
	 *  validator graded against could drift from the set the parser read. */
	MODES: string[] = [ ...SLOT_MODES ];
	/** The §10 SEED modes — a completely separate vocabulary that happens to share the
	 *  `data-kcd-mode` attribute with slots above. `prepend` maintains a `<!-- kcd:begin/end -->`
	 *  block inside a host entry file; `create-only` writes the whole file and then never touches it
	 *  again. Absent ⇒ `prepend` ( see `VaultUtilities.parseSeedsFrom` ).
	 *
	 *  Closed and checked HERE because the parse casts the raw attribute straight to the union with no
	 *  check, and every miss folds to the `prepend` arm: a typo'd `create-only` does not fail, it
	 *  quietly does the other thing — on the one document the installer reads BEFORE a vault exists,
	 *  where nobody is watching. Two vocabularies on one attribute is the trap; naming both closes it. */
	SEED_MODES   = [ 'prepend', 'create-only' ];
	/** The closed slot-KIND vocabulary ( protocol §3 — `data-kcd-slot="<kind>"` ). Dredge roles
	 *  ( reference / habit / contract / tool / rule ) plus the non-dredge kinds ( `link` = a nav row
	 *  carrying an href, `table-data` = a plain faux-table row ); `domains` folds into `reference`.
	 *  Every slot MUST name one — a bare `data-kcd-slot` is invalid ( KcdValidate: `unkinded-slot` ). */
	SLOT_KINDS   = [ 'reference', 'habit', 'contract', 'tool', 'rule', 'link', 'table-data' ];

	/**
	 * THE FIELD NAMES A SLOT ROW IS ACTUALLY READ FROM — the one list the reader and the validator share.
	 *
	 * `what` / `where` / `why` are the faux-table's three columns. `rule` is a fourth NAME for the first of
	 * them: a rule row is a What with no Where and no Why, which is why it needs no second row shape and no
	 * second render path — see `KcdContext.readSlot`.
	 *
	 * It is here, beside `SLOT_KINDS`, because the alternative is what shipped: `readSlot` knew three names,
	 * the validator checked only that SOME field existed, and a `rule` cell satisfied the validator while
	 * projecting nothing. Seventy-eight authored rules across seven documents were invisible to every agent
	 * that loaded them, on pages that rendered correctly for a human and passed `validate_docs` clean. One list,
	 * read by both, is what stops a field name being legal to write and impossible to read.
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
		// The §10 host-seed idiom ( `root-context.html` ): a `<script type="text/kcd-md">` payload
		// plus WHICH host it is for and WHICH file it lands in. Absent here since the idiom was
		// written, which made the seed source — the one document the installer reads BEFORE a vault
		// exists — fail validation and stay invisible to scan / health / get.
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
	// An address is a location that MAY be occupied. Two value shapes, told apart by their own form:
	// an artifact NAME ( a slug — resolved through the same name index `base`/`lens` use, so it
	// survives any move ), or a project-root-relative PATH ( for targets that have no name ).
	// Well-formed means: no whitespace, not absolute, and no `../` chain — a `../` escapes the project
	// root, which is the one thing that can never resolve ( see `resolveHref` ).

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
	 * An address element's value. The visible TEXT is the address by default ( the core law's
	 * one-element-two-duties rule, with no machine copy ); the attribute carries it only when the
	 * prose has to read differently — the same escape hatch `href` already provides.
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
	 * A raw `data-kcd-mode` resolved against the closed slot set — `null` for absent AND for anything
	 * that is not a mode. Telling those two apart is the caller's business: the validator must not
	 * complain about an absent attribute, the parser must default it to `on`.
	 *
	 * THE ONLY READER, and that is the point. KcdParse and KcdValidate each held their own idea of the
	 * accepted set and fell in OPPOSITE directions on the same input — the parser demoted an
	 * unrecognised mode to `on` with no error at all, while the validator raised a hard `bad-mode` on
	 * it. A document could therefore pass one head and be quietly rewritten by the other. Reading
	 * through one function makes that disagreement unrepresentable.
	 */
	readMode( raw: string | undefined ): SlotMode | null {
		if ( !raw ) return null;
		return this.MODES.includes( raw ) ? raw as SlotMode : null;
	}

	/**
	 * A section's CROSS-ARTIFACT fusion key ( context-optimization plan, Phase 2 ) — deliberately a
	 * SEPARATE attribute from `data-kcd-merge`. That attribute is already load-bearing today as the
	 * intra-file duplicate-section-name dedup STRATEGY ( protocol §3, `additive|declarative|union` —
	 * ~35 files already write `data-kcd-merge="union"` on an unrelated `references` section each ).
	 * Reusing its value as a merge KEY would silently fuse every one of those unrelated sections
	 * together the moment two such artifacts loaded in the same context. `data-kcd-merge-key` is the
	 * new, orthogonal slot the plan actually needs; `data-kcd-merge` is untouched.
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
