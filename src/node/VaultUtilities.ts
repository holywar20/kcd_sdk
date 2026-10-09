import * as fs from 'fs';
import { KCDPrimitive, KCDValidationError, LensObject } from '../primitives';
import type { SlotMode, LinkEntry, AddressEntry } from '../primitives';
import type { Vault } from './Vault';
import type { ArtifactRef } from '../core';
import { VaultLayout, Glob } from '../core';

/** Where the seed source lives, vault-relative — protocol §10's one payload-per-host document. */
const ROOT_CONTEXT_PATH = 'root-context.html';

/** The doc root is a project variable read off the vault, never a constant here — a literal would
 *  assert one vendor owns the folder. */

/** One validation finding. `error` blocks; `warn` is advisory hygiene. */
export interface HealthIssue {
	path:      string;
	severity:  'error' | 'warn';
	message:   string;
	field?:    string;
	section?:  string;
}

/**
 * `scanned` and `checked` are THE DENOMINATOR: `{ total: 0 }` cannot tell "examined 314 and found
 * nothing" from "examined nothing". A clean report over an empty input must not read as healthy.
 */
export interface HealthReport {
	issues:  HealthIssue[];
	summary: {
		/** Files the scan walked, before any filtering. Zero means there was nothing to check. */
		scanned:  number;
		/** Documents actually parsed and validated — the real denominator. `scanned - checked` is what
		 *  the filters passed over. */
		checked:  number;
		total:    number;
		errors:   number;
		warnings: number;
	};
}

/** The result of a lens compile — the identifiers asked for, the compiled context text, its token estimate. */
export interface CompileResult {
	lenses: string[];
	text:   string;
	tokens: number;
}

/** Display state of one lens-view row: its dredge mode, `empty`, or `fixed` for content no lens authors.
 *  DISPLAY-ONLY and deliberately NOT `SlotMode`, so a new value here cannot reach the slotting surfaces. */
export type SlotState = SlotMode | 'empty' | 'fixed';

export interface LensSlot {
	what:   string;
	kind:   string;
	/** Which lens this row's content came from — the inspected lens's own name for its identity and slots,
	 *  `—` for content that merges several sources or belongs to none. */
	source: string;
	/** The mutual-exclusion slot this row competes in ( `habit-class` ), or '' when it contends nothing.
	 *  Two rows sharing a slot means only one of them reached the compiled context. */
	slot:   string;
	state:  SlotState;
	tokens: number;
}

/** Priced from a BUILT AGENT: what a session wearing this lens actually receives. The rows sum to `tokens`. */
export interface LensView {
	lens:   string;
	path:   string;
	slots:  LensSlot[];
	tokens: number;
}

/** Query options — all optional and AND-combined; `groupBy: 'type'` switches the return shape. */
export interface QueryOptions {
	glob?:    string;
	type?:    string;
	text?:    string;
	groupBy?: 'type';
	/** 1-based. Out of range clamps to the last page rather than answering empty. Ignored by a census. */
	page?:    number;
}

/** Either the matching refs, or — with `groupBy: 'type'` — a type census sorted by count descending. */
export type QueryMatches = ArtifactRef[] | { type: string; count: number }[];

/** `unreadable` is not a failed match: those documents were never examined, so the answer is silent about them. */
export interface QueryResult {
	matches:    QueryMatches;
	unreadable: string[];
	/** How many refs matched IN TOTAL, before the page was cut — so a caller holding 20 rows knows
	 *  whether it is holding the answer or the start of one. A census reports its own length. */
	total:      number;
	/** The page returned, 1-based, and how many there are. Both are `1` for a census or a single-page result. */
	page:       number;
	pages:      number;
}

/** One artifact's link graph: what it points at, its addresses ( occupied or not ), and who points at it. */
export interface LinksResult {
	outbound:  LinkEntry[];
	addresses: ( AddressEntry & { occupied: boolean } )[];
	inbound:   { path: string; relativePath: string }[];
}

/** One §10 seed payload, parsed off `root-context.html` — a host, its target file, how it writes,
 *  and the raw payload text. */
export interface SeedBlock {
	host:    string;
	/** Project-root-relative — where a §10 seed always targets ( it names a file OUTSIDE the vault ). */
	target:  string;
	mode:    'prepend' | 'create-only';
	payload: string;
}

/** Nothing produces this any more; kept because it is exported through the `@kcd` barrel. */
export interface SeedApplyReport {
	host:            string;
	target:          string;
	mode:            'prepend' | 'create-only';
	targetExisted:   boolean;
	/** `prepend` only — did a `<!-- kcd:begin/end -->` block already exist to replace? */
	hadManagedBlock: boolean;
	/** Would writing actually change the file's content? False = already up to date. */
	changed:         boolean;
	applied:         boolean;
}

/** `fileRemoved` is true only when our block WAS the whole file, so nothing of the project's own was at stake. */
export interface SeedRemoveReport {
	host:            string;
	target:          string;
	targetExisted:   boolean;
	hadManagedBlock: boolean;
	fileRemoved:     boolean;
	changed:         boolean;
	applied:         boolean;
}

/** How much of the vault a project wants kept out of git. `none` removes the managed block. */
export type IgnoreScope = 'scratch' | 'vault' | 'none';

/** Nothing writes a managed block into `.gitignore` any more; kept for the `@kcd` barrel. */
export interface IgnoreReport {
	target:          string;
	scope:           IgnoreScope;
	/** The lines the block would hold. Empty for `none`. */
	entries:         string[];
	targetExisted:   boolean;
	hadManagedBlock: boolean;
	changed:         boolean;
	applied:         boolean;
}



/** No producer any more: the live deploy path is `VaultDeploy.apply`, which does not return this shape. */
export interface ResetReport {
	/** The deployed target, vault-relative. */
	path:          string;
	/** Its canonical counterpart — an absolute path into the bundle's `substrateSource`, or `''`
	 *  when no `InstallManifest` row covers this target at all. */
	canonicalPath: string;
	/** Does anything exist at the canonical path to restore FROM? */
	hasCanonical:  boolean;
	/** Did the deployed target exist before this call? */
	targetExisted: boolean;
	/** Byte-identical to canonical already? `false` when either side is unreadable. */
	identical:     boolean;
	/** True only when `confirm` was set AND a write actually happened. */
	applied:       boolean;
	/**
	 * Whole-line multiset difference, null when there is nothing to compare. "Differs" is normal: canonical is the
	 * genericized copy. Read the totals first: a minified copy and its wrapped twin differ in line count alone.
	 */
	drift:         {
		onlyInDeployed:  number;
		onlyInCanonical: number;
		/** Total lines on each side — the discriminator between content drift and reflow. */
		deployedLines:   number;
		canonicalLines:  number;
	} | null;
}

/**
 * What to do with a `kcd/` file. `extract-template` is reported, never applied: where a template goes is a
 * packaging decision this generic utility should not make.
 */
export type MigrationActionKind = 'delete-duplicate' | 'relocate' | 'extract-template';

export interface MigrationAction {
	kind:          MigrationActionKind;
	/** Vault-relative, always under `kcd/`. */
	kcdPath:       string;
	/** `relocate` only — vault-relative destination. */
	targetPath?:   string;
	/** `delete-duplicate` only — the real, already-deployed copy's vault-relative path. */
	deployedPath?: string;
	/** `delete-duplicate` only — did the `kcd/` copy's content actually differ from the deployed
	 *  one? Informational; the action is identical either way ( the deployed copy always wins ). */
	diverged?:     boolean;
}

/** Nothing produces this any more; kept because it is exported through the `@kcd` barrel. */
export interface MigrationPlan {
	actions: MigrationAction[];
	notes:   string[];
}

/** Nothing produces this any more; kept for the `@kcd` barrel. */
export interface MigrationApplyReport {
	action:  MigrationAction;
	applied: boolean;
	error?:  string;
}

/** Nothing produces this any more; kept for the `@kcd` barrel. */
export interface StylesheetFixReport {
	path:    string;
	oldHref: string;
	newHref: string;
	applied: boolean;
	/** Reported apart from the href: a document can carry a correct link and no tier-1 baseline, which renders
	 *  in a browser and is unreadable in a viewer that will not load a stylesheet. */
	baselineAdded: boolean;
}

/**
 * Higher-order vault routines over Vault primitives; every caller reaches the same method.
 * REGENERATING `CLAUDE.md` FROM `root-context.html` IS RULED OUT: a host file that does not track the seed source is a decision.
 */
export class VaultUtilities {

	/** A constant, not a parameter: a per-call limit is honoured by whoever already knew to set it, never by the
	 *  caller paying the cost. Twenty is what a reader can scan before deciding to narrow. */
	static readonly QUERY_PAGE_SIZE = 20;

	/**
	 * Validates one artifact or the whole vault. The sweep walks `documentPaths()`, not `scan()`, because the malformed
	 * document is the one `scan()` drops. `scanned - checked` is by design. Blind spot: only `_Claude/`-rooted hrefs resolve.
	 */
	static health( vault: Vault, onlyFile?: string ): HealthReport {
		const issues: HealthIssue[] = [];
		let scanned = 0;
		let checked = 0;

		const checkFile = ( filePath: string ) => {
			checked++;
			const rel = vault.toVaultRel( filePath );

			try {
				const artifact = KCDPrimitive.fromHtml( vault.read( filePath ), vault.toAbs( filePath ), vault.docRoot );

				for ( const issue of artifact.typeCheck() )
					issues.push( { path: rel, ...issue } );
			} catch ( e ) {
				// One issue per error, not per document: `message` names only the first, and the tally is what a repair loop reads.
				if ( e instanceof KCDValidationError && e.errors.length > 0 ) {
					for ( const err of e.errors )
						issues.push( { path: rel, severity: 'error', message: `${ err.code } @ ${ err.where } — ${ err.msg }` } );
				} else {
					issues.push( {
						path:     rel,
						severity: 'error',
						message:  e instanceof Error ? e.message : String( e ),
					} );
				}
			}
		};

		if ( onlyFile ) {
			scanned = 1;
			checkFile( onlyFile );
		} else {
			// The library gate (`isLibraryPath`) and the document-kind gate: a `.js` utility is not a document, so
			// grading it against the schema would be a category error. Enumerate the filesystem, not `scan()`.
			for ( const rel of vault.documentPaths() ) {
				scanned++;
				if ( vault.isLibraryPath( rel ) ) checkFile( rel );
			}
		}

		for ( const ri of vault.referenceIssues( onlyFile || undefined ) )
			issues.push( { path: ri.path, severity: ri.severity, message: ri.message } );

		return {
			issues,
			summary: {
				scanned,
				checked,
				total:    issues.length,
				errors:   issues.filter( i => i.severity === 'error' ).length,
				warnings: issues.filter( i => i.severity === 'warn' ).length,
			},
		};
	}

	/**
	 * Compiles lens names (bare or vault-relative path, `[0]` primary) through a built agent. A vault agent binds
	 * no environment (root context, MCP tools, memory), so this compiles the lenses alone.
	 */
	static compile( vault: Vault, lensNames: string[] ): CompileResult {
		const agent    = vault.buildAgent( lensNames );
		const compiled = agent.lenses.map( l => l.getName() );
		const text     = agent.compile();

		return { lenses: compiled, text, tokens: KCDPrimitive._estimateTokens( text ) };
	}

	/**
	 * A projection of `Agent.composition()`, file by file, so the chart cannot disagree with what it describes.
	 * An `off` file stays listed at zero; there is no aggregate row, since pooling weights makes an `on` file read as free.
	 */
	static lensView( vault: Vault, name: string ): LensView {
		const rel = vault.lensPath( name );
		if ( !fs.existsSync( vault.toAbs( rel ) ) )
			throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );

		const agent = vault.buildAgent( [ name ] );
		const lens  = agent.lenses[ 0 ];
		const total = KCDPrimitive._estimateTokens( agent.compile() );

		const slots: LensSlot[] = agent.composition().map( r => ( {
			what:   r.name,
			kind:   r.kind === 'unknown' ? '' : r.kind,
			source: r.source,
			slot:   r.slot ?? '',
			state:  r.path === '' ? 'empty' : r.mode,
			tokens: r.tokens,
		} ) );

		// Lenses lead, then kinds alphabetically, nameless last; the sort is stable so load order survives within a kind.
		const kindRank = ( k: string ): number => k === 'lens' ? 0 : k === '' ? 2 : 1;
		slots.sort( ( a, b ) => kindRank( a.kind ) - kindRank( b.kind ) || a.kind.localeCompare( b.kind ) );

		// The remainder against the total, so the decomposition is exact: headings, dividers and estimator rounding.
		const accounted = slots.reduce( ( sum, s ) => sum + s.tokens, 0 );
		slots.push( { what: 'structure', kind: '', source: '—', slot: '', state: 'fixed', tokens: total - accounted } );

		return { lens: lens?.getName() || name, path: lens?.getPath() ?? vault.toAbs( rel ), slots, tokens: total };
	}


	/** Does this glob name an archival bucket? A prefix test, not a match: `plans/plans_complete/**` reaches, `plans/**` does not. */
	private static globReachesArchival( pattern: string | undefined ): boolean {
		if ( !pattern ) return false;
		const norm = pattern.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^_Claude\//, '' );
		return VaultLayout.archivalDirs().some( d => norm === d || norm.startsWith( d + '/' ) );
	}

	/**
	 * Does this glob name EPHEMERAL space (`work/`, `logs/`, `reports/`, `audits/`)? A separate predicate from the
	 * archival one: ephemeral never ships and may not be linked into, archival ships and must stay linkable.
	 */
	private static globReachesEphemeral( pattern: string | undefined ): boolean {
		if ( !pattern ) return false;
		const top = pattern.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^_Claude\//, '' ).split( '/' )[ 0 ];
		return top !== undefined && VaultLayout.ephemeralDirs().includes( top );
	}

	/**
	 * Glob, type and text, AND-combined over one scan; `groupBy: 'type'` returns a census instead of refs.
	 * Unparseable documents are reported in `unreadable`, not silently absent; archival buckets are excluded unless `glob` names one.
	 */
	static query( vault: Vault, opts: QueryOptions = {} ): QueryResult {
		const needle  = opts.text?.toLowerCase();
		const report  = vault.scanReport();
		const inScope = ( relPath: string ): boolean => {
			if ( opts.glob && !Glob.matches( relPath, opts.glob ) ) return false;
			return VaultUtilities.globReachesArchival( opts.glob ) || !VaultLayout.isArchivalPath( relPath );
		};

		let files = report.files.filter( f => inScope( f.relativePath ) );
		if ( opts.type ) files = files.filter( f => vault.classify( f.path ) === opts.type );
		if ( needle )     files = files.filter( f => ( f.body + '\n' + JSON.stringify( f.frontmatter ) ).toLowerCase().includes( needle ) );

		// Ephemeral scratch is withheld from the fault list: an advisory nobody can act on trains readers to skip the
		// whole block. Naming the bucket in `glob` still reports it; `matches` is never withheld.
		const reachesEphemeral = VaultUtilities.globReachesEphemeral( opts.glob );
		const unreadable = report.faults
			.filter( inScope )
			.filter( p => reachesEphemeral || !VaultLayout.isEphemeralHref( p ) );

		if ( opts.groupBy === 'type' ) {
			const counts: Record<string, number> = {};
			for ( const f of files ) {
				const t = vault.classify( f.path );
				counts[ t ] = ( counts[ t ] ?? 0 ) + 1;
			}
			const census = Object.entries( counts )
				.sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
				.map( ( [ type, count ] ) => ( { type, count } ) );
			// A census is never paged: it is the orientation call, one row per type, and paging it would page the map.
			return { matches: census, unreadable, total: census.length, page: 1, pages: 1 };
		}

		// Paged, not capped: the page number is the caller's, so every record stays reachable.
		const refs  = files.map( f => vault.toRef( f ) );
		const pages = Math.max( 1, Math.ceil( refs.length / VaultUtilities.QUERY_PAGE_SIZE ) );
		// Clamped at both ends: a reader's off-by-one should return a page, not an empty answer that looks like no match.
		const page  = Math.min( Math.max( 1, Math.floor( opts.page ?? 1 ) ), pages );
		const from  = ( page - 1 ) * VaultUtilities.QUERY_PAGE_SIZE;

		return {
			matches: refs.slice( from, from + VaultUtilities.QUERY_PAGE_SIZE ),
			unreadable,
			total:   refs.length,
			page,
			pages,
		};
	}

	/**
	 * The link graph around one artifact: `outbound` resolved, `addresses` each flagged `occupied` (a fact, never a
	 * verdict, protocol §1.1), and `inbound` found by resolving the whole vault.
	 */
	static links( vault: Vault, path: string ): LinksResult {
		const abs      = vault.toAbs( path );
		const artifact = KCDPrimitive.fromHtml( vault.read( path ), abs, vault.docRoot );
		const outbound = artifact.getLinks();

		// Addresses ride their own list, never mixed into outbound — collapsing them would hand the
		// caller back the exact ambiguity the primitive exists to remove.
		const names = new Set( vault.scan()
			.map( f => typeof f.frontmatter[ 'name' ] === 'string' ? f.frontmatter[ 'name' ] as string : '' )
			.filter( n => n !== '' ) );
		const addresses = ( artifact.serialize().addresses ?? [] ).map( a => ( {
			...a,
			occupied: names.has( a.value ) || vault.exists( a.value ),
		} ) );

		const inbound = vault.scan()
			.filter( f => f.rawLinks.some( l => vault.resolveHref( l.href ) === abs ) )
			.map( f => ( { path: f.relativePath, relativePath: f.relativePath } ) );

		return { outbound, addresses, inbound };
	}

	/**
	 * Every §10 seed payload in the seed source, one `<script type="text/kcd-md">` block per agent host.
	 * Attributes are matched independently, so their order does not matter; other script blocks are skipped.
	 */
	static parseSeeds( vault: Vault ): SeedBlock[] {
		return VaultUtilities.parseSeedsFrom( vault.read( ROOT_CONTEXT_PATH ), vault.docRoot );
	}

	/**
	 * Project-root-relative files an install writes outside the vault: the seed targets plus the MCP registration.
	 * Files only: the vault and `.claude/skills/` are directories that consumers already exclude by rule, and listing
	 * them here would imply a completeness this lacks. An absent seed carrier is a half-built vault, not a failure.
	 */
	static installedPaths( vault: Vault ): string[] {
		const out = [ '.mcp.json' ];
		try { out.push( ...this.parseSeeds( vault ).map( s => s.target ) ); }
		catch { /* no seed carrier — nothing was seeded, so nothing is excluded */ }
		return out;
	}

	/**
	 * Parses raw HTML, for install time when no vault exists yet. The bundle's `root-context.html` is the only place
	 * the agent entry-point filenames are written, so reading it here keeps the installer from hardcoding a second list.
	 */
	static parseSeedsFrom( html: string, docRoot?: string ): SeedBlock[] {
		const out: SeedBlock[] = [];
		const scriptRe = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/g;

		let m: RegExpExecArray | null;
		while ( ( m = scriptRe.exec( html ) ) !== null ) {
			const [ , attrs, body ] = m;
			if ( !/type="text\/kcd-md"/.test( attrs ) ) continue;

			const host   = /data-kcd-seed="([^"]+)"/.exec( attrs )?.[ 1 ];
			const target = /data-kcd-target="([^"]+)"/.exec( attrs )?.[ 1 ];
			const mode   = /data-kcd-mode="([^"]+)"/.exec( attrs )?.[ 1 ] as SeedBlock[ 'mode' ] | undefined;
			if ( !host || !target ) continue; // malformed seed — both are protocol-required

			out.push( { host, target, mode: mode ?? 'prepend', payload: VaultUtilities.forDocRoot( body.trim(), docRoot ) } );
		}
		return out;
	}

	/**
	 * Rewrites the seed payload for the vault it lands beside: an agent reads it as instructions, and it names the
	 * default doc root. A blunt replacement is deliberate; off the default, every occurrence is wrong by construction.
	 */
	private static forDocRoot( payload: string, docRoot?: string ): string {
		if ( !docRoot || docRoot === LensObject.DEFAULT_DOC_ROOT ) return payload;
		return payload.split( LensObject.DEFAULT_DOC_ROOT ).join( docRoot );
	}
}
