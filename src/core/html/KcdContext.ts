/**
 * KcdContext — object-model → AI-audience context text ( parser-family, the AI-context head ).
 *
 * The missing sibling to KcdParse ( HTML → model ) and KcdEmit ( model → HTML, the human audience ):
 * this row projects the already-parsed `SerializedArtifact` — never the raw document — down to the
 * lean declarative text an agent is actually billed for. `KCDPrimitive.toContextBlock()` delegates
 * here; every downstream token count ( wire, roster, Atlas ) corrects itself off this one change.
 *
 * The strip, in order: frontmatter reduces to its keep-set ( name / description / status — the
 * routing-relevant fields, not authoring bookkeeping ); `data-kcd-audience="human"` subtrees are
 * dropped outright ( protocol §5 ); everything else loses its tags and becomes plain block text;
 * dredge/nav slot rows ( `data-kcd-slot` ) render as tight "what — why (where)" lines instead of
 * being walked field-by-field, since a slot's `where` is routing content an agent needs verbatim,
 * not prose to flatten.
 *
 * Supersedes `KcdText` ( the placeholder Winston's root context used ) as the canonical projector.
 *
 * `projectBlocks()` ( context-optimization plan, Phase 2 ) is the region-block decomposition: one
 * artifact becomes several `ContextBlock`s ( Know / Care / Do ), the unit `ContextAssembler` merges
 * and sorts across a whole loaded set. `project()` ( Phase 1 ) is unchanged — the flat single-string
 * view a lone-artifact preview still wants — and shares the same tag-walking core.
 */

import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import type { SerializedArtifact } from '../../primitives/types';

/** Frontmatter fields that survive into the AI projection. Everything else ( author,
 *  schema-version, base, todo, completed, … ) is authoring bookkeeping a human maintains the
 *  file with — never behavior-relevant to the agent reading it. */
const FRONTMATTER_KEEP = [ 'name', 'description', 'status' ];

/** A KCD region, widened with `care` — the lens-only identity tier that sits above Know/Do. Every
 *  region-block is tagged one of these three; a non-lens artifact's whole body defaults to its own
 *  `getRole()` ( `know` or `do` ), since it never carries an explicit `data-kcd-region` wrapper. */
export type ContextRegion = 'care' | 'know' | 'do';

/** One `data-kcd-slot` row's fields, structured — not yet rendered to text. The identity a routing
 *  merge dedupes BY is `where` ( a real path/href, not a string it has to re-derive by parsing
 *  rendered prose back apart ). See `ContextAssembler.mergeRouting` — Bryan, 2026-07-12: "lean into
 *  the recursive nature of the inclusion" instead of a regex dedupe pass over already-rendered text. */
export interface SlotRow {
	what: string;
	where: string;
	why: string;
}

/** One region-scoped slice of an artifact's projected text — the unit `ContextAssembler` merges
 *  ( by `mergeKey` ) and sorts ( by `region` ). `section` is the source `data-kcd-section` name,
 *  kept for tracing/authoring resolution ( Phase 4 ) — never rendered into the wire text itself.
 *  `rows` is populated whenever the block contains `data-kcd-slot` rows ( a References/Habits/any
 *  other faux-table section ) — the STRUCTURED sibling of `text`: `text` is what a lone-block preview
 *  renders as-is, `rows` is what a routing merge dedupes and re-renders from, by real identity rather
 *  than parsing `text` back apart. */
export interface ContextBlock {
	region: ContextRegion;
	section: string | null;
	mergeKey: string | null;
	text: string;
	rows?: SlotRow[];
}

export const KcdContext = new class KcdContext {

	HEADINGS = new Set( [ 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] );
	// Chrome + machine-only structure — never part of the prompt body. `dl` is the frontmatter
	// block, rendered separately by `frontmatter()` from the structured field, not walked here.
	SKIP     = new Set( [ 'head', 'style', 'script', 'link', 'meta', 'dl' ] );

	/** One artifact's structured model → lean AI-audience text. */
	project( artifact: SerializedArtifact ): string {
		const header = `# [${ artifact.type }] ${ artifact.path }`;
		const front  = this.frontmatter( artifact.frontmatter );
		const body   = artifact.type === 'habit' ? this.projectHabit( artifact ) : this.body( artifact.body );
		return [ header, front, body ].filter( Boolean ).join( '\n\n' );
	}

	/** The keep-set, one `key: value` line each; list values join on comma. Empty/absent fields
	 *  emit nothing — an empty line must not mint a key the artifact never carried. */
	frontmatter( fm: Record<string, unknown> ): string {
		const lines: string[] = [];
		for ( const key of FRONTMATTER_KEEP ) {
			const v = fm[ key ];
			if ( v === undefined || v === '' ) continue;
			lines.push( `${ key }: ${ Array.isArray( v ) ? v.join( ', ' ) : v }` );
		}
		return lines.join( '\n' );
	}

	/** Reparse the artifact's body HTML and walk it to plain, audience-stripped text. Empty /
	 *  unparseable input yields ''. */
	body( html: string ): string {
		if ( !html || !html.trim() ) return '';
		const root = HtmlTree.parse( html );
		return this.renderNodes( root.kids );
	}

	/** `block()` over an already-collected node array, joined/collapsed the same way `body()` is —
	 *  the shared tail both the flat projector and the per-region-block projector render through. */
	renderNodes( nodes: HtmlNode[] ): string {
		const out: string[] = [];
		this.block( nodes, out );
		return out.join( '\n' ).replace( /\n{3,}/g, '\n\n' ).trim();
	}

	/**
	 * Decompose one artifact into region-blocks ( Phase 2 ). A lens's own top-level content
	 * ( outside any `data-kcd-region` — its `<h1>` + lede ) is the `care` block: identity prose, the
	 * "personality" half of Know+Care. Everything inside a `data-kcd-region` wrapper is split further,
	 * one block per `data-kcd-section` found inside it, tagged with that region and carrying its
	 * `data-kcd-merge-key` if it declares one. A non-lens artifact never carries a region wrapper, so
	 * its sections ( and any un-sectioned lede ) all default to `defaultRegion` — the caller passes
	 * its `getRole()` ( `know` for reference/plan/etc., `do` for habit/contract/generator/analyzer/
	 * utility ), since role is a KCDPrimitive concept this pure projector doesn't otherwise have.
	 */
	projectBlocks( artifact: SerializedArtifact, defaultRegion: 'know' | 'do' = 'know' ): ContextBlock[] {
		// A habit is a fixed four-field directive, not free-form regions: it projects to ONE dense block
		// ( the blessed two-liner ), never decomposed section-by-section. See `projectHabit`.
		if ( artifact.type === 'habit' ) {
			const text = this.projectHabit( artifact );
			return text ? [ { region: defaultRegion, section: 'habit', mergeKey: null, text } ] : [];
		}
		const ledeRegion: ContextRegion = artifact.type === 'lens' ? 'care' : defaultRegion;
		const out: ContextBlock[] = [];

		// No synthetic `# [type] path` head / frontmatter block on the wire: a loaded artifact's identity
		// ( name, description, path ) rides ONCE in the manifest ( Agent.compile — now the bottom-of-context
		// affordance surface ), never repeated per artifact ( Bryan, 2026-07-12: the path exists only once ).
		// The flat `project()` still leads with the head — that path feeds the Atlas's human single-artifact
		// preview, a deliberately different ( human ) audience than the wire.
		if ( !artifact.body || !artifact.body.trim() ) return out;

		const root = HtmlTree.parse( artifact.body );
		for ( const raw of this.collectRegions( root, ledeRegion ) ) {
			const text = this.renderNodes( raw.nodes );
			if ( !text ) continue;
			const rows = this.collectRows( raw.nodes );
			out.push( { region: raw.region, section: raw.section, mergeKey: raw.mergeKey ?? null, text, ...( rows.length ? { rows } : {} ) } );
		}
		return out;
	}

	/**
	 * One un-rendered region-block candidate — `collectRegions` gathers the node groups, leaving
	 * the actual text rendering ( shared with the flat path ) to the caller. Each recursion level
	 * ( the root's own top-level kids, or one `data-kcd-region`'s own kids ) keeps its OWN lede
	 * buffer, tagged with ITS OWN region — a Know-region's intro paragraph before its first named
	 * section belongs to `know`, not to the artifact-level `ledeRegion` a naive single shared buffer
	 * would wrongly stamp it with.
	 */
	collectRegions( root: HtmlEl, ledeRegion: ContextRegion ): { region: ContextRegion; section: string | null; mergeKey?: string; nodes: HtmlNode[] }[] {
		const out: { region: ContextRegion; section: string | null; mergeKey?: string; nodes: HtmlNode[] }[] = [];

		const visit = ( kids: HtmlNode[], region: ContextRegion ) => {
			let lede: HtmlNode[] = [];
			const flushLede = () => { if ( lede.length ) { out.push( { region, section: null, nodes: lede } ); lede = []; } };

			for ( const kid of kids ) {
				if ( !HtmlTree.isEl( kid ) ) { lede.push( kid ); continue; }
				if ( KcdAddress.isHumanOnly( kid ) ) continue;

				if ( KcdAddress.isRegion( kid ) ) {
					flushLede();
					const r = ( HtmlTree.get( kid, 'data-kcd-region' ) as ContextRegion | undefined ) ?? region;
					visit( this.dropRegionLabel( kid.kids ), r );   // drop the K/C/D label; keep the region's sections
					continue;
				}
				if ( KcdAddress.isSection( kid ) ) {
					flushLede();
					out.push( {
						region,
						section:  HtmlTree.get( kid, 'data-kcd-section' ) ?? null,
						mergeKey: KcdAddress.mergeKeyOf( kid ),
						nodes:    [ kid ]
					} );
					continue;
				}
				lede.push( kid );
			}
			flushLede();
		};

		visit( root.kids, ledeRegion );
		return out;
	}

	/** A `data-kcd-region` wrapper's own direct-child heading is the Know/Care/Do label — build-time
	 *  chrome, not content ( Bryan, 2026-07-12: strip K/C/D from compiled context entirely; the region
	 *  still organizes the assembly for us — sort tier, block decomposition — it just never names itself
	 *  to the agent ). Drops ONLY the region's DIRECT heading children; every `data-kcd-section` nested
	 *  inside keeps its own heading, since those sit a level deeper and are not direct children here. */
	dropRegionLabel( kids: HtmlNode[] ): HtmlNode[] {
		return kids.filter( k => !( HtmlTree.isEl( k ) && this.HEADINGS.has( k.tag ) ) );
	}

	/** Walk a node array, emitting block boundaries. Containers recurse; leaf blocks emit their
	 *  collapsed inline text and stop ( so a `<blockquote><p>…` is not counted twice ). */
	block( kids: HtmlNode[], out: string[] ): void {
		for ( const kid of kids ) {
			if ( kid.type === 'text' ) { const t = this.inline( kid ); if ( t ) out.push( t ); continue; }

			if ( KcdAddress.isHumanOnly( kid ) ) continue;  // the audience gate — protocol §5
			if ( HtmlTree.has( kid, 'data-kcd-head' ) ) continue;  // the table header row — visual-only chrome

			const tag = kid.tag;
			if ( this.SKIP.has( tag ) ) continue;

			// A region wrapper is transparent: recurse in, but strip its own K/C/D label heading first.
			if ( KcdAddress.isRegion( kid ) ) { this.block( this.dropRegionLabel( kid.kids ), out ); continue; }

			if ( KcdAddress.isSlot( kid ) ) { out.push( this.slotLine( kid ) ); continue; }

			if ( this.HEADINGS.has( tag ) ) {
				out.push( '', '#'.repeat( Number( tag[ 1 ] ) ) + ' ' + this.inline( kid ), '' );
				continue;
			}
			if ( tag === 'li' ) { out.push( '- ' + this.inline( kid ) ); continue; }
			if ( tag === 'p' || tag === 'blockquote' ) { out.push( '', this.inline( kid ), '' ); continue; }
			if ( tag === 'tr' ) {
				const cells = kid.kids.filter( HtmlTree.isEl ).map( ( c ) => this.inline( c ) ).filter( Boolean );
				if ( cells.length ) out.push( '- ' + cells.join( ' · ' ) );
				continue;
			}
			// Container ( body, article, section, ul, ol, div, table, thead, tbody, … ) — recurse in.
			this.block( kid.kids, out );
		}
	}

	/** A dredge/nav slot's fields, read structurally — the data half of `slotLine`, shared by the flat
	 *  render path and the structured `rows` collection ( `collectRows` ) a routing merge dedupes on. */
	readSlot( slot: HtmlEl ): SlotRow {
		const cells: Record<string, string> = {};
		for ( const f of HtmlTree.collect( slot, el => KcdAddress.isField( el ) ) ) {
			const { key, value } = KcdAddress.readField( f );
			if ( key ) cells[ key ] = value;
		}
		return { what: cells[ 'what' ] ?? '', where: cells[ 'where' ] ?? '', why: cells[ 'why' ] ?? '' };
	}

	/** A `SlotRow` → one tight line. `where` rides as a parenthesized route, not a markdown link — the
	 *  agent has no browser, only the addressable path/url text, and that text is routing content, not
	 *  decoration ( plan ruling ). The ONE render path — a lone slot's flat render (`slotLine`) and a
	 *  routing merge's re-render of its deduped survivors both go through this, so the two can never
	 *  drift into two different row shapes. */
	renderRow( row: SlotRow ): string {
		const text = [ row.what, row.why ].filter( Boolean ).join( ' — ' );
		return '- ' + ( row.where ? `${ text } (${ row.where })` : text );
	}

	/** A dredge/nav slot ( `what` / `where` / `why` fields ) → one tight line. Thin: read, then render. */
	slotLine( slot: HtmlEl ): string {
		return this.renderRow( this.readSlot( slot ) );
	}

	/** Every `data-kcd-slot` row inside a node array, structured — the data `projectBlocks` attaches to
	 *  a `ContextBlock` as `rows` alongside its rendered `text`. Recurses through containers exactly
	 *  like `block()` does, so a slot nested inside a `data-kcd-table` wrapper ( the normal shape ) is
	 *  found regardless of nesting depth. */
	collectRows( nodes: HtmlNode[] ): SlotRow[] {
		const out: SlotRow[] = [];
		const visit = ( kids: HtmlNode[] ): void => {
			for ( const kid of kids ) {
				if ( !HtmlTree.isEl( kid ) ) continue;
				if ( KcdAddress.isHumanOnly( kid ) ) continue;
				if ( KcdAddress.isSlot( kid ) ) { out.push( this.readSlot( kid ) ); continue; }
				visit( kid.kids );
			}
		};
		visit( nodes );
		return out;
	}

	/** The four-field habit projection — the dense, agent-facing behavioral directive ( see
	 *  `_habit_template` ). Reads the habit's `why` / `action` / `explanation` / `rules` sections and
	 *  renders the blessed two-line grammar; a `don't`-style habit ( no `action` ) folds its rules onto
	 *  line one. Pure concatenation — the authored fields are written to read correctly in the grammar,
	 *  so this never rewrites text. The ONE home for the dense form: both `project()` ( flat/preview ) and
	 *  `projectBlocks()` ( the wire ) route a habit through here, so a habit can never render two ways.
	 *  `why` was `when` until 2026-07-13 — renamed to match the canonical What|Where|Why convention;
	 *  it's the same trigger prose a lens's Why cell defers to via `mode:habit`. The rendered grammar
	 *  keeps the English word "when" as a connector — only the section id / source field changed. */
	projectHabit( artifact: SerializedArtifact ): string {
		const name        = String( artifact.frontmatter[ 'name' ] ?? '' ).trim();
		const secs        = this.habitSections( artifact.body );
		const when        = secs[ 'why' ]?.text ?? '';
		const action      = secs[ 'action' ]?.text ?? '';
		const explanation = secs[ 'explanation' ]?.text ?? '';
		const rules       = ( secs[ 'rules' ]?.items ?? [] ).join( '; ' );

		const line1 = action
			? `${ name } — when ${ when }, execute ${ action }.`
			: `${ name } — when ${ when }${ rules ? `: ${ rules }` : '' }.`;

		// Line two carries the depth: the explanation always, plus the rules UNLESS a don't-style habit
		// already spent them on line one.
		const tail  = [ explanation, action ? rules : '' ].filter( Boolean );
		const line2 = tail.length ? `↳ ${ tail.join( ' · ' ) }` : '';

		return [ line1, line2 ].filter( Boolean ).join( '\n' );
	}

	/** section-name → { text, items } for a flat-sectioned artifact ( a habit ). `text` is the section's
	 *  prose with its heading and any list stripped; `items` is its `<li>` texts ( the rules bullets ).
	 *  Human-only sections ( scaffold notes ) are skipped — they never reach the agent. */
	habitSections( html: string ): Record<string, { text: string; items: string[] }> {
		const out: Record<string, { text: string; items: string[] }> = {};
		if ( !html || !html.trim() ) return out;
		const root = HtmlTree.parse( html );
		for ( const el of HtmlTree.collect( root, e => KcdAddress.isSection( e ) ) ) {
			if ( KcdAddress.isHumanOnly( el ) ) continue;
			const name = HtmlTree.get( el, 'data-kcd-section' );
			if ( name ) out[ name ] = this.readSection( el );
		}
		return out;
	}

	/** One section's { text, items }: prose ( paragraphs/blockquotes, the heading dropped ) joined into
	 *  `text`; every `<li>` collected into `items` ( the rules bullets ). */
	readSection( el: HtmlEl ): { text: string; items: string[] } {
		const parts: string[] = [];
		const items: string[] = [];
		const walk = ( kids: HtmlNode[] ): void => {
			for ( const k of kids ) {
				if ( !HtmlTree.isEl( k ) ) continue;
				if ( this.HEADINGS.has( k.tag ) ) continue;              // drop the section's own heading
				if ( k.tag === 'li' ) { const t = this.inline( k ); if ( t ) items.push( t ); continue; }
				if ( k.tag === 'ul' || k.tag === 'ol' ) { walk( k.kids ); continue; }
				const t = this.inline( k );
				if ( t ) parts.push( t );
			}
		};
		walk( el.kids );
		return { text: parts.join( ' ' ), items };
	}

	/** Collapse a node's whole-subtree text to a single trimmed line. */
	inline( n: HtmlNode ): string {
		return HtmlTree.textOf( n ).replace( /\s+/g, ' ' ).trim();
	}
}();
