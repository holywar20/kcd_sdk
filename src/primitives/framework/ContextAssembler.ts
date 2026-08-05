/**
 * ContextAssembler — merge + sort a flat `TaggedBlock[]` into one source-blind context string
 * ( context-optimization plan, Phase 2 ). The one unified path downstream of both
 * `Agent.contribute()` and `LensObject.serializeForContext()` — each builds its own tagged-block
 * list from its own graph, then hands it here. Neither does its own ordering anymore; this is the
 * one seam, matching how `KcdContext` is the one seam for per-artifact stripping. Lives beside
 * `KCDPrimitive`/`LensObject` (not under `agent/`) since both of those — a lower layer than Agent —
 * need it directly; `Agent.ts` consumes it from here rather than the reverse.
 *
 * Merge: blocks sharing a `mergeKey` fuse into ONE block — their texts stacked under no synthetic
 * header ( each section's own prose already carries its own heading ). Never a text blend — EXCEPT
 * the one deliberate exception below. `mergeKey` comes from `data-kcd-merge-key` — see
 * `KcdAddress.mergeKeyOf`'s doc for why that is a distinct attribute from the pre-existing intra-file
 * `data-kcd-merge` dedup marker. A block whose `section` is `'references'` or `'habits'` gets an
 * IMPLICIT merge key too ( `manifest:<section>` ), even with no authored `data-kcd-merge-key` — Bryan,
 * 2026-07-11: those two sections are MANIFEST TABLES ("what to read, and when"), not identity prose,
 * so every source's References table fuses into one, and every source's Habits table fuses into one.
 *
 * A manifest merge is genuinely COMPRESSIVE, not a text stack ( Bryan, 2026-07-12: "we are going to
 * compress and squeeze out everything unnecessary, while paying faithful service to intent" — a
 * compiler, not a filing cabinet ): naively joining N sources' full section text repeats N headings, N
 * copies of boilerplate intro prose ("Specific named files. Load explicitly by path."), and — since
 * the SAME target routinely gets referenced from more than one source — duplicate rows pointing at
 * the identical file. `mergeManifest` dedupes on STRUCTURED IDENTITY, not text pattern-matching (
 * Bryan, 2026-07-12: "lean into the recursive nature of the inclusion... rather than a dedupe pass
 * with regular expression matching" ): every block already carries its rows as data
 * ( `ContextBlock.rows`, read straight off each `data-kcd-slot`'s fields by `KcdContext.collectRows` —
 * never re-derived by parsing rendered `text` back apart ), so the merge is a plain `Set<where>`
 * keyed on each row's real `where` ( the actual path/href — an identity, not a substring match ),
 * first-seen wins ( the earliest-loaded / lens's-own framing survives, same precedence the generic
 * merge already gives a lens's own content ), then rendered ONCE via `KcdContext.renderRow` — the
 * same render path a lone slot's flat text uses, so a merged row and an unmerged one can never drift
 * into two different shapes. The what/where/why manifest information itself survives with ~zero loss;
 * what's squeezed out is exclusively repetition. This same structured-rows mechanism is what a habits
 * merge rides too — one dedupe path for every manifest kind, not a bespoke pass per section name.
 *
 * WITHIN a non-manifest merge group the stack order is "type conflict resolves by ordering, not
 * blending — a lens's own body leads; everything else keeps load order" (plan ruling): any member
 * whose `artifactType` is `'lens'` sorts first, then the rest in their original load order (a stable
 * sort, so two non-lens members never swap relative to each other).
 *
 * Sort: FIVE tiers, `care` → `memory` → `core` → `manifest` → `injected` ( compiled-context plan,
 * band model re-ratified 2026-07-13 ). `care` floats to the very top ( the cache-stable prefix — a
 * lens's identity rarely changes turn to turn ) and surfaces on the wire as one top-level
 * by-KIND care band — one top-level `# Purpose` / `# Philosophy` block PER care kind, each merging every
 * active lens's contribution as labeled `## {lens}` sub-sections ( `Agent.buildCareBands` builds them,
 * since it knows lens names + primacy; primary leads and is marked, `_lens-base` follows as `Base lens` ).
 * No "## Lenses" wrapper. `memory` is the system-fired PRELOAD baseline ( `section: 'memory'`,
 * injected by the orchestrator, not authored ) — it now sits BETWEEN the Lenses band and Knowledge
 * ( Bryan, 2026-07-13: "add a space for memory... after the lenses but before knowledge" ), reserved
 * even while empty. `core` is everything else that isn't a manifest table — the lens's own non-routing
 * prose plus every ALWAYS-loaded artifact's full text ( references included — Bryan, 2026-07-11: "a
 * reference that's included directly in context is written right at the top" ), load order preserved;
 * it surfaces as the **Knowledge** band, framed as forced-read injected content ( `KNOWLEDGE_HEADING` ).
 * `manifest` is the manifest sections ( `MANIFEST_SECTIONS` — References / Domains / Habits /
 * Contracts ): pure What/Where/Why pointers, not the content itself — they sink BELOW the substantive
 * material, "next to each other" (their implicit merge already puts each kind in one place), because
 * a lookup surface is secondary to the knowledge/identity it points at, not equal to it, and is framed
 * as read-on-demand ( `MANIFEST_HEADING` ). `injected` ( session-dropped ) still sinks to the true bottom,
 * the volatile tail that must never invalidate the cache-stable prefix above it — including below
 * `manifest`, since a manifest table is authored/stable, not session-volatile. This is a deliberate
 * break from region-only tiering (Know/Do no longer determine position on their own — Bryan,
 * 2026-07-11: "we have a more granular understanding of where things go now"); `region` still
 * drives the lens/reference/habit's OWN internal decomposition, just not the final sort key alone.
 * A stable index tiebreak preserves load order within each tier regardless of the host JS engine's
 * sort-stability guarantees.
 */

import { KcdContext } from '../../core/html/KcdContext';
import type { TaggedBlock } from '../types';

/**
 * MANIFEST_SECTIONS — the ordered What/Where/Why sections that compose the bottom-of-context MANIFEST:
 * the curated surface of interactable affordances an agent hits INDIRECTLY through a tool ( fetch a
 * reference, apply a habit, honor a contract ). It is NOT content — it is a section of tools /
 * interactable surfaces, declared so the CURATION of this surface is a first-class, high-leverage lever
 * ( Bryan, 2026-07-12 ). ONE source of truth: the manifest hoist set ( `Agent.INDEX_ORDER` /
 * `INDEX_SECTIONS` ), the merge-dedupe + bottom-tier sink ( `MANIFEST_SECTION_SET` ), and the canonical
 * headings ( `MANIFEST_TITLE`, via `title()` ) all derive from this list, so the three can never disagree
 * again — they DID before ( references+habits sank to the manifest tier while domains+contracts stayed in
 * core ). `domains` rides for now, its idiom fate deferred ( Bryan: "feels like another form of a
 * reference" ).
 *
 * `grants` is the first entry sourced from a SESSION rather than from an artifact — what the user handed
 * this run, CANONIZED here once its turns are compacted. Until then the grant's own reference line is
 * already riding in the transcript, so a row here would state the same fact twice; promotion waits for
 * compaction because that is the one moment the prefix is being rewritten anyway, which is the same
 * reason removal waits for it. One deferral protocol, two mutations.
 *
 * A `tools` / `parameters` surface slots in as ONE more entry when it lands. */
export const MANIFEST_SECTIONS = [ 'references', 'domains', 'habits', 'contracts', 'grants' ] as const;

/** Section names that are manifest tables, not content ( see `MANIFEST_SECTIONS` ) — they
 *  merge-fuse across sources and sink to the bottom `manifest` tier. */
const MANIFEST_SECTION_SET = new Set<string>( MANIFEST_SECTIONS );

/** The two directive-bearing band headings ( compiled-context plan, band model re-ratified
 *  2026-07-13 ). **Knowledge** is INJECTED context the agent must read in full; the **Manifest** is a
 *  read-on-demand lookup surface it may fetch but isn't required to read now. The directive line rides
 *  the real wire text — it's part of the heading block — so the instruction reaches the AGENT, not
 *  just a human reading a UI ( `Composition._blockLabel` shows only the first line in the summary ). */
const KNOWLEDGE_HEADING = '# Knowledge\n_Required reading — injected in full; read all of it before acting._';
const MANIFEST_HEADING  = '# Manifest\n_Lookup surface — fetch these on demand; not required reading now._';

/** The canonical merged heading per manifest section — one settled shape regardless of how many sources
 *  contributed rows or what heading LEVEL each source's own section happened to render at ( a top-level
 *  artifact's own References section renders `##`; a lens's nested one renders `###` — the merged block
 *  is a new synthesized entity, so it gets one settled shape, not whichever source's heading sorted
 *  first ). `files` — the synthesized lens roster that heads the manifest ( rows come from the loaded
 *  agents, not authored slots ) — is a manifest section too, so its heading is single-sourced here
 *  alongside the block-driven ones. Read through `title()`, never indexed directly.
 *
 *  Level `##`, one below the `# Manifest` band heading — deliberately NOT `###` ( Bryan, 2026-07-14:
 *  "in case we ever want to add a third or a subcategory" ). Reserves `###` for a real future nesting
 *  level ( e.g. grouping References by folder category on the wire, mirroring how the UI already
 *  folders them ) rather than a level these sections merely inherited without one being available under
 *  them. Purely a heading-text change: `#`→`##` keeps the exact same parent/child fold relationship to
 *  `# Manifest` that `#`→`###` had, just without skipping a level. */
const MANIFEST_TITLE: Record<string, string> = Object.fromEntries(
	[ 'files', ...MANIFEST_SECTIONS ].map( s => [ s, `## ${ s.charAt( 0 ).toUpperCase() }${ s.slice( 1 ) }` ] )
);

export const ContextAssembler = new class ContextAssembler {

	/** The merged + sorted list — care → memory → core → manifest → injected — before the join. The one place
	 *  both `assemble()`'s text join and any future per-block projection ( e.g. token weights, the
	 *  compiled-context plan's `Agent.compiledBlocks()` ) read, so inclusion can never be computed two
	 *  different ways. */
	assembleBlocks( blocks: TaggedBlock[] ): TaggedBlock[] {
		return this.sort( this.merge( blocks ) );
	}

	/** Merge by key, sort care → memory → core → manifest → injected, then join. `sep` defaults to the
	 *  separator every other context-layer join already uses ( see `Agent.SYSTEM_SEP` ). */
	assemble( blocks: TaggedBlock[], sep = '\n\n---\n\n' ): string {
		return this.assembleBlocks( blocks ).map( b => b.text ).join( sep );
	}

	/** The key a block merges on — its authored `mergeKey`, or an implicit `manifest:<section>` key
	 *  for a References/Habits section ( see the class doc ). `null` for anything else, which passes
	 *  through unmerged as before. */
	effectiveKey( b: TaggedBlock ): string | null {
		if ( b.mergeKey ) return b.mergeKey;
		if ( b.section && MANIFEST_SECTION_SET.has( b.section ) ) return `manifest:${ b.section }`;
		return null;
	}

	/** Blocks sharing an effective key ( see `effectiveKey` ) fuse into one; unkeyed blocks pass
	 *  through untouched. A manifest key ( `manifest:<section>` ) compresses via `mergeManifest`
	 *  ( rows extracted + deduped, one heading ); any other key ( an authored `data-kcd-merge-key` )
	 *  keeps the original stack-the-full-texts behavior ( lens-first, then load order ). Either way
	 *  the fused block's other fields ( region/section/sourceLayer/path/artifactType ) stay the FIRST
	 *  occurrence's — only `text` is a function of the whole group. */
	merge( blocks: TaggedBlock[] ): TaggedBlock[] {
		const out: TaggedBlock[] = [];
		const groups = new Map<string, TaggedBlock[]>();
		const placeholder = new Map<string, TaggedBlock>();

		for ( const b of blocks ) {
			const key = this.effectiveKey( b );
			if ( !key ) { out.push( b ); continue; }
			const existing = groups.get( key );
			if ( existing ) { existing.push( b ); continue; }
			groups.set( key, [ b ] );
			const clone = { ...b };
			placeholder.set( key, clone );
			out.push( clone );
		}

		for ( const [ key, members ] of groups ) {
			if ( key.startsWith( 'manifest:' ) ) {
				const section = members[ 0 ].section ?? '';
				placeholder.get( key )!.text = this.mergeManifest( members, this.title( section ) );
				continue;
			}
			const ordered = [ ...members ].sort( ( a, c ) => this.lensRank( a ) - this.lensRank( c ) );
			placeholder.get( key )!.text = ordered.map( m => m.text ).join( '\n\n' );
		}
		return out;
	}

	/** Compress N sources' manifest sections into ONE table: every member's structured `rows` ( real
	 *  `SlotRow` data, not text ), deduped in a `Set` keyed on each row's actual `where` ( first-seen
	 *  wins — the earliest-loaded member's framing of a shared target survives, matching the "lens's
	 *  own content leads" precedence the generic merge already gives ), then rendered once via
	 *  `KcdContext.renderRow` under one canonical heading. A `where`-less row ( rare — a slot with no
	 *  link ) keys on its own `what`+`why` instead, since it has no other identity to dedupe by. See
	 *  the class doc for why this reads structured data rather than pattern-matching rendered text. */
	mergeManifest( members: TaggedBlock[], title: string ): string {
		return [ title, ...this.manifestRows( members ).map( r => r.text ) ].join( '\n' );
	}

	/**
	 * The deduped manifest rows, still ADDRESSABLE — each surviving row paired with the `where` it is keyed
	 * on. `mergeManifest` is a join over this, so the dedup rule lives once.
	 *
	 * Exposed because a routing row is the ONLY thing an `on` artifact contributes to the compiled context,
	 * which makes this the sole place its real cost can be read. Priced from the merged table it cannot be
	 * ( the table is one block of text ), and re-derived independently it would be an estimate sitting beside
	 * real numbers — the exact drift this whole collapse exists to remove. `Agent.composition` reads it to
	 * give every file a true weight.
	 */
	manifestRows( members: TaggedBlock[] ): { where: string; text: string }[] {
		const seen = new Set<string>();
		const out: { where: string; text: string }[] = [];
		for ( const m of members ) {
			for ( const row of m.rows ?? [] ) {
				const key = row.where || `${ row.what } ${ row.why }`;
				if ( seen.has( key ) ) continue;
				seen.add( key );
				out.push( { where: row.where ?? '', text: KcdContext.renderRow( row ) } );
			}
		}
		return out;
	}

	/** The canonical merged manifest table for one section ( `references` | `habits` ) across many source
	 *  blocks — the building block of `Agent.compile`'s bottom-of-context manifest. Reuses `mergeManifest` +
	 *  the canonical `MANIFEST_TITLE` so a table rendered into the manifest and one merged inline can never
	 *  differ in shape. */
	manifestTable( members: TaggedBlock[], section: string ): string {
		return this.mergeManifest( members, this.title( section ) );
	}

	/** The canonical heading for one manifest section — the single source both the merged manifest tables
	 *  and the synthesized `Files` roster head read, so no caller hardcodes a `##` string. Falls back to
	 *  a capitalized section name for a section not ( yet ) in `MANIFEST_TITLE`. */
	title( section: string ): string {
		return MANIFEST_TITLE[ section ] ?? `## ${ section.charAt( 0 ).toUpperCase() }${ section.slice( 1 ) }`;
	}

	/** A lens's own content leads within a merge group; everything else is a tie ( a stable sort
	 *  then keeps them in load order ). */
	lensRank( b: TaggedBlock ): number { return b.artifactType === 'lens' ? 0 : 1; }

	/** The sort tiers, by MEANING — care → memory → core → manifest → injected ( band model re-ratified
	 *  2026-07-13: memory moved ABOVE core, "after the lenses but before knowledge"; routing renamed
	 *  manifest ). Named ( not bare literals scattered through `tierOf`/`bandHeading`/`Agent.compiledBlocks` )
	 *  so a caller references a tier by what it IS, and reordering one is a single edit here rather than a
	 *  hunt for every magic number. Surfaced band names: care→by-kind `# Purpose` / `# Philosophy` ( no
	 *  wrapper, built by `Agent.buildCareBands` ), memory→Memory, core→Knowledge, manifest→Manifest ( `bandHeading` ). */
	readonly TIER = { care: 0, memory: 1, core: 2, manifest: 3, injected: 4 } as const;

	/** This block's sort tier ( see `TIER` ). Exposed ( not just a `sort()`-local closure ) so
	 *  `withBandHeadings` — and anything else that needs to know a tier boundary rather than just the
	 *  final order — reads the exact same ranking, never a second derivation of it. */
	tierOf( b: TaggedBlock ): number {
		if ( b.sourceLayer === 'injected' ) return this.TIER.injected;
		if ( b.region === 'care' ) return this.TIER.care;
		if ( b.section === 'memory' ) return this.TIER.memory;
		if ( b.section && MANIFEST_SECTION_SET.has( b.section ) ) return this.TIER.manifest;
		return this.TIER.core;
	}

	/** Care ( Lenses ) first, then memory, then core content ( Knowledge ), then the manifest tables,
	 *  injected last — load order preserved within each tier ( see the class doc for the full rationale ). */
	sort( blocks: TaggedBlock[] ): TaggedBlock[] {
		return blocks
			.map( ( b, i ) => ( { b, i } ) )
			.sort( ( x, y ) => this.tierOf( x.b ) - this.tierOf( y.b ) || x.i - y.i )
			.map( x => x.b );
	}

	/** Display-band heading per tier ( compiled-context plan, band model re-ratified 2026-07-13 ) —
	 *  deliberately NOT the internal region/tier vocabulary: "Knowledge," not "Know"/"core," since
	 *  Know/Care/Do's future as internal categories is unsettled. The `care` tier gets NO wrapper heading
	 *  here: care is grouped by KIND into top-level `# Purpose` / `# Philosophy` bands ( no "## Lenses"
	 *  parent — Bryan's attention model: the output is grouped by kind, and each source lens is a labeled
	 *  `## {lens}` sub-section under it ), built by `Agent.buildCareBands` since it knows lens names + primacy.
	 *  Knowledge / Manifest carry a directive line ( forced-read vs read-on-demand ). `null` for any tier with
	 *  no settled heading — including `care` ( the kind headings live one layer up ) and `injected`
	 *  ( session-dropped content is NOT the plan's "Turn History" band — see Phase 6 ). */
	bandHeading( tier: number ): string | null {
		return ( {
			[ this.TIER.memory ]:   '# Memory',
			[ this.TIER.core ]:     KNOWLEDGE_HEADING,
			[ this.TIER.manifest ]: MANIFEST_HEADING
		} as Record<number, string> )[ tier ] ?? null;
	}

	/** One synthetic heading block — no source artifact, so tagged neutrally like every other
	 *  compiler-synthesized block ( the dividers, the manifest tables ). `region` defaults to `'know'`;
	 *  a care-tier band/sub-heading ( the Lenses band's `### {name}` rows ) passes `'care'` so it sorts
	 *  into the care tier alongside the identity prose it labels. */
	headingBlock( text: string, region: TaggedBlock[ 'region' ] = 'know' ): TaggedBlock {
		return { region, section: null, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** Splice a band heading before the first block of each tier run in an ALREADY tier-sorted list
	 *  ( `assembleBlocks`'s output, or any other list sharing its ordering ). A tier with no settled
	 *  heading ( `bandHeading` returns `null` ) gets none; a tier with no members contributes nothing
	 *  to splice around — this never invents a heading for an empty band. Kept as an explicit, opt-in
	 *  step rather than folded into `assembleBlocks`/`sort` themselves, so every EXISTING caller
	 *  ( `LensObject.serializeForContext`, the unit tests ) keeps its plain merged+sorted list with no
	 *  behavior change; only a caller that wants display bands asks for them. */
	withBandHeadings( sorted: TaggedBlock[] ): TaggedBlock[] {
		const out: TaggedBlock[] = [];
		let lastTier: number | null = null;
		for ( const b of sorted ) {
			const t = this.tierOf( b );
			if ( t !== lastTier ) {
				const heading = this.bandHeading( t );
				if ( heading ) out.push( this.headingBlock( heading ) );
				lastTier = t;
			}
			out.push( b );
		}
		return out;
	}
}();
