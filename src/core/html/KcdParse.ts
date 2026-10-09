/**
 * KcdParse — HTML → object model, the runtime front end ( parser-family row 1 ).
 * Targets the frozen structural seam: its `SerializedArtifact` shape is the contract, and parity is
 * structural, not byte-identical — section bodies are inner HTML, only names, links and policy are asserted.
 * THE LAW ( protocol §1.5 ): validate-FIRST, file-level, all-or-nothing; a non-conforming document yields no object model.
 * It reads ONLY the addressing contract via KcdAddress — never element order, class, or scraped text.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import { KcdValidate } from './KcdValidate';
import { classifyHref } from '../../primitives/framework/KCDPrimitive';
import { KCDValidationError } from '../../primitives/errors';
import type { AddressEntry, ArtifactType, LinkEntry, PolicyEntry, SerializedArtifact, SlotMode } from '../../primitives/types';

/** Section name → the dredge ROLE a bare, unstamped slot infers; the explicit `data-kcd-slot` always wins.
 *  `domains` and `domain` fold into `reference`. */
const SLOT_ROLE: Record<string, string> = {
	references: 'reference', domains: 'reference', domain: 'reference',
	habits: 'habit', contracts: 'contract', tools: 'tool', rules: 'rule'
};

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

/** The frozen `SerializedArtifact` fields cross the bridge; `policy`, `params` and `slots` are computed once
 *  here so LensObject reads structured rows instead of re-parsing the body. */
export interface ParsedArtifact extends SerializedArtifact {
	policy: PolicyEntry[];
	params: ParsedParam[];
	slots: ParsedSlot[];
	/** `group.tool` identity → mode, from the where-less slots of the Tools section ( lens only; {} elsewhere ). */
	toolModes: Record<string, SlotMode>;
}

export const KcdParse = new class KcdParse {

	/** Strict: a conforming document → its object model; a malformed one THROWS. The protected door.
	 *  `docRoot` is required and cannot default — see KcdValidate on why. */
	parse( html: string, path: string, docRoot: string ): ParsedArtifact {
		const report = KcdValidate.validate( html, { path, docRoot } );
		if ( !report.ok ) {
			// Message and `errors` both, deliberately: a sentence holds one finding, and a caller rebuilding
			// its report from the sentence alone collapses N errors into 1.
			const first = report.errors[ 0 ];
			throw new KCDValidationError(
				`KCD document failed validation ( ${ report.errors.length } error(s) ): ${ first.code } @ ${ first.where } — ${ first.msg }`,
				path, 'conforming KCD HTML', null, { errors: report.errors }
			);
		}
		return this.build( HtmlTree.parse( html ), path );
	}

	/** Lenient: returns null instead of throwing — for the scanner's skip-and-continue sweep. */
	tryParse( html: string, path: string, docRoot: string ): ParsedArtifact | null {
		const report = KcdValidate.validate( html, { path, docRoot } );
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
	// A tool is not a path artifact: keyed by the verbatim `group.tool` `what` the agent and the wire use,
	// and where-less, so it never enters `policy`. A row with no `what` or mode `off` is dropped.
	toolModes( slots: ParsedSlot[] ): Record<string, SlotMode> {
		const out: Record<string, SlotMode> = {};
		for ( const s of slots ) {
			if ( s.kind !== 'tool' || !s.what || s.mode === 'off' ) continue;
			out[ s.what ] = s.mode;
		}
		return out;
	}

	// ── Frontmatter ( <dl data-kcd-frontmatter> → Record, replacing YAML ) ─────────
	// Coerced by declared type; empty optional fields are skipped, so an empty <dd> never mints a key
	// ( protects key-set parity ).
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
	// A habit or contract slot feeds the same policy list: `mode` alone decides what rides ( off /
	// on-routing-row / load-full-text ), so no artifact type needs its own carve-out downstream.
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
			// Absent ⇒ `on`. An unrecognised mode lands there only on a path that skipped validation, which
			// `parse()` never does: `bad-mode` is a hard error.
			mode:       KcdAddress.readMode( rawMode ) ?? 'on',
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
