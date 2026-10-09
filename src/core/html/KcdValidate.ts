/**
 * KcdValidate — the binary, all-or-nothing enforcement of the KCD Document Protocol. Policy only: which
 * frontmatter fields are required, and the structural rules. The grammar lives in KcdAddress. One vocabulary,
 * two heads ( this and `KcdParse` ).
 *
 * ANY non-conformance ⇒ the WHOLE file is invalid and discarded, never partially parsed. A document is
 * not `active` until it validates. TEMPLATES are exempt: scaffolds carry placeholders.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl, HtmlNode } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdShapes } from './KcdShapes';
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
	/** The type EVERY chip of a `list` field must validate as; absent = free-text chips ( `tags`, `domain` ).
	 *  So a list cannot become a hole in the validator — `lens` uses it, and `lens_crafter` fails as a chip. */
	itemType?:        string;
}

export const KcdValidate = new class KcdValidate {

	AUTHOR_RE = /^.+\s<[^\s@]+@[^\s@]+\.[^\s@]+>$/;        // Name <email>
	SCOPE_RE  = /^(?:universal|lens:[a-z0-9-]+)$/;
	ID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // a v4-shaped UUID, lowercase

	// ── Frontmatter spec ( tier + expected type + per-field extras ) ──────────────
	FRONTMATTER: Record<string, FieldSpec> = {
		name:             { required: true,  type: 'slug' },   // plus nameOk() extras ( ≤64, no claude/anthropic )
		description:      { required: true,  type: 'text', nonEmpty: true, maxLen: 1024 },
		type:             { required: true,  type: 'enum' },
		status:           { required: true,  type: 'enum', oneOf: KcdAddress.STATUSES, emptyOkForType: 'template' },
		// The stable identity, carried BY THE FILE so a move keeps it; the doc index reads it rather than
		// minting one. Optional until the lens/habit hard cut makes it required there.
		id:               { type: 'text', pattern: this.ID_RE },
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
		lens:             { type: 'list', itemType: 'slug' },
		// todo / completed are ADDRESSES, not paths ( protocol §1.1 ): a lens declares WHERE its log lives,
		// and a vacant address is a legal state, not a defect.
		todo:             { type: 'address' },
		completed:        { type: 'address' }
	};

	/**
	 * `docRoot` is required with no default: the ephemeral-link law depends on a vault fact only the caller
	 * holds. In-memory HTML that belongs to no vault passes `VaultLayout.DEFAULT_DOC_ROOT` explicitly.
	 */
	validate( input: string | HtmlEl | any, opts: { path?: string; docRoot: string } ): ValidateReport {
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
		this.checkBody( article, err );
		this.checkAddressing( article, err, opts.docRoot, opts?.path );
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
			const oneOf = this.allowedValues( key, spec, rootType );
			if ( oneOf && !oneOf.includes( value ) )              err( 'not-allowed', `field:${ key }`, `"${ value }" not in { ${ oneOf.join( ' | ' ) } }` );
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

	/** The closed set a field's value must fall in. `status` defers to the type's own vocabulary when its
	 *  shape declares one — a bug report is `working`, never `active` — and to the global set otherwise. */
	allowedValues( key: string, spec: FieldSpec, rootType: string ): readonly string[] | undefined {
		if ( key !== 'status' ) return spec.oneOf;
		return KcdShapes.statusesFor( rootType ) ?? spec.oneOf;
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

			// region — RETIRED on every type; a lens is flat sections.
			if ( KcdAddress.isRegion( el ) ) {
				const v = HtmlTree.get( el, 'data-kcd-region' )!;
				err( 'region-retired', `region:${ v }`, `Know / Care / Do regions are retired — write flat sections ( a lens is { ${ KcdAddress.LENS_SECTIONS.join( ' | ' ) } } )` );
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
				// A slot's KIND is load-bearing ( protocol §3 ): the parser keys dredge role off it, not section
				// position, so a bare `data-kcd-slot` is invalid — its role would only survive by inference.
				const kind = HtmlTree.get( el, 'data-kcd-slot' );
				if ( !kind )
					err( 'unkinded-slot', 'slot', `slot carries no kind — data-kcd-slot must name one of { ${ KcdAddress.SLOT_KINDS.join( ' | ' ) } }` );
				else if ( !KcdAddress.SLOT_KINDS.includes( kind ) )
					err( 'bad-slot-kind', `slot:${ kind }`, `slot kind "${ kind }" not in { ${ KcdAddress.SLOT_KINDS.join( ' | ' ) } }` );
				// A tool is the agent's, never a document's: no type encodes permissions.
				if ( kind === 'tool' )
					err( 'tool-slot-retired', 'slot:tool', `tool slots are retired — an agent's tools live on its record, and a ${ rootType } names the tools it reaches for in prose` );
				const hc = HtmlTree.get( el, 'data-kcd-habit-class' );
				if ( hc ) habitClasses[ hc ] = ( habitClasses[ hc ] ?? 0 ) + 1;
				// A row must carry a field the reader reads: ROW_FIELDS is the list `KcdContext.readSlot` reads by,
				// and the two must stay in step — a row of unread fields renders for a human and projects nothing.
				const fields = HtmlTree.collect( el, d => KcdAddress.isField( d ) );
				const named  = fields.map( d => HtmlTree.get( d, 'data-kcd-field' ) ?? '' );
				if ( fields.length === 0 )
					err( 'unaddressed-slot', 'slot', 'slot row carries no data-kcd-field — its cells are invisible to the parser' );
				else if ( !named.some( n => KcdAddress.ROW_FIELDS.includes( n ) ) )
					err( 'unread-slot', `slot:${ kind }`, `slot row carries only fields the reader never reads ( ${ named.filter( Boolean ).join( ', ' ) } ) — it renders for a human and projects NOTHING to an agent. A row is read from { ${ KcdAddress.ROW_FIELDS.join( ' | ' ) } }` );
				const mode = HtmlTree.get( el, 'data-kcd-mode' );
				if ( mode && KcdAddress.readMode( mode ) === null ) {
					// `suggested` is named because a vault may still hold it as a retired value; without the hint the
					// whole file is discarded and nothing says which word to fix.
					const hint = mode === 'suggested' ? ' — `suggested` became `load` on 2026-09-16; this document predates the sweep' : '';
					err( 'bad-mode', `mode:${ mode }`, `mode must be one of { ${ KcdAddress.MODES.join( ' | ' ) } }${ hint }` );
				}
			}

			// SEED mode is a different closed set, graded here rather than by widening MODES: a slot mode on a seed
			// is as wrong as a typo, and one merged set would call both legal.
			if ( HtmlTree.has( el, 'data-kcd-seed' ) ) {
				const seedMode = HtmlTree.get( el, 'data-kcd-mode' );
				if ( seedMode && !KcdAddress.SEED_MODES.includes( seedMode ) )
					err( 'bad-seed-mode', `mode:${ seedMode }`, `seed mode must be one of { ${ KcdAddress.SEED_MODES.join( ' | ' ) } } ( absent ⇒ prepend )` );
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

		if ( rootType === 'lens' ) this.checkLens( article, err );

		// composable-rule guard: one carrier ⇒ at most one slot per habit-class
		for ( const [ hc, n ] of Object.entries( habitClasses ) )
			if ( n > 1 ) err( 'dup-habit-class', `habit-class:${ hc }`, `${ n } slots share habit-class "${ hc }" — at most one per file ( §6 )` );
	}

	// ── Lens pass — philosophy + references, an optional personality, and nothing that behaves ─────
	/**
	 * A lens is information: its top-level sections are exactly LENS_SECTIONS with PHILOSOPHY required, and it
	 * carries no habit, tool, contract or `base`. PERSONALITY is legal but unrequired, and nothing reads it.
	 */
	checkLens( article: HtmlEl, err: Emit ): void {
		const top = HtmlTree.collect( article, el => KcdAddress.isSection( el ) && !this.insideSection( article, el ) );
		const names = top.map( el => HtmlTree.get( el, 'data-kcd-section' ) ?? '' );
		for ( const v of names )
			if ( v && !KcdAddress.LENS_SECTIONS.includes( v ) )
				err( 'bad-lens-section', `section:${ v }`, `a lens section is one of { ${ KcdAddress.LENS_SECTIONS.join( ' | ' ) } } — "${ v }" is not ( behaviour belongs to the agent; code areas are references )` );
		// PHILOSOPHY ALONE — personality is not checked here.
		if ( !names.includes( 'philosophy' ) )
			err( 'lens-no-philosophy', 'section:philosophy', 'a lens must carry a `philosophy` section' );

		for ( const slot of HtmlTree.collect( article, el => KcdAddress.isSlot( el ) ) ) {
			const kind = HtmlTree.get( slot, 'data-kcd-slot' );
			if ( kind === 'habit' || kind === 'contract' )
				err( 'lens-behaviour-slot', `slot:${ kind }`, `a lens carries no ${ kind } rows — ${ kind }s belong to the agent ( habits ) or the project ( contracts )` );
		}

		const base = HtmlTree.first( article, el => KcdAddress.isField( el ) && HtmlTree.get( el, 'data-kcd-field' ) === 'base' );
		if ( base ) err( 'base-retired', 'field:base', 'a lens inherits from nothing — drop the `base` field' );
	}

	/** Whether `el` sits inside another section below `root` — a nested subsection, not a top-level one. */
	insideSection( root: HtmlEl, el: HtmlEl ): boolean {
		let found = false;
		const visit = ( node: HtmlEl, depth: number ): boolean => {
			for ( const k of node.kids ) {
				if ( !HtmlTree.isEl( k ) ) continue;
				if ( k === el ) { found = depth > 0; return true; }
				if ( visit( k, depth + ( KcdAddress.isSection( k ) ? 1 : 0 ) ) ) return true;
			}
			return false;
		};
		visit( root, 0 );
		return found;
	}

	// ── Body pass — a document must SAY something ──────────────────────────────────
	/**
	 * Frontmatter is metadata, not the document: nothing outside it is an ERROR, not a warning, because save_doc
	 * refuses on errors only. Any body at all passes — a title-only stub is a review problem, not a validator one.
	 */
	checkBody( article: HtmlEl, err: Emit ): void {
		// The frontmatter subtree, not just its <dl>, or the block's own <dt>/<dd> cells count as body.
		// `walk` visits descendants only, so the article never matches itself.
		const frontmatter = new Set<HtmlNode>();
		for ( const fm of HtmlTree.collect( article, el => KcdAddress.isFrontmatter( el ) ) ) {
			frontmatter.add( fm );
			HtmlTree.walk( fm, d => frontmatter.add( d ) );
		}

		let hasBody = false;
		HtmlTree.walk( article, el => { if ( !frontmatter.has( el ) ) hasBody = true; } );
		if ( hasBody ) return;

		err( 'empty-body', 'body', 'artifact carries frontmatter and nothing else — a document must say something ( at least one element outside the frontmatter block )' );
	}

	// ── Habit pass — the four-field contract ( see _habit_template ) ────────────────
	// `why` is REQUIRED — a habit with no trigger cannot fire. `action` and `explanation` only warn when absent,
	// so rules-only habits still validate. Extra sections are allowed: they ride the full read, never the dense form.
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
			warn( 'habit-no-explanation', 'section:explanation', 'a habit has no `explanation` — the dense load form will carry no rationale' );
	
		this.checkHabitProjection( article, names, err, warn );
	}
	
	/**
	 * The projection pass: `projectHabit` reads rules only from `<li>`, so rules outside a list are an ERROR
	 * (silently lost). A projected field naming an offstage section is a WARNING, since the naming may be incidental.
	 */
	// The four narrative fields plus `public-habit-params`, whose rows ride as data ( `paramBlocks` ). Keep in
	// step with `KcdContext.PARAM_SECTIONS`: a section that projects must never be reported as dropped.
	PROJECTED_SECTIONS = new Set( [ 'why', 'action', 'explanation', 'rules', 'public-habit-params' ] );
	
	checkHabitProjection( article: HtmlEl, names: Set<string>, err: Emit, warn: Emit ): void {
		const sections = HtmlTree.collect( article, el => KcdAddress.isSection( el ) );
		const named    = ( key: string ): HtmlEl | undefined =>
			sections.find( el => HtmlTree.get( el, 'data-kcd-section' ) === key );
	
		// 1 — rules must be a list, because that is the only shape the projection reads.
		const rules = named( 'rules' );
		if ( rules && !HtmlTree.collect( rules, el => el.tag === 'li' ).length )
			err( 'habit-rules-not-projecting', 'section:rules',
				'a habit\'s `rules` section carries no `<li>` — `projectHabit` reads rules from list items only, so a faux-table or prose here reaches no agent. Author rules as a `<ul>`' );
	
		// 2 — a projected field that names one of this habit's own non-projected sections.
		const offstage = [ ...names ].filter( n => !this.PROJECTED_SECTIONS.has( n ) );
		if ( !offstage.length ) return;
	
		for ( const key of this.PROJECTED_SECTIONS ) {
			const el = named( key );
			if ( !el ) continue;
			const text = HtmlTree.textOf( el ).toLowerCase();
			for ( const target of offstage ) {
				if ( !text.includes( target.toLowerCase() ) ) continue;
				warn( 'habit-nonprojecting-ref', `section:${ key }`,
					`\`${ key }\` refers to \`${ target }\`, a section the dense projection drops — the agent receives the pointer but never its target. Inline what it needs, or remove the reference` );
			}
		}
	}


	// ── Helpers ───────────────────────────────────────────────────────────────────
	// ── Addressing pass ( protocol §1.1 ) ─────────────────────────────────────────
	/**
	 * The link-versus-address law: an address must be WELL-FORMED but its occupancy is never checked, since vacancy
	 * is legal. A link may never point into ephemeral space, which is not installed into a user's vault.
	 */
	checkAddressing( article: HtmlEl, err: Emit, docRoot: string, selfPath?: string ): void {
		// The ban binds library artifacts only; a document that itself lives in ephemeral space never ships.
		// With no path the safe default is to check: an unknown document is treated as shippable.
		const selfEphemeral = selfPath !== undefined && VaultLayout.isEphemeralHref( selfPath, docRoot );
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
			if ( VaultLayout.isEphemeralHref( href, docRoot ) )
				err( 'ephemeral-link', 'address', `"${ href }" links into ephemeral space ( ${ VaultLayout.ephemeralDirs().join( ', ' ) } ), which is not installed into a vault — use <code data-kcd-address> instead` );
		}
	}

	checkList( field: HtmlEl, key: string, spec: FieldSpec, err: Emit ): void {
		const tags = HtmlTree.collect( field, el => KcdAddress.isTag( el ) );
		for ( const t of tags ) {
			const value = HtmlTree.textOf( t ).trim();
			if ( value === '' ) { err( 'empty-tag', `field:${ key }`, 'empty chip in a list field' ); continue; }
			if ( !spec.itemType ) continue;   // free-text chips ( tags, domain )

			// A typed list gets the same checks as the scalar form, so making a field a list cannot quietly relax it.
			// A chip is never a link: its own text is the value.
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
