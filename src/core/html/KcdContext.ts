/**
 * KcdContext — object-model → AI-audience context text. Projects the parsed `SerializedArtifact`, never the raw document.
 * NO TAGS SURVIVE either path (Bryan's ruling: a markdown `###` says what an `<h3>` says for a third the tokens), and
 * reading (`lean`) and compiling (`block`) differ by one boolean, not a second walk. What NEVER reaches an agent: `dropped()`.
 * `pre` and `<table>` are exempt from the whitespace strip — their whitespace is content.
 */

import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';
import { KcdAddress } from './KcdAddress';
import type { SerializedArtifact, SerializedLens } from '../../primitives/types';

/** Frontmatter fields that survive into the AI projection. Everything else ( author,
 *  schema-version, base, todo, completed, … ) is authoring bookkeeping a human maintains the
 *  file with — never behavior-relevant to the agent reading it. */
const FRONTMATTER_KEEP = [ 'name', 'description', 'status' ];

/** `care` is the lens-only identity tier above Know/Do. A non-lens artifact carries no region wrapper,
 *  so its whole body defaults to its own `getRole()` (`know` or `do`). */
export type ContextRegion = 'care' | 'know' | 'do';

/** `leanArtifact`'s output: a `SerializedArtifact` with `body` REMOVED, so the field a round trip would
 *  corrupt cannot be mistaken for the one it needs. */
export interface LeanArtifact extends Omit<SerializedArtifact, 'body'> {
	nodes?: LeanArtifact[];
}

/** One `data-kcd-slot` row, structured. A routing merge dedupes BY `where` (a real href), never by re-parsing
 *  rendered prose. See `ContextAssembler.mergeManifest`. */
export interface SlotRow {
	what: string;
	where: string;
	why: string;
}

/** One region-scoped slice `ContextAssembler` merges (by `mergeKey`) and sorts (by `region`). `rows` is the structured
 *  sibling of `text`, which a routing merge re-renders from; `section` is for tracing, never rendered. */
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
	 * The shared tail of the flat and per-region projectors. `tight` FILTERS empty entries rather than regex-squeezing the
	 * joined string: a `pre` or table rides as one entry with its own newlines, which a string squeeze would eat.
	 */
	renderNodes( nodes: HtmlNode[], tight = false ): string {
		const out: string[] = [];
		this.block( nodes, out );
		if ( tight ) return out.filter( s => s !== '' ).join( '\n' ).trim();
		return out.join( '\n' ).replace( /\n{3,}/g, '\n\n' ).trim();
	}

	/**
	 * One artifact → region-blocks, one per `data-kcd-section`. A lens's un-wrapped lede is `care`; a non-lens artifact
	 * has no region wrapper, so its blocks default to `defaultRegion`, which the caller passes as its `getRole()`.
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

		// No synthetic `# [type] path` head on the wire: identity rides ONCE in the manifest, never per artifact.
		// The flat `project()` still leads with the head, for the Atlas's human preview — a different audience.
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
	 * Gathers node groups for `projectBlocks`. Each recursion level keeps its OWN lede buffer, tagged with its own region:
	 * a Know-region's intro before its first section belongs to `know`, not to the artifact-level `ledeRegion`.
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
					const section = HtmlTree.get( kid, 'data-kcd-section' ) ?? null;
					out.push( {
						// A LENS'S TIER IS DERIVED, now that no lens carries a region wrapper: its references
						// are what it knows, and everything else — personality, philosophy — is who it is.
						region:   region === 'care' && section === 'references' ? 'know' : region,
						section,
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

	/** Raw `<h1>`–`<h6>` are human chrome and never ride the wire; only a heading marked `data-kcd-heading` survives.
	 *  Wire path only: the flat `project()` keeps every authored heading. */
	stripNonCanonicalHeadings( nodes: HtmlNode[] ): HtmlNode[] {
		const out: HtmlNode[] = [];
		for ( const n of nodes ) {
			if ( !HtmlTree.isEl( n ) ) { out.push( n ); continue; }
			if ( this.HEADINGS.has( n.tag ) && !HtmlTree.has( n, 'data-kcd-heading' ) ) continue;   // untagged heading → nuked
			out.push( { ...n, kids: this.stripNonCanonicalHeadings( n.kids ) } );
		}
		return out;
	}

	/** A `data-kcd-region` wrapper's DIRECT heading children are its K/C/D label — build-time chrome, never content.
	 *  Nested sections keep their own headings, since they sit a level deeper. */
	dropRegionLabel( kids: HtmlNode[] ): HtmlNode[] {
		return kids.filter( k => !( HtmlTree.isEl( k ) && this.HEADINGS.has( k.tag ) ) );
	}

	/**
	 * The POLICY half of the walk, held apart from rendering so `block` and `leanBlock` cannot drift about WHAT is dropped.
	 * Gates: audience, faux-table header rows, machine tags, and the Tools section (its `tool` slots feed the manifest).
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

			// A real `<table>` is taken WHOLE — a markdown table needs its column widths before its first line. See `table()`.
			if ( tag === 'table' ) { const t = this.table( kid ); if ( t ) out.push( '', t, '' ); continue; }

			// `pre` is whitespace-SIGNIFICANT: it rides verbatim in a fence, and the fence is what tells code from prose.
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
	 * The LEAN read projection: `block()`'s own markdown with the blank lines squeezed out. There is no second emitter,
	 * and that absence is the point: read and compile differ only in the air between blocks, never in the text.
	 */
	lean( html: string ): string {
		return this.body( html, true );
	}

	/**
	 * `body` is GONE, not stripped: it is `save_doc`'s edit payload, and a stripped one saved back would gut the file.
	 * A caller that needs the real one asks for `full`. Lens `nodes` recurse through the same projection.
	 */
	leanArtifact( a: SerializedArtifact ): LeanArtifact {
		const { body: _body, ...rest } = a;
		const lean: LeanArtifact = { ...rest, frontmatter: this.leanFrontmatter( a.frontmatter ), sections: this.leanSections( a.sections ) };
		const nodes = ( a as SerializedLens ).nodes;
		if ( Array.isArray( nodes ) ) lean.nodes = nodes.map( n => this.leanArtifact( n ) );
		return lean;
	}

	/** String values entity-decoded for the read; `full` keeps frontmatter as authored, because it IS the `save_doc` payload.
	 *  Other values untouched. */
	leanFrontmatter( fm: Record<string, unknown> ): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for ( const [ k, v ] of Object.entries( fm ) )
			out[ k ] = typeof v === 'string'  ? this.decodeEntities( v )
				: Array.isArray( v ) ? v.map( x => typeof x === 'string' ? this.decodeEntities( x ) : x )
				: v;
		return out;
	}

	/** `lean()` over the whole `sections` map. A section that projects to nothing is DROPPED, not kept as '': an empty value
	 *  reads as "exists and is blank", which is a different and false claim. */
	leanSections( sections: Record<string, string> ): Record<string, string> {
		const out: Record<string, string> = {};
		for ( const [ name, html ] of Object.entries( sections ) ) {
			const text = this.lean( html );
			if ( text ) out[ name ] = text;
		}
		return out;
	}

	/** Above this width a column is left UNPADDED: a prose column would pad every other cell to its length, costing more
	 *  in trailing spaces than in content. Forty fits identifier/kind/default/path columns and never a sentence. */
	PAD_CAP = 40;

	/**
	 * A real `<table>` → a markdown table: a flattened header row was indistinguishable from a data row. Columns pad to
	 * their widest cell, capped at `PAD_CAP`; a `|` in a cell is escaped, never dropped, or every later column shifts.
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

		// The LAST column is never padded: its padding would be pure trailing cost, with nothing to align against.
		// Every other column pads to its widest cell, or not at all once that exceeds `PAD_CAP`.
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

	/** One row's cells as collapsed text, `|` escaped. Empty cells are KEPT: dropping a blank
	 *  column shifts every cell after it left by one. */
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
		// `rule` IS a `what`: a rule row has no Where and no Why, so it needs no second row shape or render path.
		// The validator refuses a slot that reads as nothing, so an unread field name fails loudly, not silently.
		return { what: cells[ 'what' ] ?? cells[ 'rule' ] ?? '', where: cells[ 'where' ] ?? '', why: cells[ 'why' ] ?? '' };
	}

	/** A `SlotRow` → one tight line; `where` rides as a parenthesized route, not a link (the agent has no browser).
	 *  The ONE render path, so a lone slot and a routing merge can never drift into two row shapes. */
	renderRow( row: SlotRow ): string {
		// Entities decode HERE, the one place every row becomes text (roster rows from `Agent` skip `readSlot`).
		// `where` stays verbatim: it is a route a merge dedupes on, not prose.
		const text = [ row.what, row.why ].map( v => this.decodeEntities( v ) ).filter( Boolean ).join( ' — ' );
		return '- ' + ( row.where ? `${ text } (${ row.where })` : text );
	}

	/** A dredge/nav slot ( `what` / `where` / `why` fields ) → one tight line. Thin: read, then render. */
	slotLine( slot: HtmlEl ): string {
		return this.renderRow( this.readSlot( slot ) );
	}

	/** Every `data-kcd-slot` row inside a node array, structured. Recurses like `block()`, so a slot nested in a
	 *  `data-kcd-table` wrapper is found at any depth. */
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

	/** The dense habit projection. The ONE home for the form: `project()` and `projectBlocks()` both route a habit here,
	 *  so it can never render two ways. It never rewrites authored text; the rendered grammar keeps the English connector "when". */
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

	/** Sections whose ROWS the dense form carries. A row it skips reads as populated on disk but empty to the agent.
	 *  Withholding is an audience question (`data-kcd-audience="human"`), never a section-name one. */
	PARAM_SECTIONS = [ 'public-habit-params' ];

	/** Each params section as a labelled block of `renderRow` rows; the label rides because a habit may carry both sets.
	 *  A populated whitelist is the largest thing a habit contributes, and it rides every turn. */
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

	/** section-name → `{ text, items }` for a flat-sectioned artifact.
	 *  Human-only sections are skipped: they never reach the agent. */
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
	 * Decoded on the way OUT only: `HtmlTree.decode` must never learn these, or each `save_doc` round trip corrodes them.
	 * Kept small; `&nbsp;` is a plain space, not U+00A0.
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
