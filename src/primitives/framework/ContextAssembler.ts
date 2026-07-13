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
 * IMPLICIT merge key too ( `routing:<section>` ), even with no authored `data-kcd-merge-key` — Bryan,
 * 2026-07-11: those two sections are ROUTING TABLES ("what to read, and when"), not identity prose,
 * so every source's References table fuses into one, and every source's Habits table fuses into one.
 *
 * A routing merge is genuinely COMPRESSIVE, not a text stack ( Bryan, 2026-07-12: "we are going to
 * compress and squeeze out everything unnecessary, while paying faithful service to intent" — a
 * compiler, not a filing cabinet ): naively joining N sources' full section text repeats N headings, N
 * copies of boilerplate intro prose ("Specific named files. Load explicitly by path."), and — since
 * the SAME target routinely gets referenced from more than one source — duplicate rows pointing at
 * the identical file. `mergeRouting` dedupes on STRUCTURED IDENTITY, not text pattern-matching (
 * Bryan, 2026-07-12: "lean into the recursive nature of the inclusion... rather than a dedupe pass
 * with regular expression matching" ): every block already carries its rows as data
 * ( `ContextBlock.rows`, read straight off each `data-kcd-slot`'s fields by `KcdContext.collectRows` —
 * never re-derived by parsing rendered `text` back apart ), so the merge is a plain `Set<where>`
 * keyed on each row's real `where` ( the actual path/href — an identity, not a substring match ),
 * first-seen wins ( the earliest-loaded / lens's-own framing survives, same precedence the generic
 * merge already gives a lens's own content ), then rendered ONCE via `KcdContext.renderRow` — the
 * same render path a lone slot's flat text uses, so a merged row and an unmerged one can never drift
 * into two different shapes. The what/where/why routing information itself survives with ~zero loss;
 * what's squeezed out is exclusively repetition. This same structured-rows mechanism is what a habits
 * merge rides too — one dedupe path for every routing kind, not a bespoke pass per section name.
 *
 * WITHIN a non-routing merge group the stack order is "type conflict resolves by ordering, not
 * blending — a lens's own body leads; everything else keeps load order" (plan ruling): any member
 * whose `artifactType` is `'lens'` sorts first, then the rest in their original load order (a stable
 * sort, so two non-lens members never swap relative to each other).
 *
 * Sort: FOUR tiers, `care` → `core` → `routing` → `injected`. `care` floats to the very top ( the
 * cache-stable prefix — a lens's identity rarely changes turn to turn ). `core` is everything
 * else that isn't a routing table — the lens's own non-routing prose plus every ALWAYS-loaded
 * artifact's full text ( references included — Bryan, 2026-07-11: "a reference that's included
 * directly in context is written right at the top" ), load order preserved. `routing` is the
 * manifest sections ( `MANIFEST_SECTIONS` — References / Domains / Habits / Contracts ): pure
 * What/Where/Why pointers, not the content itself — they sink BELOW the substantive material, "next to each other" (their implicit merge already
 * puts each kind in one place), because routing information is secondary to the knowledge/identity
 * it's pointing at, not equal to it. `injected` ( session-dropped ) still sinks to the true bottom,
 * the volatile tail that must never invalidate the cache-stable prefix above it — including below
 * `routing`, since a routing table is authored/stable, not session-volatile. This is a deliberate
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
 * `INDEX_SECTIONS` ), the merge-dedupe + bottom-tier sink ( `ROUTING_SECTIONS` ), and the canonical
 * headings ( `ROUTING_TITLE`, via `title()` ) all derive from this list, so the three can never disagree
 * again — they DID before ( references+habits sank to the routing tier while domains+contracts stayed in
 * core ). `domains` rides for now, its idiom fate deferred ( Bryan: "feels like another form of a
 * reference" ). A `tools` / `parameters` surface slots in as ONE more entry when it lands. */
export const MANIFEST_SECTIONS = [ 'references', 'domains', 'habits', 'contracts' ] as const;

/** Section names that are manifest routing tables, not content ( see `MANIFEST_SECTIONS` ) — they
 *  merge-fuse across sources and sink to the bottom `routing` tier. */
const ROUTING_SECTIONS = new Set<string>( MANIFEST_SECTIONS );

/** The canonical merged heading per manifest section — one settled shape regardless of how many sources
 *  contributed rows or what heading LEVEL each source's own section happened to render at ( a top-level
 *  artifact's own References section renders `##`; a lens's nested one renders `###` — the merged block
 *  is a new synthesized entity, so it gets one settled shape, not whichever source's heading sorted
 *  first ). `files` — the synthesized lens roster that heads the manifest ( rows come from the loaded
 *  agents, not authored slots ) — is a manifest section too, so its heading is single-sourced here
 *  alongside the block-driven ones. Read through `title()`, never indexed directly. */
const ROUTING_TITLE: Record<string, string> = Object.fromEntries(
	[ 'files', ...MANIFEST_SECTIONS ].map( s => [ s, `### ${ s.charAt( 0 ).toUpperCase() }${ s.slice( 1 ) }` ] )
);

export const ContextAssembler = new class ContextAssembler {

	/** Merge by key, sort Care → core → routing → injected, then join. `sep` defaults to the
	 *  separator every other context-layer join already uses ( see `Agent.SYSTEM_SEP` ). */
	assemble( blocks: TaggedBlock[], sep = '\n\n---\n\n' ): string {
		return this.sort( this.merge( blocks ) ).map( b => b.text ).join( sep );
	}

	/** The key a block merges on — its authored `mergeKey`, or an implicit `routing:<section>` key
	 *  for a References/Habits section ( see the class doc ). `null` for anything else, which passes
	 *  through unmerged as before. */
	effectiveKey( b: TaggedBlock ): string | null {
		if ( b.mergeKey ) return b.mergeKey;
		if ( b.section && ROUTING_SECTIONS.has( b.section ) ) return `routing:${ b.section }`;
		return null;
	}

	/** Blocks sharing an effective key ( see `effectiveKey` ) fuse into one; unkeyed blocks pass
	 *  through untouched. A routing key ( `routing:<section>` ) compresses via `mergeRouting`
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
			if ( key.startsWith( 'routing:' ) ) {
				const section = members[ 0 ].section ?? '';
				placeholder.get( key )!.text = this.mergeRouting( members, this.title( section ) );
				continue;
			}
			const ordered = [ ...members ].sort( ( a, c ) => this.lensRank( a ) - this.lensRank( c ) );
			placeholder.get( key )!.text = ordered.map( m => m.text ).join( '\n\n' );
		}
		return out;
	}

	/** Compress N sources' routing sections into ONE table: every member's structured `rows` ( real
	 *  `SlotRow` data, not text ), deduped in a `Set` keyed on each row's actual `where` ( first-seen
	 *  wins — the earliest-loaded member's framing of a shared target survives, matching the "lens's
	 *  own content leads" precedence the generic merge already gives ), then rendered once via
	 *  `KcdContext.renderRow` under one canonical heading. A `where`-less row ( rare — a slot with no
	 *  link ) keys on its own `what`+`why` instead, since it has no other identity to dedupe by. See
	 *  the class doc for why this reads structured data rather than pattern-matching rendered text. */
	mergeRouting( members: TaggedBlock[], title: string ): string {
		const seen = new Set<string>();
		const lines: string[] = [];
		for ( const m of members ) {
			for ( const row of m.rows ?? [] ) {
				const key = row.where || `${ row.what } ${ row.why }`;
				if ( seen.has( key ) ) continue;
				seen.add( key );
				lines.push( KcdContext.renderRow( row ) );
			}
		}
		return [ title, ...lines ].join( '\n' );
	}

	/** The canonical merged routing table for one section ( `references` | `habits` ) across many source
	 *  blocks — the building block of `Agent.compile`'s top-of-context manifest. Reuses `mergeRouting` +
	 *  the canonical `ROUTING_TITLE` so a table rendered into the manifest and one merged inline can never
	 *  differ in shape. */
	routingTable( members: TaggedBlock[], section: string ): string {
		return this.mergeRouting( members, this.title( section ) );
	}

	/** The canonical heading for one manifest section — the single source both the merged routing tables
	 *  and the synthesized `Files` roster head read, so no caller hardcodes a `###` string. Falls back to
	 *  a capitalized section name for a section not ( yet ) in `ROUTING_TITLE`. */
	title( section: string ): string {
		return ROUTING_TITLE[ section ] ?? `### ${ section.charAt( 0 ).toUpperCase() }${ section.slice( 1 ) }`;
	}

	/** A lens's own content leads within a merge group; everything else is a tie ( a stable sort
	 *  then keeps them in load order ). */
	lensRank( b: TaggedBlock ): number { return b.artifactType === 'lens' ? 0 : 1; }

	/** Care first, then core content, then routing tables, injected last — load order preserved
	 *  within each tier ( see the class doc for the full rationale ). */
	sort( blocks: TaggedBlock[] ): TaggedBlock[] {
		const tier = ( b: TaggedBlock ): number => {
			if ( b.sourceLayer === 'injected' ) return 3;
			if ( b.region === 'care' ) return 0;
			if ( b.section && ROUTING_SECTIONS.has( b.section ) ) return 2;
			return 1;
		};
		return blocks
			.map( ( b, i ) => ( { b, i } ) )
			.sort( ( x, y ) => tier( x.b ) - tier( y.b ) || x.i - y.i )
			.map( x => x.b );
	}
}();
