/**
 * KcdValidate — the binary, file-level, all-or-nothing enforcement of the KCD Document Protocol.
 *
 * Ported from the dev-utilities reference validator ( `_Claude/dev-utilities/kcd-validate.js` ) and
 * re-based onto the shared substrate: its node reader IS `HtmlTree`, and its `data-kcd-*` grammar —
 * the field-type validators and the closed sets — now lives in `KcdAddress`. This file keeps only
 * VALIDATION POLICY: which frontmatter fields are required, and the structural rules. One vocabulary,
 * two heads ( this and `KcdParse` ).
 *
 * It is BINARY: a file conforms or it does not. ANY non-conformance ⇒ the WHOLE file is invalid and
 * must be discarded ( never partially parsed ). A document is not `active` until it validates — that
 * is what keeps malformed data out of the system. TEMPLATES are exempt ( scaffolds carry
 * placeholders; template-aware validation is a deferred follow-up ).
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl, HtmlNode } from './HtmlTree';
import { KcdAddress } from './KcdAddress';

export interface ValidateIssue { code: string; where: string; msg: string; }
export interface ValidateReport { ok: boolean; type: string | null; name: string | null; errors: ValidateIssue[]; warnings: ValidateIssue[]; }

type Emit = ( code: string, where: string, msg: string ) => void;

interface FieldSpec {
	required?:        boolean;
	type:             string;
	nonEmpty?:        boolean;
	maxLen?:          number;
	oneOf?:           string[];
	pattern?:         RegExp;
	emptyOkForType?:  string;
}

export const KcdValidate = new class KcdValidate {

	AUTHOR_RE = /^.+\s<[^\s@]+@[^\s@]+\.[^\s@]+>$/;        // Name <email>
	SCOPE_RE  = /^(?:universal|lens:[a-z0-9-]+)$/;

	// ── Frontmatter spec ( tier + expected type + per-field extras ) ──────────────
	FRONTMATTER: Record<string, FieldSpec> = {
		name:             { required: true,  type: 'slug' },   // plus nameOk() extras ( ≤64, no claude/anthropic )
		description:      { required: true,  type: 'text', nonEmpty: true, maxLen: 1024 },
		type:             { required: true,  type: 'enum' },
		status:           { required: true,  type: 'enum', oneOf: KcdAddress.STATUSES, emptyOkForType: 'template' },
		'schema-version': { type: 'text' },
		author:           { type: 'text', pattern: this.AUTHOR_RE },
		updated:          { type: 'date' },
		created:          { type: 'date' },
		audience:         { type: 'enum', oneOf: KcdAddress.AUDIENCES },
		tags:             { type: 'list' },
		domain:           { type: 'list' },
		origin:           { type: 'slug' },
		hash:             { type: 'text' },
		base:             { type: 'slug' },
		'dredge-depth':   { type: 'number' },
		scope:            { type: 'enum', pattern: this.SCOPE_RE },
		'habit-class':    { type: 'slug' },
		lens:             { type: 'slug' },
		todo:             { type: 'path' },
		completed:        { type: 'path' }
	};

	/**
	 * Validate one artifact.
	 * @param input  an HTML string, a real DOM element/Document, or an already-normalized HtmlEl root.
	 */
	validate( input: string | HtmlEl | any ): ValidateReport {
		const root: HtmlEl =
			typeof input === 'string'              ? HtmlTree.parse( input )   :
			input && input.nodeType !== undefined  ? HtmlTree.fromDOM( input ) :
			input as HtmlEl;

		const errors: ValidateIssue[] = [], warnings: ValidateIssue[] = [];
		const err: Emit  = ( code, where, msg ) => { errors.push( { code, where, msg } ); };
		const warn: Emit = ( code, where, msg ) => { warnings.push( { code, where, msg } ); };

		// ── Root: exactly one artifact, a known type ──
		const articles = HtmlTree.collect( root, el => KcdAddress.isArticle( el ) );
		if ( articles.length === 0 ) { err( 'no-root', 'document', 'no <article data-kcd="…"> root found' ); return this.result( null, null, errors, warnings ); }
		if ( articles.length > 1 )   err( 'multi-root', 'document', `${ articles.length } artifact roots; exactly one per file` );

		const article = articles[ 0 ];
		const rootType = HtmlTree.get( article, 'data-kcd' )!;
		if ( rootType === 'utility' )                err( 'utility-dropped', 'data-kcd', 'utility is not a document type — it is declarative code ( UtilityObject )' );
		else if ( !KcdAddress.TYPES.includes( rootType ) ) err( 'unknown-type', 'data-kcd', `unknown artifact type "${ rootType }"` );

		// templates are scaffolds — placeholders + embedded target-type structure are expected ⇒ EXEMPT.
		if ( rootType === 'template' ) return this.result( rootType, null, errors, warnings );

		const name = this.checkFrontmatter( article, rootType, err, warn );
		this.checkStructure( article, rootType, err, warn );

		return this.result( rootType, name, errors, warnings );
	}

	// ── Frontmatter pass ──────────────────────────────────────────────────────────
	checkFrontmatter( article: HtmlEl, rootType: string, err: Emit, _warn: Emit ): string | null {
		const blocks = HtmlTree.collect( article, el => KcdAddress.isFrontmatter( el ) );
		if ( blocks.length === 0 ) { err( 'no-frontmatter', 'frontmatter', 'missing <dl data-kcd-frontmatter>' ); return null; }
		if ( blocks.length > 1 )   err( 'multi-frontmatter', 'frontmatter', 'more than one frontmatter block' );

		const fm = blocks[ 0 ];
		const seen: Record<string, boolean> = {};
		let name: string | null = null;

		for ( const field of HtmlTree.collect( fm, el => KcdAddress.isField( el ) ) ) {
			const key = HtmlTree.get( field, 'data-kcd-field' )!;
			const declared = HtmlTree.get( field, 'data-kcd-type' );
			const spec = this.FRONTMATTER[ key ];

			if ( !declared )                            err( 'no-type', `field:${ key }`, `field "${ key }" has no data-kcd-type` );
			else if ( !KcdAddress.isFieldType( declared ) ) err( 'bad-type', `field:${ key }`, `unknown data-kcd-type "${ declared }"` );

			if ( !spec ) { err( 'unknown-field', `field:${ key }`, `frontmatter field "${ key }" is not in the locked set` ); continue; }
			seen[ key ] = true;

			// list fields are structural ( chips ); everything else is a scalar value
			if ( spec.type === 'list' ) { this.checkList( field, key, err ); if ( key === 'name' ) name = HtmlTree.textOf( field ).trim(); continue; }

			const { value } = KcdAddress.fieldValue( field, declared ?? spec.type );
			if ( key === 'name' ) name = value;

			// empty required
			if ( spec.required && value === '' ) {
				const okEmpty = spec.emptyOkForType && rootType === spec.emptyOkForType;
				if ( !okEmpty ) err( 'empty-required', `field:${ key }`, `required field "${ key }" is empty` );
				continue;
			}
			if ( value === '' ) continue;   // optional + empty ⇒ fine ( e.g. reserved origin )

			// validate value against the EXPECTED type ( not just the declared one )
			if ( !KcdAddress.validates( spec.type, value ) ) err( 'bad-value', `field:${ key }`, `"${ value }" is not a valid ${ spec.type }` );

			// dedicated: slug values are hyphenated — internal underscores ( e.g. lens_crafter ) are a
			// migration artifact. Reported separately from bad-value so the fix is spelled out.
			if ( spec.type === 'slug' ) { const fix = this.slugUnderscore( value ); if ( fix ) err( 'underscore-slug', `field:${ key }`, `"${ value }" has internal underscores — slugs are hyphenated ( use "${ fix }" )` ); }

			// per-field extras
			if ( spec.oneOf && !spec.oneOf.includes( value ) )    err( 'not-allowed', `field:${ key }`, `"${ value }" not in { ${ spec.oneOf.join( ' | ' ) } }` );
			if ( spec.pattern && !spec.pattern.test( value ) )    err( 'bad-format', `field:${ key }`, `"${ value }" does not match the expected form` );
			if ( spec.maxLen && value.length > spec.maxLen )      err( 'too-long', `field:${ key }`, `"${ key }" exceeds ${ spec.maxLen } chars` );
			if ( key === 'name' && !this.nameOk( value ) )        err( 'bad-name', 'field:name', `"${ value }" must be kebab-case, ≤64 chars, no "claude"/"anthropic"` );
			if ( key === 'type' && value !== rootType )           err( 'type-mismatch', 'field:type', `frontmatter type "${ value }" ≠ root data-kcd "${ rootType }"` );
			if ( declared && spec.type !== declared )             err( 'type-drift', `field:${ key }`, `declared type "${ declared }" ≠ expected "${ spec.type }"` );
		}

		for ( const [ key, spec ] of Object.entries( this.FRONTMATTER ) )
			if ( spec.required && !seen[ key ] ) err( 'missing-required', `field:${ key }`, `required frontmatter field "${ key }" is absent` );

		return name;
	}

	// ── Structure pass ──────────────────────────────────────────────────────────
	checkStructure( article: HtmlEl, rootType: string, err: Emit, _warn: Emit ): void {
		const habitClasses: Record<string, number> = {};

		// frontmatter fields are validated above — skip them here so the generic field check only
		// re-covers faux-table cells ( no double-reporting ).
		const fmBlock = HtmlTree.collect( article, el => KcdAddress.isFrontmatter( el ) )[ 0 ];
		const fmFields = new Set<HtmlNode>( fmBlock ? HtmlTree.collect( fmBlock, el => KcdAddress.isField( el ) ) : [] );

		HtmlTree.walk( article, el => {
			// a real <table> is allowed as non-canonical chrome, but must NOT carry canonical fields
			if ( el.tag === 'table' ) {
				const carries = HtmlTree.collect( el, d => HtmlTree.has( d, 'data-kcd-field' ) || HtmlTree.has( d, 'data-kcd-slot' ) || HtmlTree.has( d, 'data-kcd-param' ) ).length > 0;
				if ( carries ) err( 'table-carries-fields', 'table', 'canonical fields inside a <table> — use a faux-table ( a real <table> may only hold non-canonical chrome )' );
			}

			// unknown data-kcd-* attributes
			for ( const a of Object.keys( el.attrs ) )
				if ( a.startsWith( 'data-kcd' ) && !KcdAddress.KNOWN_ATTRS.includes( a ) )
					err( 'unknown-attr', a, `"${ a }" is not in the closed attribute set` );

			// region — lens-only; value constrained; no empties
			if ( KcdAddress.isRegion( el ) ) {
				const v = HtmlTree.get( el, 'data-kcd-region' )!;
				if ( !KcdAddress.REGIONS.includes( v ) ) err( 'bad-region', `region:${ v }`, `region must be one of { ${ KcdAddress.REGIONS.join( ' | ' ) } }` );
				if ( rootType !== 'lens' )               err( 'region-non-lens', `region:${ v }`, 'regions are lens-only' );
				if ( this.isEmptyContainer( el ) )       err( 'empty-region', `region:${ v }`, 'empty region — omit it ( no empty containers )' );
			}

			// section — named merge key; no empties; merge constrained
			if ( KcdAddress.isSection( el ) ) {
				const v = HtmlTree.get( el, 'data-kcd-section' )!;
				if ( !v )                          err( 'unnamed-section', 'section', 'section has an empty name' );
				if ( this.isEmptyContainer( el ) ) err( 'empty-section', `section:${ v }`, 'empty section — omit it ( no empty containers )' );
				const merge = HtmlTree.get( el, 'data-kcd-merge' );
				if ( merge && !KcdAddress.MERGES.includes( merge ) ) err( 'bad-merge', `section:${ v }`, `merge must be one of { ${ KcdAddress.MERGES.join( ' | ' ) } }` );
			}

			// slot — collect habit-class; flag rows that carry no addressable field
			if ( KcdAddress.isSlot( el ) ) {
				const hc = HtmlTree.get( el, 'data-kcd-habit-class' );
				if ( hc ) habitClasses[ hc ] = ( habitClasses[ hc ] ?? 0 ) + 1;
				if ( HtmlTree.collect( el, d => KcdAddress.isField( d ) ).length === 0 )
					err( 'unaddressed-slot', 'slot', 'slot row carries no data-kcd-field — its cells are invisible to the parser' );
			}

			// param — should carry the four typed cells
			if ( KcdAddress.isParam( el ) ) {
				const fields = HtmlTree.collect( el, d => KcdAddress.isField( d ) ).map( d => HtmlTree.get( d, 'data-kcd-field' ) );
				for ( const need of KcdAddress.PARAM_FIELDS )
					if ( !fields.includes( need ) ) err( 'param-missing-cell', 'param', `param row missing "${ need }" cell` );
			}

			// every data-kcd-field anywhere must type-check ( covers faux-table cells )
			if ( KcdAddress.isField( el ) && !fmFields.has( el ) ) {
				const key = HtmlTree.get( el, 'data-kcd-field' )!;
				const declared = HtmlTree.get( el, 'data-kcd-type' );
				if ( !declared )                            err( 'no-type', `cell:${ key }`, `cell "${ key }" has no data-kcd-type` );
				else if ( !KcdAddress.isFieldType( declared ) ) err( 'bad-type', `cell:${ key }`, `unknown data-kcd-type "${ declared }"` );
				else {
					const { isLink, value } = KcdAddress.fieldValue( el, declared );
					if ( isLink && value === '' )                          err( 'empty-link', `cell:${ key }`, `link cell "${ key }" has no href` );
					else if ( value !== '' && !KcdAddress.validates( declared, value ) ) err( 'bad-value', `cell:${ key }`, `"${ value }" is not a valid ${ declared }` );
					if ( declared === 'slug' ) { const fix = this.slugUnderscore( value ); if ( fix ) err( 'underscore-slug', `cell:${ key }`, `"${ value }" has internal underscores — slugs are hyphenated ( use "${ fix }" )` ); }
				}
			}
		} );

		// composable-rule guard: one carrier ⇒ at most one slot per habit-class
		for ( const [ hc, n ] of Object.entries( habitClasses ) )
			if ( n > 1 ) err( 'dup-habit-class', `habit-class:${ hc }`, `${ n } slots share habit-class "${ hc }" — at most one per file ( §6 )` );
	}

	// ── Helpers ───────────────────────────────────────────────────────────────────
	checkList( field: HtmlEl, key: string, err: Emit ): void {
		const tags = HtmlTree.collect( field, el => KcdAddress.isTag( el ) );
		for ( const t of tags ) if ( HtmlTree.textOf( t ).trim() === '' ) err( 'empty-tag', `field:${ key }`, 'empty chip in a list field' );
	}

	nameOk( v: string ): boolean { return v.length <= 64 && KcdAddress.SLUG_RE.test( v ) && !/claude|anthropic/i.test( v ); }

	// slug hygiene: internal underscores ( `lens_crafter` ) are illegal — return the hyphenated
	// suggestion, or null if clean. The leading `_` sort-prefix ( `_lens-base` ) is preserved.
	slugUnderscore( value: string ): string | null {
		if ( !/[a-z0-9]_[a-z0-9]/.test( value ) ) return null;
		return value.replace( /([a-z0-9])_([a-z0-9])/g, '$1-$2' );
	}

	isEmptyContainer( el: HtmlEl ): boolean {
		if ( HtmlTree.textOf( el ).trim() !== '' ) return false;
		return HtmlTree.collect( el, d => d !== el && ( HtmlTree.has( d, 'data-kcd-field' ) || HtmlTree.has( d, 'data-kcd-slot' ) || HtmlTree.has( d, 'data-kcd-param' ) ) ).length === 0;
	}

	result( type: string | null, name: string | null, errors: ValidateIssue[], warnings: ValidateIssue[] ): ValidateReport {
		return { ok: errors.length === 0, type, name, errors, warnings };
	}
}();
