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
 *
 * TWO PROJECTIONS, ONE WALK ( 2026-09-11 ). `lean()` / `leanArtifact()` are the READ path
 * ( `kcd_get` ): the same markdown `block()` emits, with the blank lines squeezed out and `body`
 * dropped from the artifact entirely. NO TAGS SURVIVE either path — Bryan's ruling: "tags are a
 * filing mechanism that allows for the documentation to come down to the agent without all the
 * formatting ceremony on the wire", and a markdown `###` says what an `<h3>` says for a third the
 * tokens. So the difference between reading and compiling is one boolean about air, not a second
 * tree walk, and the policy for what NEVER reaches an agent has one home in `dropped()`.
 *
 * Two things are exempt from the whitespace strip, both because their whitespace IS content: a `pre`
 * rides verbatim in a markdown fence, and a real `<table>` renders as a padded markdown table
 * ( `table()` ) rather than flattening to one `- a · b · c` line that hid which row was the header.
 */

import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import type { SerializedArtifact, SerializedLens } from '../../primitives/types';

/** Frontmatter fields that survive into the AI projection. Everything else ( author,
 *  schema-version, base, todo, completed, … ) is authoring bookkeeping a human maintains the
 *  file with — never behavior-relevant to the agent reading it. */
const FRONTMATTER_KEEP = [ 'name', 'description', 'status' ];

/** A KCD region, widened with `care` — the lens-only identity tier that sits above Know/Do. Every
 *  region-block is tagged one of these three; a non-lens artifact's whole body defaults to its own
 *  `getRole()` ( `know` or `do` ), since it never carries an explicit `data-kcd-region` wrapper. */
export type ContextRegion = 'care' | 'know' | 'do';

/**
 * An artifact projected for READING rather than for editing — `KcdContext.leanArtifact`'s output.
 * Structurally a `SerializedArtifact` with `sections` stripped to the lean projection and `body`
 * REMOVED, so the one field a round trip would corrupt cannot be mistaken for the one it needs
 * ( see `leanArtifact` ). `nodes` carries a lens's dredged children, each leaned the same way.
 */
export interface LeanArtifact extends Omit<SerializedArtifact, 'body'> {
	nodes?: LeanArtifact[];
}

/** One `data-kcd-slot` row's fields, structured — not yet rendered to text. The identity a routing
 *  merge dedupes BY is `where` ( a real path/href, not a string it has to re-derive by parsing
 *  rendered prose back apart ). See `ContextAssembler.mergeManifest` — Bryan, 2026-07-12: "lean into
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
			lines.push( `${ key }: ${ this.decodeEntities( Array.isArray( v ) ? v.join( ', ' ) : String( v ) ) }` );
		}
		return lines.join( '\n' );
	}

	/** Reparse the artifact's body HTML and walk it to plain, audience-stripped text. Empty /
	 *  unparseable input yields ''. `tight` is the read path's air-squeeze — see `lean()`. */
	body( html: string, tight = false ): string {
		if ( !html || !html.trim() ) return '';
		const root = HtmlTree.parse( html );
		return this.renderNodes( root.kids, tight );
	}

	/**
	 * `block()` over an already-collected node array, joined/collapsed the same way `body()` is —
	 * the shared tail both the flat projector and the per-region-block projector render through.
	 *
	 * `tight` is the ONE axis on which the read projection differs from the compile one. `block()`
	 * pads a heading or a paragraph with empty entries so compiled prose breathes; the read path
	 * drops those entries, so the same walk lands one line per block with no air between. It is a
	 * FILTER of empty entries rather than a regex over the joined string, deliberately — a `pre` or a
	 * table rides as one entry with its own newlines inside, and a string-level squeeze could not
	 * tell that whitespace from the padding it means to remove.
	 */
	renderNodes( nodes: HtmlNode[], tight = false ): string {
		const out: string[] = [];
		this.block( nodes, out );
		if ( tight ) return out.filter( s => s !== '' ).join( '\n' ).trim();
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
			const text = this.renderNodes( this.stripNonCanonicalHeadings( raw.nodes ) );
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

	/** The heading NUKE ( Bryan, 2026-07-13 ): raw `<h1>`–`<h6>` in an artifact body are human chrome and
	 *  never ride the wire AS headings — the parser strips the whole superset up front rather than
	 *  selectively sanitizing the doc title, the K/C/D labels, etc. one at a time. The ONE survivor is a
	 *  heading an author marked canonical with `data-kcd-heading`; it's kept, and `block()` gives it the
	 *  hash treatment at its own tag level ( `<h3 data-kcd-heading>` → `###` ). So the compiled heading
	 *  structure — what heading-level folding keys on — depends only on the headings we chose to keep, never
	 *  on hand-authored HTML. Recurses, so a junk / canonical heading is caught at any depth. Wire path only:
	 *  the flat `project()` ( human Atlas preview ) keeps every authored heading. */
	stripNonCanonicalHeadings( nodes: HtmlNode[] ): HtmlNode[] {
		const out: HtmlNode[] = [];
		for ( const n of nodes ) {
			if ( !HtmlTree.isEl( n ) ) { out.push( n ); continue; }
			if ( this.HEADINGS.has( n.tag ) && !HtmlTree.has( n, 'data-kcd-heading' ) ) continue;   // untagged heading → nuked
			out.push( { ...n, kids: this.stripNonCanonicalHeadings( n.kids ) } );
		}
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

	/**
	 * Elements that never reach an agent, whatever the projection style — the POLICY half of the
	 * walk, held apart from the rendering half so the two emitters below (`block`, the markdown
	 * projection; `leanBlock`, the tag-preserving one) cannot drift about WHAT is dropped while
	 * differing about HOW the survivors look. Anything added here is dropped by both at once.
	 *
	 * The gates, in order: the audience gate ( protocol §5 ); the faux-table header row ( visual-only
	 * chrome ); machine/chrome tags ( `dl` is the frontmatter block, projected separately ); and the
	 * Tools section — metadata, whose `tool`-kind slots feed `KcdParse.toolModes` → the wire's tool
	 * manifest and never ride as body content. The last line is the defence for a stray `tool` slot
	 * sitting OUTSIDE a Tools section: same metadata rule, caught by KIND rather than by section name.
	 */
	dropped( el: HtmlEl ): boolean {
		if ( KcdAddress.isHumanOnly( el ) ) return true;
		if ( HtmlTree.has( el, 'data-kcd-head' ) ) return true;
		if ( this.SKIP.has( el.tag ) ) return true;
		if ( KcdAddress.isSection( el ) && HtmlTree.get( el, 'data-kcd-section' ) === 'tools' ) return true;
		if ( KcdAddress.isSlot( el ) && HtmlTree.get( el, 'data-kcd-slot' ) === 'tool' ) return true;
		return false;
	}

	/** Walk a node array, emitting block boundaries. Containers recurse; leaf blocks emit their
	 *  collapsed inline text and stop ( so a `<blockquote><p>…` is not counted twice ). */
	block( kids: HtmlNode[], out: string[] ): void {
		for ( const kid of kids ) {
			if ( kid.type === 'text' ) { const t = this.inline( kid ); if ( t ) out.push( t ); continue; }
			if ( this.dropped( kid ) ) continue;

			const tag = kid.tag;

			// A region wrapper is transparent: recurse in, but strip its own K/C/D label heading first.
			if ( KcdAddress.isRegion( kid ) ) { this.block( this.dropRegionLabel( kid.kids ), out ); continue; }

			if ( KcdAddress.isSlot( kid ) ) { out.push( this.slotLine( kid ) ); continue; }

			if ( this.HEADINGS.has( tag ) ) {
				out.push( '', '#'.repeat( Number( tag[ 1 ] ) ) + ' ' + this.inline( kid ), '' );
				continue;
			}
			if ( tag === 'li' ) { out.push( '- ' + this.inline( kid ) ); continue; }
			if ( tag === 'p' || tag === 'blockquote' ) { out.push( '', this.inline( kid ), '' ); continue; }

			// A real `<table>` is taken WHOLE, never row by row — a markdown table has to know its own
			// column count and widths before it can emit its first line, which a per-`<tr>` branch can
			// never know. See `table()` for why this stopped being `- a · b · c`.
			if ( tag === 'table' ) { const t = this.table( kid ); if ( t ) out.push( '', t, '' ); continue; }

			// `pre` is whitespace-SIGNIFICANT — its newlines ARE the content, so the collapse every
			// other block gets is suspended here and the text rides verbatim inside a markdown fence.
			// The fence is not decoration: without it a code example is indistinguishable from the
			// prose around it, and a reader cannot tell which newlines were authored.
			// The one text path that skips `inline()`, so it decodes entities itself — see `ENTITIES`.
			if ( tag === 'pre' ) { const t = this.decodeEntities( HtmlTree.textOf( kid ) ).replace( /^\n+|\s+$/g, '' ); if ( t ) out.push( '', '```\n' + t + '\n```', '' ); continue; }

			// A stray `<tr>` outside any table — the old flat form, kept as the fallback it always was.
			if ( tag === 'tr' ) {
				const cells = this.cellsOf( kid );
				if ( cells.some( Boolean ) ) out.push( '- ' + cells.filter( Boolean ).join( ' · ' ) );
				continue;
			}
			// Container ( body, article, section, ul, ol, div, … ) — recurse in.
			this.block( kid.kids, out );
		}
	}

	/**
	 * Body / section HTML → the LEAN read projection ( 2026-09-11, Bryan ): the same markdown `block()`
	 * already emits, with every blank line squeezed out.
	 *
	 * There is no second emitter here, and the absence is the point. This started as a tag-preserving
	 * walk ( `<h3>`, `<li>` kept ) and Bryan ruled it back: "keeping tags out. Tags are a filing
	 * mechanism that allows for the documentation to come down to the agent without all the formatting
	 * ceremony on the wire." A markdown `###` says what an `<h3>` says for a third the tokens, so the
	 * read path and the compile path want the SAME text and differ only in how much air sits between
	 * its blocks — which is a post-pass, not a parallel tree walk.
	 *
	 * Whitespace is structural, never decorative: no indentation, no blank lines, inline runs collapsed
	 * to single spaces, one newline between block siblings so two paragraphs cannot weld into one
	 * sentence. The two places that exemption does not reach are `pre` and a table, and both are
	 * handled in `block()` where BOTH projections get them — their whitespace is the content.
	 */
	lean( html: string ): string {
		return this.body( html, true );
	}

	/**
	 * One serialized artifact → its LEAN read shape: `sections` projected through `lean()`, and `body`
	 * GONE.
	 *
	 * Dropping the body is not an extra economy tacked onto the strip — it is the half that makes the
	 * strip safe. `body` is `kcd_save`'s edit payload ( kcd_get → mutate → kcd_save ), and a STRIPPED
	 * body handed back to that round trip would save a document with every `data-kcd-section` wrapper
	 * missing: refused outright on a closed type, and on an open one landed as a gutted file. A field
	 * that cannot survive the round trip must not be present wearing the name of the one that can, so
	 * the lean shape does not carry a smaller `body` — it carries none, and the caller that needs the
	 * real one asks for `full`.
	 *
	 * Nothing is lost by the omission that the shape does not already hold: `sections` is the body's
	 * keyed decomposition ( ~92% of its characters on a real lens ), the `<h1>` it drops is
	 * `frontmatter.name`, and the `<dl>` it drops is `frontmatter` itself. A lens's dredged `nodes`
	 * recurse through the same projection, since each child is an artifact read for the same reason.
	 */
	leanArtifact( a: SerializedArtifact ): LeanArtifact {
		const { body: _body, ...rest } = a;
		const lean: LeanArtifact = { ...rest, frontmatter: this.leanFrontmatter( a.frontmatter ), sections: this.leanSections( a.sections ) };
		const nodes = ( a as SerializedLens ).nodes;
		if ( Array.isArray( nodes ) ) lean.nodes = nodes.map( n => this.leanArtifact( n ) );
		return lean;
	}

	/** Frontmatter for the LEAN read: string values entity-decoded, every other value untouched.
	 *  `description` is the field an agent reads on EVERY artifact and on every dredged child, and it is
	 *  the densest `&mdash;` carrier in the vault. Decoding it is safe in this shape and in no
	 *  neighbouring one for the same reason the shape already drops `body`: lean is the READ projection,
	 *  never an edit payload. `full` keeps its frontmatter exactly as authored, because that one IS the
	 *  payload `kcd_save` writes back. */
	leanFrontmatter( fm: Record<string, unknown> ): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for ( const [ k, v ] of Object.entries( fm ) )
			out[ k ] = typeof v === 'string'  ? this.decodeEntities( v )
				: Array.isArray( v ) ? v.map( x => typeof x === 'string' ? this.decodeEntities( x ) : x )
				: v;
		return out;
	}

	/** `lean()` over an artifact's whole `sections` map, key by key. A section that projects to
	 *  nothing ( human-only throughout, or a Tools section ) is DROPPED rather than kept as an empty
	 *  string — an empty value reads as "this section exists and is blank", which is a different and
	 *  false claim. */
	leanSections( sections: Record<string, string> ): Record<string, string> {
		const out: Record<string, string> = {};
		for ( const [ name, html ] of Object.entries( sections ) ) {
			const text = this.lean( html );
			if ( text ) out[ name ] = text;
		}
		return out;
	}

	/** Above this width a column is left UNPADDED. Alignment is the affordance, but a prose column is
	 *  where it turns on itself: one 400-character Description would pad every other cell in that
	 *  column out to 400, and the table would cost more in trailing spaces than in content. Forty is
	 *  wide enough for the identifier / kind / default / path columns that alignment actually helps
	 *  and narrow enough that a sentence never qualifies. */
	PAD_CAP = 40;

	/**
	 * A real `<table>` → a markdown table ( Bryan, 2026-09-11: "parse tables into md format — it's an
	 * affordance for the agent, preserving white space" ).
	 *
	 * It used to flatten to one `- a · b · c` line per row, and the cost was not cosmetic: the HEADER
	 * row flattened identically to a data row, so a reader saw `- Name · Type · Default · Description`
	 * and had nothing but word-shape telling it that line was the key to the four below. A hundred
	 * artifacts carry one of these. Markdown's separator line restores exactly what was lost — which
	 * cell names a column and which fills one — and it is a form every model already reads fluently.
	 *
	 * This is the second exemption from the whitespace strip, `pre` being the first, and for the same
	 * reason: here the whitespace IS the affordance. Columns are padded to their widest cell so a
	 * value can be read down its column, capped at `PAD_CAP` so a prose column cannot turn the
	 * padding into the payload.
	 *
	 * A `|` inside a cell is escaped rather than dropped — an unescaped one silently splits a cell in
	 * two and every column after it in that row shifts by one, which is a wrong table that still
	 * looks like a table. Ragged rows are padded to the widest, for the same reason.
	 */
	table( el: HtmlEl ): string {
		const rows = HtmlTree.collect( el, e => e.tag === 'tr' )
			.filter( r => !this.dropped( r ) )
			.map( r => this.cellsOf( r ) )
			.filter( cells => cells.length > 0 );
		if ( !rows.length ) return '';

		// A table with no `<th>` anywhere still needs a header line to be a markdown table at all —
		// an EMPTY one, rather than promoting the first data row to a title it was never given.
		const headed = HtmlTree.collect( el, e => e.tag === 'th' ).length > 0;
		const width  = Math.max( ...rows.map( r => r.length ) );
		const grid   = rows.map( r => [ ...r, ...Array( width - r.length ).fill( '' ) ] );
		if ( !headed ) grid.unshift( Array( width ).fill( '' ) );

		// The LAST column is never padded: there is nothing to its right to align against, so its
		// padding is trailing whitespace on every row — pure cost, no affordance. Every other column
		// pads to its widest cell, or not at all once that exceeds `PAD_CAP`.
		const widths = Array.from( { length: width }, ( _, c ) => {
			if ( c === width - 1 ) return 0;
			const w = Math.max( 3, ...grid.map( r => r[ c ].length ) );
			return w > this.PAD_CAP ? 0 : w;
		} );
		const line = ( cells: string[] ) => '| ' + cells.map( ( v, c ) => v.padEnd( widths[ c ] ) ).join( ' | ' ) + ' |';

		const [ head, ...body ] = grid;
		return [
			line( head ),
			'| ' + widths.map( w => '-'.repeat( Math.max( 3, w ) ) ).join( ' | ' ) + ' |',
			...body.map( line ),
		].join( '\n' );
	}

	/** One row's cells as collapsed text, `|` escaped so a cell cannot split itself in two. Empty
	 *  cells are KEPT — a blank column is data about the row, and dropping it shifts every cell after
	 *  it left by one. */
	cellsOf( tr: HtmlEl ): string[] {
		return tr.kids
			.filter( HtmlTree.isEl )
			.filter( c => ( c.tag === 'td' || c.tag === 'th' ) && !this.dropped( c ) )
			.map( c => this.inline( c ).replace( /\|/g, '\\|' ) );
	}

	/** A dredge/nav slot's fields, read structurally — the data half of `slotLine`, shared by the flat
	 *  render path and the structured `rows` collection ( `collectRows` ) a routing merge dedupes on. */
	readSlot( slot: HtmlEl ): SlotRow {
		const cells: Record<string, string> = {};
		for ( const f of HtmlTree.collect( slot, el => KcdAddress.isField( el ) ) ) {
			const { key, value } = KcdAddress.readField( f );
			if ( key ) cells[ key ] = value;
		}
		// `rule` IS a `what`, and reading it as one is the whole fix — a rule row is a What with no Where and
		// no Why, so it needs no second row shape and no second render path. Until 2026-09-16 this returned
		// the three names alone and a `rule` cell fell on the floor: `renderRow` joined two empty strings and
		// emitted a bare '- ', so every rules section authored the way `author-reference` PRESCRIBES projected
		// as blank bullets. Seven documents, seventy-eight rules, none of it visible to an agent and all of it
		// rendering correctly for a human. The validator now refuses a slot that reads as nothing, so the next
		// unread field name is a loud failure rather than a silent one.
		return { what: cells[ 'what' ] ?? cells[ 'rule' ] ?? '', where: cells[ 'where' ] ?? '', why: cells[ 'why' ] ?? '' };
	}

	/** A `SlotRow` → one tight line. `where` rides as a parenthesized route, not a markdown link — the
	 *  agent has no browser, only the addressable path/url text, and that text is routing content, not
	 *  decoration ( plan ruling ). The ONE render path — a lone slot's flat render (`slotLine`) and a
	 *  routing merge's re-render of its deduped survivors both go through this, so the two can never
	 *  drift into two different row shapes. */
	renderRow( row: SlotRow ): string {
		// Entities decoded HERE rather than in `readSlot`, because this is the one place every row
		// becomes text: a slot read out of a document, AND a roster row `Agent` builds straight from a
		// lens's own frontmatter ( its lens-file rows, its grant rows ), which never passes through
		// `readSlot` at all. `where` is left verbatim — it is a route an agent retypes and a merge
		// dedupes on, not prose, and a path carrying a typographic entity is not a thing that exists.
		const text = [ row.what, row.why ].map( v => this.decodeEntities( v ) ).filter( Boolean ).join( ' — ' );
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
		const name        = this.decodeEntities( String( artifact.frontmatter[ 'name' ] ?? '' ).trim() );
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

		return [ line1, line2, ...this.paramBlocks( artifact.body ) ].filter( Boolean ).join( '\n' );
	}

	/** The section names whose ROWS the dense form carries as data rather than prose. The trap this
	 *  exists to prevent: a habit that declares rows the projection does not carry reads as populated
	 *  on disk while behaving, to the agent, as though the section were empty.
	 *
	 *  A section marked `data-kcd-audience="human"` is still skipped, which is the one way to withhold
	 *  rows — withholding is an audience question, never a section-name one.
	 *
	 *  There was a second, PRIVATE pole here until 2026-09-16, distinguished only by whether the agent
	 *  could author the rows. It went with its sole consumer; the edit boundary it drew was prose in
	 *  each habit's own rules, never anything this list enforced. */
	PARAM_SECTIONS = [ 'public-habit-params' ];

	/** Each params section as its own labelled block of rows — the label rides because a habit may carry
	 *  both, and a rule that says "never edit the whitelist" needs the reader to know which set it means.
	 *  Rows render through `renderRow`, the same one-line shape every other slot uses; a params row is an
	 *  ordinary `what` / `why` record, and inventing a second shape for it would be a translation for its
	 *  own sake. The cost is real and worth stating: a populated whitelist is the largest thing a habit
	 *  contributes to a session and it rides every turn. That is the price of the rows binding at all. */
	paramBlocks( html: string ): string[] {
		const out: string[] = [];
		if ( !html || !html.trim() ) return out;
		const root = HtmlTree.parse( html );
		for ( const el of HtmlTree.collect( root, e => KcdAddress.isSection( e ) ) ) {
			if ( KcdAddress.isHumanOnly( el ) ) continue;
			const name = HtmlTree.get( el, 'data-kcd-section' );
			if ( !name || !this.PARAM_SECTIONS.includes( name ) ) continue;
			const rows = this.collectRows( el.kids );
			if ( rows.length ) out.push( `↳ ${ name }:\n${ rows.map( r => this.renderRow( r ) ).join( '\n' ) }` );
		}
		return out;
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

	/**
	 * Named entities the vault actually authors, decoded ON THE WAY OUT to agent text and nowhere else.
	 *
	 * `HtmlTree.decode` deliberately does NOT know these ( it handles `&lt; &gt; &quot; &#39; &apos;
	 * &#NNN; &amp;` and stops ), and it must not learn them. Every `kcd_save` re-parses and
	 * re-serializes the body, so a `decode` wider than `escapeText` corrodes the entities it does not
	 * own — `&mdash;` came back as `&amp;mdash;` the last time that symmetry was broken, and
	 * `HtmlTree.entities.test.ts` pins the seam shut.
	 *
	 * The table lives on the PROJECTION side instead, where text is handed to a model and never written
	 * back, and that is exactly what makes it safe to be partial. Roughly 1,600 literal `&mdash;` /
	 * `&rdquo;` / `&rarr;` runs an agent was billed several tokens for each become one character, and
	 * not one byte on disk moves. Kept deliberately SMALL and explicit — what a census of the vault
	 * actually found, plus the near neighbours an author reaches for next — rather than a dependency or
	 * a thousand-row table nobody maintains.
	 *
	 * `&nbsp;` maps to an ORDINARY space, not U+00A0: this projection collapses whitespace anyway, and a
	 * non-breaking space is an invisible character that costs more and says nothing to a reader with no
	 * line to break.
	 *
	 * The one known loss: a source `&amp;mdash;` is already `&mdash;` by the time it reaches here, so
	 * prose QUOTING an entity as literal text reads as the character instead. That is the same
	 * non-injectivity `generators/apply-repairs` pins as a deliberate trade, it is one occurrence in the
	 * whole vault, and it costs a sentence's clarity rather than a byte of any file.
	 */
	ENTITIES: Record<string, string> = {
		mdash: '—', ndash:  '–', hellip: '…', nbsp:  ' ',
		ldquo: '“', rdquo:  '”', lsquo:  '‘', rsquo: '’',
		rarr:  '→', middot: '·', bull:   '•', times: '×', deg: '°',
	};

	/** Named entities → their characters, for agent-facing text ONLY ( see `ENTITIES` ). An unmapped
	 *  name passes through exactly as authored — this decodes what it knows and never guesses. */
	decodeEntities( s: string ): string {
		return s.includes( '&' ) ? s.replace( /&([a-zA-Z]+);/g, ( m, name ) => this.ENTITIES[ name ] ?? m ) : s;
	}

	/** Collapse a node's whole-subtree text to a single trimmed line. The entity decode runs BEFORE the
	 *  collapse, so a decoded `&nbsp;` folds into the run around it instead of surviving as a stray. */
	inline( n: HtmlNode ): string {
		return this.decodeEntities( HtmlTree.textOf( n ) ).replace( /\s+/g, ' ' ).trim();
	}
}();
