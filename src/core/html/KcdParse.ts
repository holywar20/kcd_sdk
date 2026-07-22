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
import type { AddressEntry, ArtifactType, LinkEntry, PolicyEntry, SerializedArtifact, SlotMode } from '../../primitives/types';

/** Section name → the dredge ROLE a bare ( unstamped ) slot infers — the fallback mirror of the canonical
 *  slot-kind law ( `data-kcd-slot="<kind>"`, protocol §3 ). The explicit attribute always wins; this only
 *  fires for a hand-authored slot that carries no stamp. `domains`/`domain` fold into `reference`. */
const SLOT_ROLE: Record<string, string> = {
	references: 'reference', domains: 'reference', domain: 'reference',
	habits: 'habit', contracts: 'contract', tools: 'tool', rules: 'rule'
};

/** A slot's kind BY POSITION, when it carries no explicit `data-kcd-slot` value: its block's role, or
 *  `link` ( the row carries an href ) / `table-data` ( no href ) for a non-role block. */
function inferSlotKind( section: string | undefined, where: string ): string {
	return ( section && SLOT_ROLE[ section ] ) || ( where ? 'link' : 'table-data' );
}

/** A dredge/nav slot row, structured ( protocol §3 ). `policy` now covers every region — a habit or
 *  contract slot is dredge-eligible the same way a reference slot is; only `mode` decides how much
 *  of it rides ( see SlotMode ). */
export interface ParsedSlot {
	what: string;
	where: string;          // the href ( the `where` field is a link )
	why: string;
	/** The slot's KIND — the explicit `data-kcd-slot="<kind>"` value, or `inferSlotKind` for a bare slot.
	 *  Dredge roles: reference / habit / contract / tool / rule; non-dredge: link / table-data. */
	kind: string;
	mode: SlotMode;
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
	/** tool name → mode, from the where-less slots of the Tools section ( lens only; {} elsewhere ). */
	toolModes: Record<string, SlotMode>;
}

export const KcdParse = new class KcdParse {

	/** Strict: a conforming document → its object model; a malformed one THROWS. The protected door. */
	parse( html: string, path: string ): ParsedArtifact {
		const report = KcdValidate.validate( html, { path } );
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
		const report = KcdValidate.validate( html, { path } );
		if ( !report.ok ) return null;
		return this.build( HtmlTree.parse( html ), path );
	}

	// ── Assembly ( runs only on an already-conforming tree ) ─────────────────────

	build( root: HtmlEl, path: string ): ParsedArtifact {
		const article = HtmlTree.first( root, el => KcdAddress.isArticle( el ) )!;
		const type = ( HtmlTree.get( article, 'data-kcd' ) ?? 'unknown' ) as ArtifactType;

		const acc: Scan = { links: [], addresses: [], slots: [], params: [] };
		this.scan( article, undefined, undefined, acc );

		const slots = acc.slots;
		return {
			path,
			type,
			frontmatter: this.frontmatter( article ),
			sections:    this.sections( article ),
			body:        HtmlTree.innerHtml( article ),
			links:       acc.links,
			addresses:   acc.addresses,
			included:    true,
			policy:      this.policy( slots ),
			params:      acc.params,
			slots,
			toolModes:   this.toolModes( slots )
		};
	}

	// ── Tools ( a lens's MCP tool composition — the `tool`-kind slots ) ──
	// A tool is NOT a path artifact: its slot names the tool ( the `what` cell ) and carries a mode, no
	// `where`, so it never enters `policy` ( which skips where-less rows ). Keyed on the explicit slot KIND
	// now ( `data-kcd-slot="tool"` ), decoupled from the section NAME — the migration's whole point. Bare
	// tool slots still resolve via `inferSlotKind` ( tools-section → tool ). A row without a `what` or with
	// mode `off` contributes nothing.
	toolModes( slots: ParsedSlot[] ): Record<string, SlotMode> {
		const out: Record<string, SlotMode> = {};
		for ( const s of slots ) {
			if ( s.kind !== 'tool' || !s.what || s.mode === 'off' ) continue;
			out[ s.what ] = s.mode;
		}
		return out;
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

	// ── Policy ( every region — one dredge idiom for reference, habit, contract, anything routable ) ──
	// In the md world this was LensObject parsing the `## Know` markdown table, know-only. A Do-region
	// habit/contract slot now feeds the SAME policy list — `mode` alone decides what rides ( off /
	// on-routing-row / suggested-full-text ), so no artifact type needs its own carve-out downstream.
	policy( slots: ParsedSlot[] ): PolicyEntry[] {
		const out: PolicyEntry[] = [];
		for ( const s of slots ) {
			if ( !s.where ) continue;
			out.push( { what: s.what, href: s.where, why: s.why, mode: s.mode, type: classifyHref( s.where ), section: s.section } );
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
			// An address is collected, never probed — protocol §1.1. Occupancy is not this pass's business.
			if ( KcdAddress.isAddress( kid ) ) {
				acc.addresses.push( { value: KcdAddress.addressOf( kid ), text: HtmlTree.textOf( kid ).trim(), section: sect } );
			}
			if ( KcdAddress.isSlot( kid ) )  acc.slots.push( this.readSlot( kid, reg, sect ) );
			if ( KcdAddress.isParam( kid ) ) acc.params.push( this.readParam( kid, sect ) );

			this.scan( kid, reg, sect, acc );
		}
	}

	readSlot( slot: HtmlEl, region: string | undefined, section: string | undefined ): ParsedSlot {
		const cells = this.cells( slot );
		const rawMode = HtmlTree.get( slot, 'data-kcd-mode' );
		const where = cells.where ?? '';
		return {
			what:       cells.what  ?? '',
			where,
			why:        cells.why   ?? '',
			kind:       HtmlTree.get( slot, 'data-kcd-slot' ) || inferSlotKind( section, where ),
			mode:       ( rawMode === 'off' || rawMode === 'suggested' ) ? rawMode : 'on',
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

interface Scan { links: LinkEntry[]; addresses: AddressEntry[]; slots: ParsedSlot[]; params: ParsedParam[]; }
