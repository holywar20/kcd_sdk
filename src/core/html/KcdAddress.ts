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

export type FieldValidator = ( v: string ) => boolean;

export const KcdAddress = new class KcdAddress {

	// ── The closed sets ( protocol §2, §4 ) ──────────────────────────────────────
	TYPES        = [ 'lens', 'plan', 'reference', 'note', 'how-to', 'framework', 'template', 'nav-index', 'habit', 'contract', 'generator', 'analyzer' ];
	STATUSES     = [ 'draft', 'active', 'observation', 'composed', 'disabled', 'deployed', 'complete', 'retired', 'paused' ];
	AUDIENCES    = [ 'human', 'agent', 'both' ];
	MERGES       = [ 'additive', 'declarative', 'union' ];
	REGIONS      = [ 'know', 'care', 'do' ];
	SLOT_FIELDS  = [ 'what', 'where', 'why' ];
	PARAM_FIELDS = [ 'name', 'type', 'default', 'description' ];

	KNOWN_ATTRS = [
		'data-kcd', 'data-kcd-frontmatter', 'data-kcd-field', 'data-kcd-type',
		'data-kcd-region', 'data-kcd-section', 'data-kcd-merge', 'data-kcd-slot',
		'data-kcd-param', 'data-kcd-params', 'data-kcd-always', 'data-kcd-habit-class',
		'data-kcd-table', 'data-kcd-head', 'data-kcd-chips', 'data-kcd-tag',
		'data-kcd-audience', 'data-kcd-chrome', 'data-kcd-live', 'data-kcd-script'
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
		list:   () => true
	};

	isFieldType( declared: string | undefined ): declared is string { return !!declared && declared in this.FIELD; }
	validates( declared: string, value: string ): boolean { const f = this.FIELD[ declared ]; return !!f && f( value ); }

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

	// ── Value extraction ( the core law §1.1–§1.2: the field's content IS the value ) ──
	// Link fields ( an <a>, or a path/url type ) yield their href; everything else yields its text.
	fieldValue( el: HtmlEl, declared: string | undefined ): { isLink: boolean; value: string } {
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
