/**
 * KcdSynth — content in, conforming body HTML out ( parser-family, the synthesis direction ).
 * An author supplies content ( section name → prose, plus slot rows ); the markup is derived from `KcdShapes`:
 * section order from the table, heading depth from nesting, a `phase-2` placed inside `phases` by its parent's `nests` glob.
 * This owns SHAPE, not conformance: `KcdValidate` stays the only gate, so synthesis cannot become a second authority.
 * Prose is escaped unless it already opens with a block tag, so unrecognized input is never injected.
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

/** Markdown an author probably meant to be interpreted, which prose emission renders literally. */
const MARKDOWN_TELLS: { probe: RegExp; fix: string }[] = [
	{ probe: /\*\*\S[^*]*\*\*/,        fix: '**bold** → <strong>' },
	{ probe: /`[^`\n]+`/,              fix: '`code` → <code>' },
	{ probe: /\[[^\]\n]+\]\([^)\s]+\)/, fix: '[text](target) → <a href>' },
];

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
			const hits = MARKDOWN_TELLS.filter( t => t.probe.test( text ) ).map( t => t.fix );
			if ( hits.length )
				out.push( `markdown in section "${ name }": ${ hits.join( ', ' ) } — prose is escaped verbatim, so these render as literal characters rather than formatting.` );
		}
		return out;
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

	/** Plain text → paragraphs and `- ` lists; authored HTML passes through. Anything unrecognized is ESCAPED, so a stray `<` cannot open a tag. */
	proseToHtml( text: string ): string {
		// Comments come off BEFORE the markup test, so a block that merely opens with one is still
		// recognized as authored HTML rather than escaped wholesale.
		const trimmed = text.replace( COMMENT_SYNTAX, '' ).trim();
		if ( !trimmed ) return '';
		if ( BLOCK_START.test( trimmed ) ) return trimmed;

		return trimmed
			.split( /\n\s*\n/ )
			.map( block => this.blockToHtml( block.trim() ) )
			.filter( Boolean )
			.join( '\n' );
	}

	/** One paragraph-or-list block. */
	blockToHtml( block: string ): string {
		if ( !block ) return '';
		const lines = block.split( '\n' ).map( l => l.trim() ).filter( Boolean );

		if ( lines.length && lines.every( l => l.startsWith( '- ' ) ) ) {
			const items = lines.map( l => `\t<li>${ HtmlTree.escapeText( l.slice( 2 ).trim() ) }</li>` ).join( '\n' );
			return `<ul>\n${ items }\n</ul>`;
		}
		return `<p>${ HtmlTree.escapeText( lines.join( ' ' ) ) }</p>`;
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
