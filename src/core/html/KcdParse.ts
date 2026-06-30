/**
 * KcdParse — HTML → object-model, the permanent runtime front end ( parser-family row 1 ).
 *
 * Supplants the markdown `parseBody` ( `## `-split ), `splitFrontmatter` ( YAML ), and the lens
 * dredge-table parse. It targets the FROZEN STRUCTURAL SEAM — it emits exactly today's
 * `SerializedArtifact` ( type · frontmatter keys · section names · links ), so the md and HTML forms
 * of one logical artifact produce a structurally-equivalent object model. Parity is structural, not
 * byte-identical: section bodies are stored as inner HTML ( the substrate-coupled half, free to
 * change ); only names / links / policy are asserted equal.
 *
 * THE LAW ( protocol §1.5, ruled "aggressively protect the codebase from malformed values" ):
 * validate-FIRST, file-level, all-or-nothing. A non-conforming document yields NO object model —
 * `parse()` throws, `tryParse()` returns null. There is no partial parse. This retires the
 * per-subclass `validateFrontmatter` / `validateStructure` throw-chain in favour of the one shared
 * binary validator; a document that reaches the object model has already conformed.
 *
 * It reads ONLY the addressing contract via KcdAddress — never element order, class, or scraped text.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdValidate } from './KcdValidate';
import { classifyHref } from '../../primitives/framework/KCDPrimitive';
import { KCDValidationError } from '../../primitives/errors';
import type { ArtifactType, LinkEntry, PolicyEntry, SerializedArtifact } from '../../primitives/types';

/** A dredge/nav slot row, structured ( protocol §3 ). Frozen `policy` is the know-region subset. */
export interface ParsedSlot {
	what: string;
	where: string;          // the href ( the `where` field is a link )
	why: string;
	always: boolean;
	habitClass?: string;    // mutual-exclusion group ( protocol §6 ) — rich-model extra, not in frozen policy
	region?: string;
	section?: string;
}

/** A typed user-set variable ( protocol §3a ). NODE-set, never agent-set — the security barrier. */
export interface ParsedParam {
	name: string;
	type: string;
	default: string;
	description: string;
	section?: string;
}

/**
 * The parse-time superset. The frozen `SerializedArtifact` fields are what crosses the bridge; the
 * extras ( `policy` / `params` / `slots` ) are computed here ONCE so the object layer ( LensObject )
 * consumes structured rows instead of re-parsing a body. They are the deletion of the single biggest
 * md fragility — "parse a markdown table for dredge policy."
 */
export interface ParsedArtifact extends SerializedArtifact {
	policy: PolicyEntry[];
	params: ParsedParam[];
	slots: ParsedSlot[];
}

export const KcdParse = new class KcdParse {

	/** Strict: a conforming document → its object model; a malformed one THROWS. The protected door. */
	parse( html: string, path: string ): ParsedArtifact {
		const report = KcdValidate.validate( html );
		if ( !report.ok ) {
			const first = report.errors[ 0 ];
			throw new KCDValidationError(
				`KCD document failed validation ( ${ report.errors.length } error(s) ): ${ first.code } @ ${ first.where } — ${ first.msg }`,
				path, 'conforming KCD HTML', null
			);
		}
		return this.build( HtmlTree.parse( html ), path );
	}

	/** Lenient: returns null instead of throwing — for the scanner's skip-and-continue sweep. */
	tryParse( html: string, path: string ): ParsedArtifact | null {
		const report = KcdValidate.validate( html );
		if ( !report.ok ) return null;
		return this.build( HtmlTree.parse( html ), path );
	}

	// ── Assembly ( runs only on an already-conforming tree ) ─────────────────────

	build( root: HtmlEl, path: string ): ParsedArtifact {
		const article = HtmlTree.first( root, el => KcdAddress.isArticle( el ) )!;
		const type = ( HtmlTree.get( article, 'data-kcd' ) ?? 'unknown' ) as ArtifactType;

		const acc: Scan = { links: [], slots: [], params: [] };
		this.scan( article, undefined, undefined, acc );

		const slots = acc.slots;
		return {
			path,
			type,
			frontmatter: this.frontmatter( article ),
			sections:    this.sections( article ),
			body:        HtmlTree.innerHtml( article ),
			links:       acc.links,
			included:    true,
			policy:      this.policy( slots ),
			params:      acc.params,
			slots
		};
	}

	// ── Frontmatter ( <dl data-kcd-frontmatter> → Record, replacing YAML ) ─────────
	// Coerced by declared type so downstream reads match the old js-yaml result ( number stays
	// number, list stays string[] ). Empty optional fields are skipped — an empty <dd> must not mint
	// a key the markdown never carried ( protects key-set parity ).
	frontmatter( article: HtmlEl ): Record<string, unknown> {
		const dl = HtmlTree.first( article, el => KcdAddress.isFrontmatter( el ) );
		const out: Record<string, unknown> = {};
		if ( !dl ) return out;

		for ( const dd of HtmlTree.collect( dl, el => KcdAddress.isField( el ) ) ) {
			const { key, declared, value } = KcdAddress.readField( dd );
			if ( declared === 'list' )      { const chips = KcdAddress.chipsOf( dd ); if ( chips.length ) out[ key ] = chips; continue; }
			if ( value === '' )             continue;
			out[ key ] = declared === 'number' ? Number( value ) : value;
		}
		return out;
	}

	// ── Sections ( name → inner HTML; the frozen section-NAME set, body free to change ) ──
	// Duplicate section names MERGE ( additive ) — collapsing overlapping mappings into one entity,
	// the same model the lens uses to fold its context. Real declarative/union merge is richer-model.
	sections( article: HtmlEl ): Record<string, string> {
		const out: Record<string, string> = {};
		for ( const sec of HtmlTree.collect( article, el => KcdAddress.isSection( el ) ) ) {
			const name = HtmlTree.get( sec, 'data-kcd-section' ) ?? '';
			if ( !name ) continue;
			const body = HtmlTree.innerHtml( sec );
			out[ name ] = out[ name ] ? `${ out[ name ] }\n${ body }` : body;
		}
		return out;
	}

	// ── Policy ( frozen — the know-region slots, with the `always` dredge gate ) ───
	// In the md world this was LensObject parsing the `## Know` markdown table. Now it is structured
	// slot rows; only know-region slots are policy ( Do-region habit/contract slots are links, as
	// before ), so the frozen getPolicy shape is preserved exactly.
	policy( slots: ParsedSlot[] ): PolicyEntry[] {
		const out: PolicyEntry[] = [];
		for ( const s of slots ) {
			if ( s.region !== 'know' ) continue;
			out.push( { what: s.what, href: s.where, why: s.why, always: s.always, type: classifyHref( s.where ), section: s.section } );
		}
		return out;
	}

	// ── One descent ( links + slots + params, each tagged with its region + section ) ──
	scan( el: HtmlEl, region: string | undefined, section: string | undefined, acc: Scan ): void {
		for ( const kid of el.kids ) {
			if ( !HtmlTree.isEl( kid ) ) continue;

			const reg  = KcdAddress.isRegion( kid )  ? ( HtmlTree.get( kid, 'data-kcd-region' )  || region )  : region;
			const sect = KcdAddress.isSection( kid ) ? ( HtmlTree.get( kid, 'data-kcd-section' ) || section ) : section;

			if ( kid.tag === 'a' && HtmlTree.has( kid, 'href' ) ) {
				const href = HtmlTree.get( kid, 'href' )!;
				acc.links.push( { text: HtmlTree.textOf( kid ).trim(), href, type: classifyHref( href ), section: sect } );
			}
			if ( KcdAddress.isSlot( kid ) )  acc.slots.push( this.readSlot( kid, reg, sect ) );
			if ( KcdAddress.isParam( kid ) ) acc.params.push( this.readParam( kid, sect ) );

			this.scan( kid, reg, sect, acc );
		}
	}

	readSlot( slot: HtmlEl, region: string | undefined, section: string | undefined ): ParsedSlot {
		const cells = this.cells( slot );
		return {
			what:       cells.what  ?? '',
			where:      cells.where ?? '',
			why:        cells.why   ?? '',
			always:     HtmlTree.has( slot, 'data-kcd-always' ),
			habitClass: HtmlTree.get( slot, 'data-kcd-habit-class' ),
			region,
			section
		};
	}

	readParam( param: HtmlEl, section: string | undefined ): ParsedParam {
		const cells = this.cells( param );
		return {
			name:        cells.name        ?? '',
			type:        cells.type        ?? '',
			default:     cells.default     ?? '',
			description: cells.description ?? '',
			section
		};
	}

	/** A row's addressable cells as a { fieldName → value } bag — the row reader both slots/params share. */
	cells( row: HtmlEl ): Record<string, string> {
		const out: Record<string, string> = {};
		for ( const f of HtmlTree.collect( row, el => KcdAddress.isField( el ) ) ) {
			const { key, value } = KcdAddress.readField( f );
			if ( key ) out[ key ] = value;
		}
		return out;
	}
}();

interface Scan { links: LinkEntry[]; slots: ParsedSlot[]; params: ParsedParam[]; }
