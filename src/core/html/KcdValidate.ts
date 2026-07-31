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
import { VaultLayout } from '../VaultLayout';

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
	/** For a `list` field: the type EVERY chip must validate as. Absent = chips are free text
	 *  ( `tags`, `domain` ). Present = each chip is checked exactly as a scalar field of that type
	 *  would be, so a list does not become a hole in the validator. `lens` uses it: each entry names a
	 *  real lens, and an unhyphenated one ( `lens_crafter` ) is the same defect in a chip as in a slug. */
	itemType?:        string;
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
		// lens is a LIST, in invocation order — the lenses a session was wearing when it authored this.
		// Singular was a lie the corpus kept telling: real work is cross-lens, which is why 18 plans had
		// resorted to a fake lens named "cross" that named nothing and resolved to nothing. A list says
		// the true thing ( which lenses, and which led ) and the `cross` placeholder retires with it.
		// itemType keeps each entry under the same slug rules the scalar form enforced.
		lens:             { type: 'list', itemType: 'slug' },
		// todo / completed are ADDRESSES, not paths ( protocol §1.1 ). A lens declares WHERE its log
		// lives; it does not assert that one has been written. Most lenses name a log file that does
		// not exist yet, and that is a legal state rather than a defect.
		todo:             { type: 'address' },
		completed:        { type: 'address' }
	};

	/**
	 * Validate one artifact.
	 * @param input  an HTML string, a real DOM element/Document, or an already-normalized HtmlEl root.
	 */
	validate( input: string | HtmlEl | any, opts?: { path?: string } ): ValidateReport {
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
		this.checkAddressing( article, err, opts?.path );
		if ( rootType === 'habit' ) this.checkHabit( article, err, warn );

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
			if ( spec.type === 'list' ) { this.checkList( field, key, spec, err ); if ( key === 'name' ) name = HtmlTree.textOf( field ).trim(); continue; }

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

			// slot — kind required; collect habit-class; flag rows that carry no addressable field; mode constrained
			if ( KcdAddress.isSlot( el ) ) {
				// a slot's KIND is load-bearing now ( protocol §3 — the parser keys dredge role off it, not off
				// section position ). A bare `data-kcd-slot` is invalid, full stop: without a kind the row's
				// role is ambiguous and only survives by inference, which future kind-trusting code will misread.
				const kind = HtmlTree.get( el, 'data-kcd-slot' );
				if ( !kind )
					err( 'unkinded-slot', 'slot', `slot carries no kind — data-kcd-slot must name one of { ${ KcdAddress.SLOT_KINDS.join( ' | ' ) } }` );
				else if ( !KcdAddress.SLOT_KINDS.includes( kind ) )
					err( 'bad-slot-kind', `slot:${ kind }`, `slot kind "${ kind }" not in { ${ KcdAddress.SLOT_KINDS.join( ' | ' ) } }` );
				const hc = HtmlTree.get( el, 'data-kcd-habit-class' );
				if ( hc ) habitClasses[ hc ] = ( habitClasses[ hc ] ?? 0 ) + 1;
				if ( HtmlTree.collect( el, d => KcdAddress.isField( d ) ).length === 0 )
					err( 'unaddressed-slot', 'slot', 'slot row carries no data-kcd-field — its cells are invisible to the parser' );
				const mode = HtmlTree.get( el, 'data-kcd-mode' );
				if ( mode && !KcdAddress.MODES.includes( mode ) )
					err( 'bad-mode', `mode:${ mode }`, `mode must be one of { ${ KcdAddress.MODES.join( ' | ' ) } }` );
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

		// Care is a CLOSED section vocabulary — Purpose + Philosophy ( + Open Questions ). The retired
		// `core-mental-model` / `philosophy-prerogatives` slugs must not reappear.
		for ( const region of HtmlTree.collect( article, el => KcdAddress.isRegion( el ) && HtmlTree.get( el, 'data-kcd-region' ) === 'care' ) )
			for ( const sec of HtmlTree.collect( region, el => KcdAddress.isSection( el ) ) ) {
				const v = HtmlTree.get( sec, 'data-kcd-section' );
				if ( v && !KcdAddress.CARE_SECTIONS.includes( v ) )
					err( 'bad-care-section', `section:${ v }`, `Care section "${ v }" not in { ${ KcdAddress.CARE_SECTIONS.join( ' | ' ) } }` );
			}

		// composable-rule guard: one carrier ⇒ at most one slot per habit-class
		for ( const [ hc, n ] of Object.entries( habitClasses ) )
			if ( n > 1 ) err( 'dup-habit-class', `habit-class:${ hc }`, `${ n } slots share habit-class "${ hc }" — at most one per file ( §6 )` );
	}

	// ── Habit pass — the four-field contract ( see _habit_template ) ────────────────
	// `why` is REQUIRED ( the trigger; a habit with no why can't fire — renamed from `when`,
	// Bryan 2026-07-13, so the field matches the canonical What|Where|Why convention: it's the
	// same prose a lens's own Why cell can defer to via `mode:habit` ). `action` + `explanation` are
	// the dense-form body — warned-on when absent rather than hard-required, so a `don't`-style habit
	// ( rules, no action ) and an in-progress migration both still validate. `rules` is optional. EXTRA
	// sections ( format / example / homes / … ) are allowed — they ride only on a full on-demand read,
	// never in the dense projection, so the four-field shape doesn't forbid a habit from carrying more.
	checkHabit( article: HtmlEl, err: Emit, warn: Emit ): void {
		const names = new Set(
			HtmlTree.collect( article, el => KcdAddress.isSection( el ) )
				.map( el => HtmlTree.get( el, 'data-kcd-section' ) )
				.filter( ( v ): v is string => !!v )
		);
		if ( !names.has( 'why' ) )
			err( 'habit-no-why', 'section:why', 'a habit must declare a `why` section ( the trigger it fires on )' );
		if ( !names.has( 'action' ) && !names.has( 'rules' ) )
			warn( 'habit-no-behavior', 'section', 'a habit has neither an `action` nor a `rules` section — nothing to do' );
		if ( !names.has( 'explanation' ) )
			warn( 'habit-no-explanation', 'section:explanation', 'a habit has no `explanation` — the dense suggested form will carry no rationale' );
	}

	// ── Helpers ───────────────────────────────────────────────────────────────────
	// ── Addressing pass ( protocol §1.1 ) ─────────────────────────────────────────
	/**
	 * The link-versus-address law, enforced on the body.
	 *
	 * A link ASSERTS that a document is there. An address does not — it names a location that may be
	 * occupied now, later, or never. Two rules follow, and only one of them is about occupancy:
	 *
	 *  1. An address must be WELL-FORMED. Its occupancy is never checked here or anywhere else;
	 *     vacancy is a legal state and reporting it would recreate the noise the primitive removes.
	 *  2. A link may never point into ephemeral space. Those directories are not installed into a
	 *     user's vault at all, so the assertion a link makes is false by construction — regardless of
	 *     whether the target happens to exist on the authoring machine.
	 */
	checkAddressing( article: HtmlEl, err: Emit, selfPath?: string ): void {
		// The ban binds LIBRARY artifacts only. A document that itself lives in ephemeral space never
		// ships either, so its links to its own neighbourhood assert nothing false. Without the path we
		// cannot tell, and the safe default is to check — an unknown document is treated as shippable.
		const selfEphemeral = selfPath !== undefined && VaultLayout.isEphemeralHref( selfPath );
		for ( const el of HtmlTree.collect( article, d => KcdAddress.isAddress( d ) ) ) {
			const value = KcdAddress.addressOf( el );
			if ( !KcdAddress.isAddressValue( value ) )
				err( 'bad-address', 'address', `"${ value }" is not a well-formed address — expected an artifact name or a project-root-relative path, with no "../" and no absolute root` );
		}

		if ( selfEphemeral ) return;

		for ( const a of HtmlTree.collect( article, d => d.tag === 'a' && HtmlTree.has( d, 'href' ) ) ) {
			const href = ( HtmlTree.get( a, 'href' ) ?? '' ).trim();
			if ( href === '' || href.startsWith( '#' ) || href.includes( '{' ) ) continue;
			if ( /^(?:https?:)?\/\//.test( href ) || /^mailto:/.test( href ) )   continue;
			if ( VaultLayout.isEphemeralHref( href ) )
				err( 'ephemeral-link', 'address', `"${ href }" links into ephemeral space ( ${ VaultLayout.ephemeralDirs().join( ', ' ) } ), which is not installed into a vault — use <code data-kcd-address> instead` );
		}
	}

	checkList( field: HtmlEl, key: string, spec: FieldSpec, err: Emit ): void {
		const tags = HtmlTree.collect( field, el => KcdAddress.isTag( el ) );
		for ( const t of tags ) {
			const value = HtmlTree.textOf( t ).trim();
			if ( value === '' ) { err( 'empty-tag', `field:${ key }`, 'empty chip in a list field' ); continue; }
			if ( !spec.itemType ) continue;   // free-text chips ( tags, domain )

			// A typed list gets the SAME checks the scalar form would get — the two rules below are the
			// ones lifted from the scalar path verbatim, so making a field a list can never quietly
			// relax it. The chip's own text is the value ( a chip is never a link ).
			if ( !KcdAddress.validates( spec.itemType, value ) )
				err( 'bad-value', `field:${ key }`, `"${ value }" is not a valid ${ spec.itemType }` );
			if ( spec.itemType === 'slug' ) {
				const fix = this.slugUnderscore( value );
				if ( fix ) err( 'underscore-slug', `field:${ key }`, `"${ value }" has internal underscores — slugs are hyphenated ( use "${ fix }" )` );
			}
		}
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
