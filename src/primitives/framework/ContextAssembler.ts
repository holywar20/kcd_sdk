/**
 * ContextAssembler — merges and sorts a flat `TaggedBlock[]` into one source-blind context string.
 * The one path after both `Agent.contribute()` and `LensObject.serializeForContext()`, which order nothing themselves.
 * Blocks sharing a `mergeKey` fuse by stacking texts, never blending; a lens's own body leads.
 * Manifest sections get an implicit `manifest:<section>` key and compress to one table, deduped on `where`.
 * Tiers: care → memory → core → manifest → injected. `injected` sinks last so the cache-stable prefix never shifts.
 * `memory` is reserved and unreached, kept so hoisting a band is a routing decision, not a renumbering.
 */

import { KcdContext } from '../../core/html/KcdContext';
import type { TaggedBlock } from '../types';

/** The What/Where/Why sections of the bottom-of-context manifest; every consumer derives from this list.
 *  `grants` waits for compaction before promotion, or its row repeats a line still in the transcript. `domains` stays for now, its idiom undecided. */
export const MANIFEST_SECTIONS = [ 'references', 'domains', 'habits', 'contracts', 'grants' ] as const;

/** Section names that are manifest tables, not content ( see `MANIFEST_SECTIONS` ) — they
 *  merge-fuse across sources and sink to the bottom `manifest` tier. */
const MANIFEST_SECTION_SET = new Set<string>( MANIFEST_SECTIONS );

/** Band headings whose second line is a directive the agent reads on the wire. `Composition._blockLabel`
 *  shows only the first line, so the directive must stay inside the heading text. */
const KNOWLEDGE_HEADING = '# Knowledge\n_Required reading — injected in full; read all of it before acting._';
const MANIFEST_HEADING  = '# Manifest\n_Lookup surface — fetch these on demand; not required reading now._';

/** Canonical `##` heading per manifest section, one level below `# Manifest`. `###` stays free for a real future nesting level. Read through `title()`, never indexed directly. */
const MANIFEST_TITLE: Record<string, string> = Object.fromEntries(
	[ 'files', ...MANIFEST_SECTIONS ].map( s => [ s, `## ${ s.charAt( 0 ).toUpperCase() }${ s.slice( 1 ) }` ] )
);

export const ContextAssembler = new class ContextAssembler {

	/** The merged + sorted list before the join — the one place per-block reads go through, so inclusion is never computed two ways. */
	assembleBlocks( blocks: TaggedBlock[] ): TaggedBlock[] {
		return this.sort( this.merge( blocks ) );
	}

	/** The default `sep` is the separator every other context-layer join uses ( see `Agent.SYSTEM_SEP` ). */
	assemble( blocks: TaggedBlock[], sep = '\n\n---\n\n' ): string {
		return this.assembleBlocks( blocks ).map( b => b.text ).join( sep );
	}

	/** The key a block merges on: its authored `mergeKey`, or an implicit `manifest:<section>` for a manifest section. `null` passes through unmerged. */
	effectiveKey( b: TaggedBlock ): string | null {
		if ( b.mergeKey ) return b.mergeKey;
		if ( b.section && MANIFEST_SECTION_SET.has( b.section ) ) return `manifest:${ b.section }`;
		return null;
	}

	/** Fuses blocks sharing an effective key; unkeyed blocks pass through. A manifest key compresses via `mergeManifest`, any other stacks full texts.
	 *  Only `text` is a group function; every other field stays the first occurrence's. */
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

	/** One table from N manifest sections: structured `rows` deduped on each row's `where`, first-seen wins. Reads rows as data, never parses rendered text.
	 *  A `where`-less row keys on `what` + `why`. */
	mergeManifest( members: TaggedBlock[], title: string ): string {
		return [ title, ...this.manifestRows( members ).map( r => r.text ) ].join( '\n' );
	}

	/** The deduped rows, each paired with its `where`. Exposed so pricing reads the same rows as the render — the dedup rule lives here once. */
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

	/** One section's merged table under the canonical heading, so every rendering of a section has one shape. */
	manifestTable( members: TaggedBlock[], section: string ): string {
		return this.mergeManifest( members, this.title( section ) );
	}

	/** The one source of a manifest section's heading; no caller hardcodes `##`. */
	title( section: string ): string {
		return MANIFEST_TITLE[ section ] ?? `## ${ section.charAt( 0 ).toUpperCase() }${ section.slice( 1 ) }`;
	}

	/** A lens's own content leads within a merge group; everything else is a tie ( a stable sort
	 *  then keeps them in load order ). */
	lensRank( b: TaggedBlock ): number { return b.artifactType === 'lens' ? 0 : 1; }

	/** Sort tiers, named so a caller refers to a tier by what it is, and reordering is one edit here. */
	readonly TIER = { care: 0, memory: 1, core: 2, manifest: 3, injected: 4 } as const;

	/** This block's sort tier. Exposed so anything needing a tier boundary reads the same ranking, not a second derivation. */
	tierOf( b: TaggedBlock ): number {
		// Covers both kinds: session-dropped text and a package's injection are the same thing to the sort.
		if ( b.sourceLayer === 'injected' ) return this.TIER.injected;
		if ( b.region === 'care' ) return this.TIER.care;
		if ( b.section && MANIFEST_SECTION_SET.has( b.section ) ) return this.TIER.manifest;
		return this.TIER.core;
	}

	sort( blocks: TaggedBlock[] ): TaggedBlock[] {
		return blocks
			.map( ( b, i ) => ( { b, i } ) )
			.sort( ( x, y ) => this.tierOf( x.b ) - this.tierOf( y.b ) || x.i - y.i )
			.map( x => x.b );
	}

	/** Display heading per tier, deliberately not the internal tier names. `care` gets none here — its kind headings are built one layer up by `Agent.buildCareBands`; `injected` gets none. */
	bandHeading( tier: number ): string | null {
		return ( {
			[ this.TIER.memory ]:   '# Memory',
			[ this.TIER.core ]:     KNOWLEDGE_HEADING,
			[ this.TIER.manifest ]: MANIFEST_HEADING
		} as Record<number, string> )[ tier ] ?? null;
	}

	/** A synthetic heading with no source. A care-tier heading passes `'care'` so it sorts beside the prose it labels. */
	headingBlock( text: string, region: TaggedBlock[ 'region' ] = 'know' ): TaggedBlock {
		return { region, section: null, mergeKey: null, text, sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null };
	}

	/** Splices a band heading before each tier run in an already tier-sorted list. Opt-in, kept outside `assembleBlocks`/`sort`, so plain callers see no change. */
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
