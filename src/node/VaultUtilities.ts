import * as fs from 'fs';
import * as path from 'path';
import { KCDPrimitive } from '../primitives';
import type { SlotMode, LinkEntry, AddressEntry } from '../primitives';
import type { Vault } from './Vault';
import type { ArtifactRef } from '../core';
import { InstallManifest, VaultLayout, KcdEmit } from '../core';

/** Where the seed source lives, vault-relative — protocol §10's one payload-per-host document. */
const ROOT_CONTEXT_PATH = 'root-context.html';

/** The deployed convention every href in this project uses. `Vault` does not expose `docRoot`
 *  publicly ( it is private on the class ), so this is not DERIVED — same choice
 *  `VaultDeploy._navIndexHtml` already made, for the same reason. */
const DOC_ROOT_PREFIX = '_Claude';

/**
 * One validation finding — the merged currency of the two health axes below. Carries
 * everything the structural `TypeCheckIssue` does ( severity/message/field/section ) plus
 * the `path` of the offending artifact, so a whole-vault sweep and a single-file check
 * speak the same shape. `error` blocks; `warn` is advisory hygiene.
 */
export interface HealthIssue {
	path:      string;
	severity:  'error' | 'warn';
	message:   string;
	field?:    string;
	section?:  string;
}

/**
 * Full health output — the flat issue list, an errors-vs-warnings tally, and THE DENOMINATOR.
 *
 * `scanned` / `checked` exist because `{ total: 0 }` alone cannot distinguish *I examined 314
 * documents and found nothing* from *I examined nothing*. That is the dominant defect class in this
 * project's own register — a check that succeeds because there was nothing to check — and it was
 * live on the one command a person runs to prove a vault is sound. A clean report over an empty
 * input is the correct answer to the wrong question, which is exactly why no return-value assertion
 * could ever see it.
 */
export interface HealthReport {
	issues:  HealthIssue[];
	summary: {
		/** Files the scan walked, before any filtering. Zero here means the sweep found NOTHING —
		 *  a missing or mis-pointed vault, not a healthy one. */
		scanned:  number;
		/** Documents actually parsed and validated. The real denominator: `total: 0` is only good
		 *  news in proportion to this. `scanned - checked` is what the filters passed over. */
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

/** The display state of one row in a lens view: its dredge mode, `empty` when nothing fills the slot, or
 *  `fixed` for a row that is not a slot at all — inherited or compiler-synthesized content that rides no
 *  matter what the lens authors ( the floor, the merged care band, the manifest, the structure ).
 *
 *  DISPLAY-ONLY, and deliberately NOT `SlotMode`. `SlotMode` is the core off/on/suggested currency the whole
 *  composition UI is built on; this type is consumed only by `lensView` and the CLI chart it feeds, so a new
 *  value here cannot reach the slotting surfaces. */
export type SlotState = SlotMode | 'empty' | 'fixed';

/** One row of a lens's compiled-context breakdown — a component, where it CAME FROM, its kind, its state,
 *  and the tokens it actually contributes to the compiled context. */
export interface LensSlot {
	what:   string;
	kind:   string;
	/** Which lens this row's content came from — the inspected lens's own name for its identity and slots,
	 *  the floor's name for inherited content, `—` for content that merges several sources or belongs to
	 *  none. The column that makes inherited context legible rather than silently folded into the total. */
	source: string;
	/** The mutual-exclusion slot this row competes in ( `habit-class` ), or '' when it contends nothing.
	 *  Two rows sharing a slot means only one of them reached the compiled context. */
	slot:   string;
	state:  SlotState;
	tokens: number;
}

/** A lens's compiled-context detail — every component with its source, state and real token weight, plus the
 *  total. The structured form behind the `show` chart.
 *
 *  Priced from a BUILT AGENT, so this reports what a session wearing this lens ACTUALLY receives — the floor
 *  included — rather than what the lens alone contributes. `tokens` is the same number `compile` reports for
 *  the same lens, and the rows sum to it exactly. */
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
}

/** Either the matching refs, or — with `groupBy: 'type'` — a type census sorted by count descending. */
export type QueryResult = ArtifactRef[] | { type: string; count: number }[];

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

/** The result of applying one seed — a report always, a write only when `applied` is true. */
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

/** The result of taking a seed's managed block back out — `fileRemoved` is true only when our block
 *  WAS the whole file, so nothing of the project's own was ever at stake. */
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

/** The result of maintaining the `.gitignore` managed block — a report always, a write only when
 *  `applied` is true, same confirm-gated shape as `SeedApplyReport`. */
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

/** One row of the entry document's Lenses table — a real lens's picker identity. */
export interface LensIndexRow {
	what:  string;
	where: string;
	why:   string;
}

/** The result of a `lens-index` splice — the recomputed rows, the spliced document, and whether
 *  applying it would actually change anything. */
export interface LensIndexReport {
	rows:    LensIndexRow[];
	html:    string;
	changed: boolean;
}

/** The result of a `reset` — a report always, a write only when `applied` is true. */
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
	 * How far apart the two copies are, as line counts each side holds that the other does not —
	 * `null` when there is nothing to compare ( no canonical, no deployed target, or already
	 * identical ).
	 *
	 * This exists because "differs" is the NORMAL state here, not a defect. Canonical is the
	 * SHIPPING copy: it was deliberately genericized ( project-specific links stripped, 34
	 * fresh-install warnings → 0 ), so a mature vault's bundled documents differ from it by
	 * construction — 21 of 51 in this project's own vault as of 2026-07-29. A bare "differs" cannot
	 * tell one stale link from a document that lost a paragraph; the counts can, and that is the
	 * difference between a safe restore and a silent content loss.
	 *
	 * A multiset difference on whole lines, not a diff algorithm: no hunks, no alignment, no new
	 * module. Enough to size the decision, and honest about being nothing more.
	 *
	 * WHICH IS WHY THE TOTALS RIDE ALONG. A whole-line measure cannot tell content from FORMATTING:
	 * this vault holds minified documents ( `author-script.html`, 21 long lines ) whose bundle twin is
	 * line-wrapped ( 140 lines ), same bytes and same sections, and the naive counts call that
	 * `3 / 134` — indistinguishable from a copy genuinely missing 134 lines, and the more dangerous
	 * reading of the two. The totals are the discriminator: comparable line counts mean the drift is
	 * about content, wildly different ones mean it is mostly reflow. Reported rather than judged here
	 * — this is a measure, and the caller decides what to say about it.
	 */
	drift:         {
		onlyInDeployed:  number;
		onlyInCanonical: number;
		/** Total lines on each side — see the note above; this is how a caller separates a real content
		 *  difference from two differently-formatted copies of the same document. */
		deployedLines:   number;
		canonicalLines:  number;
	} | null;
}

/**
 * One step of a kcd/ migration — flattening a self-hosting vault's canonical substrate OUT of a
 * deployed `kcd/` folder, per project ( 2026-07-25 ). Three kinds, because a `kcd/` file is in one
 * of three real states, not one: `delete-duplicate` ( the real, live, possibly-customized copy
 * already exists at its flat home — the `kcd/` copy is a stale original, safe to drop and repoint
 * ); `relocate` ( content exists ONLY in `kcd/` — it must actually move, links healed along the
 * way ); `extract-template` ( a `templates/` scaffold — never belongs in a deployed vault at all,
 * per this project's own "templates stay in the bundle" ruling; reported, never applied here,
 * because where it goes is a PACKAGING decision this generic vault utility has no business
 * knowing ).
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

/** A migration plan — every action `planKcdMigration` decided, plus anything it found that no
 *  action here covers ( `kcd.css`'s plain `<link>` tag is the first known case — see
 *  `fixStylesheetLinks` ). */
export interface MigrationPlan {
	actions: MigrationAction[];
	notes:   string[];
}

export interface MigrationApplyReport {
	action:  MigrationAction;
	applied: boolean;
	error?:  string;
}

/** One stylesheet `<link>` fix — `kcd.css`'s relative depth changes with every file it's linked
 *  from, and it is plain HTML, not a `data-kcd-*` href, so no existing heal mechanism sees it. */
export interface StylesheetFixReport {
	path:    string;
	oldHref: string;
	newHref: string;
	applied: boolean;
	/** Whether this document was missing the tier-1 baseline and had one inserted. Reported separately
	 *  from the href because the two fail independently: a document can carry a correct link and no
	 *  baseline, which renders perfectly in a browser and is unreadable in a viewer that will not load
	 *  a stylesheet — the exact case §8.1's second tier exists for. */
	baselineAdded: boolean;
}

/**
 * VaultUtilities — the shared vault-operations bucket. Higher-order routines that compose
 * several Vault primitives into one answer, kept out of Vault itself so the facade stays a
 * thin disk/path surface. Imported whole and called by name ( `VaultUtilities.health( … )` );
 * every face of Daedalus ( the `kcd_health` MCP tool, the CLI `validate` command ) calls the
 * SAME method here, so a validation behaviour can never exist on one face and not the other.
 */
export class VaultUtilities {

	/**
	 * Validate one artifact ( `onlyFile` given ) or the whole vault ( omitted ) on two axes:
	 *
	 *   STRUCTURAL ( per file ) — parse the artifact and run its type rules. A parse failure
	 *   becomes an `error` issue rather than aborting the sweep.
	 *
	 *   REFERENCE INTEGRITY ( cross-file, advisory ) — dangling links and unresolved base/lens
	 *   refs. The logic lives in `vault.referenceIssues`; this only folds it into one list.
	 *
	 * Returns `{ issues, summary }` where the summary carries A DENOMINATOR — `scanned` and
	 * `checked` — and not only a tally of what went wrong.
	 *
	 * WHY THE DENOMINATOR IS THE POINT. This reported `{ total: 0 }` for both *I examined 314
	 * documents and found nothing* and *I examined nothing*, on the one command a person runs to
	 * prove a vault is sound. That is this project's dominant failure class stated exactly: a check
	 * that succeeds because there was nothing to check never returns a WRONG answer — it returns the
	 * right answer for an empty input, which is why every existing assertion passed it and why no
	 * return-value test could see it. `checked: 0` now says so out loud.
	 *
	 * WHAT IT STILL CANNOT SEE, stated so a clean report is not over-read: a document that fails to
	 * PARSE is counted in `checked` and reported as an error ( good ), but `vault.scan()` is the
	 * source of the file list, so anything the scan itself drops is invisible here — and reference
	 * probing only resolves `_Claude/`-rooted hrefs, so a `file://` or off-vault link is neither
	 * resolved nor reported. The gap between `scanned` and `checked` is the filters; the gap between
	 * the filesystem and `scanned` is not measured at all.
	 *
	 * The pre-flight before a save/move sweep and the observable form of the "internal state always
	 * viable" invariant.
	 */
	static health( vault: Vault, onlyFile?: string ): HealthReport {
		const issues: HealthIssue[] = [];
		let scanned = 0;
		let checked = 0;

		const checkFile = ( filePath: string ) => {
			checked++;
			const rel = vault.toVaultRel( filePath );

			try {
				const artifact = KCDPrimitive.fromHtml( vault.read( filePath ), vault.toAbs( filePath ) );

				for ( const issue of artifact.typeCheck() )
					issues.push( { path: rel, ...issue } );
			} catch ( e ) {
				issues.push( {
					path:     rel,
					severity: 'error',
					message:  e instanceof Error ? e.message : String( e ),
				} );
			}
		};

		if ( onlyFile ) {
			scanned = 1;
			checkFile( onlyFile );
		} else {
			// The registry decides what is graded. Directories marked `indexed: false` are
			// scratch and output space — never library artifacts — so a whole-vault sweep
			// passes them through untouched rather than reporting them as malformed.
			// ...and only DOCUMENTS are validated as documents. A `.js` utility in the library is
			// declarative code, not a KCD artifact — the protocol says so outright ( "utility is
			// not a document type" ) — so grading it against the document schema reports a
			// category error, not a defect. This is the file-kind gate.
			// RAW WALK, not `scan()`. `scan()` parses every file and drops whatever fails, so the
			// malformed document — the one this sweep exists to find — was absent from its own report.
			// Verified live: an unparseable file appeared only in a per-path check, never in a
			// whole-vault one, while the summary read clean. A reporting tool must enumerate the
			// filesystem, because failing to be an artifact IS the defect.
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
	 * Compile one or more lenses to a context string — Daedalus's LENS-scoped compiler.
	 *
	 * Builds a dumb agent ( `Vault.buildAgent` ) and compiles that, so both faces run one engine. The only
	 * difference between them is the agent's ENVIRONMENT — root context, live MCP tool defs, DB memory —
	 * which has no vault-side source, so a vault agent never binds it.
	 *
	 * THE BASE LENS ALWAYS RIDES, with no flag to suppress it: base is an inheritance mechanism, not an
	 * ingredient, so a compile that drops it is wrong rather than lean. A lens re-declaring part of the
	 * floor camouflages the missing rest, which is why the rule lives once, in `Agent.withFloor`.
	 *
	 * Each name is a bare lens name ( `lenses/{name}/{name}.html` ) or a raw vault-relative path; `[0]` is
	 * primary. Throws on an empty list or an unresolvable name. The returned `lenses` reports what actually
	 * COMPILED, base included — reporting only what was asked for is what keeps a missing floor invisible.
	 * Read off the built agent, so a lens named by raw path reports its artifact NAME.
	 */
	static compile( vault: Vault, lensNames: string[] ): CompileResult {
		const agent    = vault.buildAgent( lensNames );
		const compiled = agent.lenses.map( l => l.getName() );
		const text     = agent.compile();

		return { lenses: compiled, text, tokens: KCDPrimitive._estimateTokens( text ) };
	}

	/**
	 * The composition behind the `show` chart: what a session WEARING this lens receives, file by file,
	 * inheritance floor included. Priced from the compiled blocks.
	 *
	 * A view of the COMPOSITION, not of the text — what the object is built from, what each file costs, and
	 * which lens brought it, so editing an object and inspecting how it assembles works from the command
	 * line. A thin projection of `Agent.composition()` rather than its own analysis: a chart that recomputed
	 * the composition would be free to disagree with the thing it describes.
	 *
	 * EVERY FILE CARRIES A COST — at `on`, its surviving row in the deduped manifest; at `off`, zero, and
	 * still listed, because what an object declines is part of how it is composed. No aggregate `manifest`
	 * row: pooling those weights makes an `on` file read as free.
	 *
	 * The one non-file row is `structure` — band headings, dividers, block joins, estimator rounding. It is
	 * the REMAINDER against the compiled total, which is what makes the decomposition exact: the estimator
	 * is `round( chars / 4 )`, so per-block weights cannot sum to a single-pile estimate on their own.
	 */
	static lensView( vault: Vault, name: string ): LensView {
		const rel = vault.lensPath( name );
		if ( !fs.existsSync( vault.toAbs( rel ) ) )
			throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );

		const agent = vault.buildAgent( [ name ] );
		const lens  = agent.domainLenses[ 0 ];
		const total = KCDPrimitive._estimateTokens( agent.compile() );

		// A projection, not a second computation — attribution lives on the object that knows the answer.
		const slots: LensSlot[] = agent.composition().map( r => ( {
			what:   r.name,
			kind:   r.kind === 'unknown' ? '' : r.kind,
			source: r.source,
			slot:   r.slot ?? '',
			state:  r.path === '' ? 'empty' : r.mode,
			tokens: r.tokens,
		} ) );

		// Grouped BY KIND so a reader sees all the habits together, all the references together — the question
		// a composition chart gets asked is "what habits am I carrying", not "in what order were they loaded".
		// Lenses lead ( they are what everything else hangs off ), then kinds alphabetically, with a nameless
		// kind last. The sort is STABLE, so load order survives inside each group.
		const kindRank = ( k: string ): number => k === 'lens' ? 0 : k === '' ? 2 : 1;
		slots.sort( ( a, b ) => kindRank( a.kind ) - kindRank( b.kind ) || a.kind.localeCompare( b.kind ) );

		// Band headings, the `---` dividers, the joins between blocks, and estimator rounding — everything the
		// compile adds that is not a file. Computed as the remainder so the decomposition is exact against the
		// total rather than approximately right.
		const accounted = slots.reduce( ( sum, s ) => sum + s.tokens, 0 );
		slots.push( { what: 'structure', kind: '', source: '—', slot: '', state: 'fixed', tokens: total - accounted } );

		return { lens: lens?.getName() || name, path: lens?.getPath() ?? vault.toAbs( rel ), slots, tokens: total };
	}


	/**
	 * Does this glob deliberately reach into an archival bucket? A pattern that NAMES one is a caller
	 * asking for retired material; anything looser is a sweep that should not be handed it.
	 *
	 * Prefix test rather than a match test, and that is the point: `plans/plans_complete/**` reaches,
	 * `plans/**` does not. "Show me the plans" means the live ones — the retired bucket is named when
	 * it is wanted.
	 */
	private static globReachesArchival( pattern: string | undefined ): boolean {
		if ( !pattern ) return false;
		const norm = pattern.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^_Claude\//, '' );
		return VaultLayout.archivalDirs().some( d => norm === d || norm.startsWith( d + '/' ) );
	}

	/**
	 * The single read-query over a vault — glob, type, and text, AND-combined over one scan.
	 * `glob` short-circuits through the Vault's own path filter; `type`/`text` narrow the
	 * survivors. `groupBy: 'type'` returns a census instead of refs — the cheapest orientation
	 * call, and how `kcd_query`'s inspector example works. Moved out of the MCP handler ( 1.i ):
	 * this was the one tool whose filtering logic lived only on one face.
	 *
	 * ARCHIVAL BUCKETS ARE EXCLUDED from an unscoped query, on the same rule the grading gate uses:
	 * naming them still returns them, because the caller asked. A retired plan answers "what did we
	 * do"; every other query is asking "what is true now", and mixing the two is how a query for
	 * live work comes back mostly history. It also stops churn — a document written against a
	 * standard that has since moved on keeps inviting a rewrite nobody wants, and the cheapest way
	 * to stop that is to not surface it.
	 */
	static query( vault: Vault, opts: QueryOptions = {} ): QueryResult {
		const needle = opts.text?.toLowerCase();

		let files = opts.glob ? vault.glob( opts.glob ) : vault.scan();
		if ( !VaultUtilities.globReachesArchival( opts.glob ) )
			files = files.filter( f => !VaultLayout.isArchivalPath( f.relativePath ) );
		if ( opts.type ) files = files.filter( f => vault.classify( f.path ) === opts.type );
		if ( needle )     files = files.filter( f => ( f.body + '\n' + JSON.stringify( f.frontmatter ) ).toLowerCase().includes( needle ) );

		if ( opts.groupBy === 'type' ) {
			const counts: Record<string, number> = {};
			for ( const f of files ) {
				const t = vault.classify( f.path );
				counts[ t ] = ( counts[ t ] ?? 0 ) + 1;
			}
			return Object.entries( counts )
				.sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
				.map( ( [ type, count ] ) => ( { type, count } ) );
		}

		return files.map( f => vault.toRef( f ) );
	}

	/**
	 * The link graph around one artifact: `outbound` ( what it declares, resolved ), `addresses`
	 * ( its own, each flagged `occupied` — a fact, never a verdict, protocol §1.1 ), and `inbound`
	 * ( every other file whose links resolve here, found by scanning + resolving the whole vault ).
	 * Moved out of the MCP handler ( 1.i ), same reason as `query`.
	 */
	static links( vault: Vault, path: string ): LinksResult {
		const abs      = vault.toAbs( path );
		const artifact = KCDPrimitive.fromHtml( vault.read( path ), abs );
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
	 * Parse every §10 seed payload out of the seed source. A seed is the "§5 non-executing script
	 * idiom with a markdown type" — `<script type="text/kcd-md" data-kcd-seed="host"
	 * data-kcd-target="…" data-kcd-mode="…">payload</script>` — one block per agent host. Attribute
	 * order is NOT assumed ( each is matched independently within the captured tag ), so a document
	 * author reordering them cannot silently break extraction. A `<script>` without
	 * `type="text/kcd-md"` is skipped, not an error — root-context may grow other script content
	 * later.
	 */
	static parseSeeds( vault: Vault ): SeedBlock[] {
		return VaultUtilities.parseSeedsFrom( vault.read( ROOT_CONTEXT_PATH ) );
	}

	/**
	 * The project-root-relative FILES an install writes outside the vault — the host entry points, taken
	 * from the §10 seed declarations rather than named here, plus the MCP registration file. One place
	 * answers "what did we put in this repository", so a consumer never re-derives the list and cannot
	 * drift from it.
	 *
	 * Files only, and deliberately: the other two things an install creates ( the vault itself and
	 * `.claude/skills/` ) are DIRECTORIES, which every consumer so far excludes structurally — `Survey`
	 * skips the doc root by name and every dot-directory by rule. Adding them here would imply a
	 * completeness this does not have.
	 *
	 * Tolerant of a vault with no seed carrier yet: nothing has been seeded, so there is nothing to name.
	 * An absent `root-context.html` is a half-built vault, not a failure ( absence is not failure ).
	 */
	static installedPaths( vault: Vault ): string[] {
		const out = [ '.mcp.json' ];
		try { out.push( ...this.parseSeeds( vault ).map( s => s.target ) ); }
		catch { /* no seed carrier — nothing was seeded, so nothing is excluded */ }
		return out;
	}

	/**
	 * The same parse, against raw HTML rather than a deployed vault.
	 *
	 * The two currencies are genuinely different, not a convenience wrapper: at INSTALL time there is
	 * no vault yet, and the caller needs the seed declarations out of the BUNDLE's `root-context.html`
	 * — which is the only place the set of agent entry-point filenames is written down. Anchoring an
	 * install on "the folder containing CLAUDE.md" without this would mean hardcoding that filename in
	 * the CLI, and there would then be two lists of host targets that could disagree.
	 */
	static parseSeedsFrom( html: string ): SeedBlock[] {
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

			out.push( { host, target, mode: mode ?? 'prepend', payload: body.trim() } );
		}
		return out;
	}

	/**
	 * Apply one seed to its target, confirm-gated like `reset`: no `confirm` only reports what
	 * would change, nothing on disk moves.
	 *
	 * `create-only` writes the whole file, and only when nothing is there yet — re-running this
	 * against an existing target is always a no-op by design (`changed: false`), never a silent
	 * overwrite of a project's own content.
	 *
	 * `prepend` maintains a MANAGED BLOCK at the top of the target, delimited by
	 * `<!-- kcd:begin -->` / `<!-- kcd:end -->` — re-extraction replaces only what lies between the
	 * markers and leaves everything below them alone, which is what lets a vault deploy over a
	 * project whose `CLAUDE.md` already says things of its own. First extraction ( no markers yet )
	 * PREPENDS the block above whatever the file already held; a target that does not exist yet gets
	 * just the block.
	 */
	static applySeed( projectRoot: string, seed: SeedBlock, opts?: { confirm?: boolean } ): SeedApplyReport {
		const targetAbs = path.resolve( projectRoot, seed.target );
		const existed   = fs.existsSync( targetAbs );

		if ( seed.mode === 'create-only' ) {
			const changed = !existed;
			if ( changed && opts?.confirm ) {
				fs.mkdirSync( path.dirname( targetAbs ), { recursive: true } );
				fs.writeFileSync( targetAbs, seed.payload + '\n', 'utf-8' );
			}
			return { host: seed.host, target: seed.target, mode: seed.mode, targetExisted: existed, hadManagedBlock: false, changed, applied: !!opts?.confirm && changed };
		}

		// A BOM belongs at byte 0 or nowhere. Node's utf-8 decode does NOT strip one, so prepending our
		// block above the existing content used to STRAND it mid-file, immediately after
		// `<!-- kcd:end -->`. Split it off, then re-emit it at the front: the project's encoding choice is
		// preserved exactly, it just stops migrating. PowerShell 5.1 and older Notepad both write BOMs by
		// default, so this is the ordinary Windows case rather than an exotic one — found 2026-07-29.
		//
		// `changed` compares against `raw`, not `current`, or a file differing ONLY by a moved BOM would
		// report no change and never get rewritten.
		const raw      = existed ? fs.readFileSync( targetAbs, 'utf-8' ) : '';
		const bom      = raw.startsWith( '\uFEFF' ) ? '\uFEFF' : '';
		const current  = raw.slice( bom.length );
		const blockRe  = /<!--\s*kcd:begin\s*-->[\s\S]*?<!--\s*kcd:end\s*-->/;
		const hadBlock = blockRe.test( current );
		const block    = `<!-- kcd:begin -->\n${ seed.payload }\n<!-- kcd:end -->`;
		const next     = bom + ( hadBlock ? current.replace( blockRe, block ) : block + ( current ? '\n\n' + current : '\n' ) );
		const changed  = next !== raw;

		if ( changed && opts?.confirm ) {
			fs.mkdirSync( path.dirname( targetAbs ), { recursive: true } );
			fs.writeFileSync( targetAbs, next, 'utf-8' );
		}
		return { host: seed.host, target: seed.target, mode: seed.mode, targetExisted: existed, hadManagedBlock: hadBlock, changed, applied: !!opts?.confirm && changed };
	}

	/**
	 * The inverse of `applySeed` — take OUR managed block back out of a host entry file, leaving
	 * everything the project wrote itself exactly where it was.
	 *
	 * The uninstall half of the seed contract, and the reason `clear` can be offered at all: because
	 * `applySeed` never owned more than the region between its markers, removal is subtraction rather
	 * than deletion. The file survives with the user's own instructions intact. It is deleted ONLY
	 * when our block was the entire content — i.e. we created it and nobody added anything since —
	 * which is the one case where leaving an empty file behind would be litter rather than courtesy.
	 *
	 * `create-only` seeds are never removed: that mode writes a whole file and then never touches it
	 * again, so after the first install the content is indistinguishable from the project's own.
	 * Guessing there would mean deleting something we cannot prove we wrote.
	 */
	static removeSeed( projectRoot: string, seed: SeedBlock, opts?: { confirm?: boolean } ): SeedRemoveReport {
		const targetAbs = path.resolve( projectRoot, seed.target );
		const existed   = fs.existsSync( targetAbs );
		const base      = { host: seed.host, target: seed.target, targetExisted: existed };

		if ( !existed || seed.mode === 'create-only' ) {
			return { ...base, hadManagedBlock: false, fileRemoved: false, changed: false, applied: false };
		}

		const current  = fs.readFileSync( targetAbs, 'utf-8' );
		const blockRe  = /<!--\s*kcd:begin\s*-->[\s\S]*?<!--\s*kcd:end\s*-->\r?\n?/;
		const hadBlock = blockRe.test( current );
		if ( !hadBlock ) return { ...base, hadManagedBlock: false, fileRemoved: false, changed: false, applied: false };

		const next        = current.replace( blockRe, '' ).replace( /^\s+/, '' );
		const fileRemoved = next.trim().length === 0;

		if ( opts?.confirm ) {
			if ( fileRemoved ) fs.rmSync( targetAbs );
			else fs.writeFileSync( targetAbs, next, 'utf-8' );
		}
		return { ...base, hadManagedBlock: true, fileRemoved, changed: true, applied: !!opts?.confirm };
	}

	/**
	 * Maintain a managed block in the project's `.gitignore`, confirm-gated like every other write.
	 *
	 * WHY THIS IS A FUNCTION AND NOT A PARAGRAPH OF ADVICE: an install writes six paths into a
	 * version-controlled repository, and "I do not want this in my git history" is the one objection
	 * a cautious developer actually has. It was previously answered with prose telling them to edit
	 * `.gitignore` themselves — which is a chore attached to the least confident moment of the
	 * install. It also replaces "workspace mode" outright ( ruled 2026-07-26 ): a vault outside the
	 * repository breaks `inferProjectRoot`'s upward walk and is an alternate topology, whereas the
	 * concern behind it is fully served by three lines in a file.
	 *
	 * The three scopes are the three honest answers, and `none` exists so the choice is reversible:
	 *
	 *   scratch  the default recommendation — `audits/` and `work/` are regenerable churn; the rest
	 *            of the vault is project knowledge and belongs in history
	 *   vault    the whole vault, for someone who wants to try this without touching their repo
	 *   none     remove the managed block entirely, restoring whatever they had before
	 *
	 * Managed-block idiom deliberately mirrors `applySeed`'s ( `# kcd:begin` / `# kcd:end`, comment
	 * syntax swapped for the file format ) so there is ONE mechanism for "a file we co-own with the
	 * user" rather than two that drift. The block is APPENDED, not prepended — a `.gitignore`'s own
	 * rules should stay where its author put them.
	 */
	static gitignore( projectRoot: string, docRoot: string, scope: IgnoreScope, opts?: { confirm?: boolean } ): IgnoreReport {
		const targetAbs = path.resolve( projectRoot, '.gitignore' );
		const existed   = fs.existsSync( targetAbs );
		const current   = existed ? fs.readFileSync( targetAbs, 'utf-8' ) : '';

		const entries =
			scope === 'vault'   ? [ `${ docRoot }/` ] :
			scope === 'scratch' ? [ `${ docRoot }/audits/`, `${ docRoot }/work/`, `${ docRoot }/scratch/` ] :
			[];

		// [\s\S]*? so a block spanning lines is matched lazily; the trailing \n? absorbs the blank
		// line a removal would otherwise leave behind.
		const blockRe  = /#\s*kcd:begin\s*[\s\S]*?#\s*kcd:end\s*\n?/;
		const hadBlock = blockRe.test( current );

		let next: string;
		if ( entries.length === 0 ) {
			next = hadBlock ? current.replace( blockRe, '' ).replace( /\n{3,}$/, '\n' ) : current;
		} else {
			const block = `# kcd:begin\n${ entries.join( '\n' ) }\n# kcd:end\n`;
			next = hadBlock
				? current.replace( blockRe, block )
				: current + ( current && !current.endsWith( '\n' ) ? '\n' : '' ) + ( current ? '\n' : '' ) + block;
		}

		const changed = next !== current;
		if ( changed && opts?.confirm ) fs.writeFileSync( targetAbs, next, 'utf-8' );

		return { target: '.gitignore', scope, entries, targetExisted: existed, hadManagedBlock: hadBlock, changed, applied: !!opts?.confirm && changed };
	}

	/**
	 * The entry document's Lenses table, freshly computed from the vault's real lens files —
	 * `what`/`where`/`why` sourced from each lens's OWN frontmatter, never hand-copied. This is
	 * deliberately authoritative-over-editorial: a lens's description is the one place its pitch is
	 * written, and a curated-but-separate copy in the entry document is exactly the kind of thing
	 * that drifts silently. `_lens-base` ( and any other `_`-prefixed, auto-loaded infrastructure
	 * lens ) is excluded — it is never picked, it is automatic.
	 */
	static lensIndex( vault: Vault ): LensIndexRow[] {
		return vault.scan()
			.filter( f => vault.classify( f.path ) === 'lens' )
			.filter( f => !path.basename( f.relativePath ).startsWith( '_' ) )
			.map( f => ( {
				// The FOLDER name, not frontmatter.name — this is the slug `!name` and
				// `kcd_compile`'s own `lenses/{name}/{name}.html` convention actually resolve. At
				// least three lenses' authored `name` disagrees with their folder ( hyphen vs.
				// underscore ) — using frontmatter here would put an unresolvable slug in the one
				// table whose whole job is telling an agent what to type.
				what:  path.basename( path.dirname( f.relativePath ) ),
				where: `${ DOC_ROOT_PREFIX }/${ f.relativePath }`.replace( /\\/g, '/' ),
				why:   typeof f.frontmatter[ 'description' ] === 'string' ? f.frontmatter[ 'description' ] as string : '',
			} ) )
			.sort( ( a, b ) => a.what.localeCompare( b.what ) );
	}

	/**
	 * Splice freshly-computed rows into the entry document's `data-kcd-section="lenses"` table,
	 * leaving every other section — hard rules, stacking, framework reference, all hand-authored
	 * prose — untouched. Locates the table by its OWN structural markers ( the section id, the
	 * head row, the section's own closing tag ), not a line-number or whitespace assumption, so a
	 * human editing prose elsewhere in the document cannot break the splice. Throws rather than
	 * guessing if the section is not found in the expected shape — a silent wrong-place write to a
	 * hard-rule-protected document is worse than a loud refusal.
	 */
	static spliceLensIndex( rootHtml: string, rows: LensIndexRow[] ): LensIndexReport {
		// This project's entry document is CRLF ( Windows-authored ) — every line-ending match here
		// is `\r?\n`, and every line the splice EMITS uses `\r\n` too, so the write never mixes
		// conventions mid-file. A bare `\n` assumption is exactly what broke this on the first real run.
		const sectionRe = /<section data-kcd-section="lenses">[\s\S]*?<\/section>/;
		const section    = sectionRe.exec( rootHtml );
		if ( !section ) throw new Error( 'spliceLensIndex: no <section data-kcd-section="lenses"> found in the entry document' );

		const headRe = /<div data-kcd-head>[\s\S]*?<\/div>\r?\n/;
		const head   = headRe.exec( section[ 0 ] );
		if ( !head ) throw new Error( 'spliceLensIndex: found the lenses section but not its table head row' );

		const headEndInSection = head.index + head[ 0 ].length;
		const closeRe          = /\r?\n(\t*)<\/div>\r?\n(\t*)<\/section>$/;
		const close             = closeRe.exec( section[ 0 ] );
		if ( !close ) throw new Error( 'spliceLensIndex: found the lenses table head but not its closing tags' );

		const rendered = rows.map( r =>
			`\t\t\t<div data-kcd-slot="reference" data-kcd-mode="on">\r\n` +
			`\t\t\t\t<span data-kcd-field="what"  data-kcd-type="text">${ r.what }</span>\r\n` +
			`\t\t\t\t<a    data-kcd-field="where" data-kcd-type="path" href="${ r.where }">${ r.what }</a>\r\n` +
			`\t\t\t\t<span data-kcd-field="why"   data-kcd-type="text">${ r.why }</span>\r\n` +
			`\t\t\t</div>`
		).join( '\r\n' );

		const newSection = section[ 0 ].slice( 0, headEndInSection ) + rendered + section[ 0 ].slice( close.index );
		const html        = rootHtml.slice( 0, section.index ) + newSection + rootHtml.slice( section.index + section[ 0 ].length );

		return { rows, html, changed: html !== rootHtml };
	}

	/**
	 * Restore ONE deployed artifact to canonical from the bundle — the opposite of `VaultDeploy`,
	 * which only ever FILLS ( `force: false`, an existing file is never touched ). Reset is the
	 * deliberate overwrite `VaultDeploy` refuses to be.
	 *
	 * The canonical counterpart of a deployed path is resolved through `InstallManifest`, the same
	 * table `VaultDeploy` fills FROM — no second mapping to drift out of step with the first. A
	 * target with no covering row ( content the manifest never declared ) simply has no canonical
	 * counterpart; that is a normal, reportable outcome, not an error.
	 *
	 * CANONICAL IS THE SHIPPING COPY, NOT A PRISTINE ANCESTOR. The bundle was deliberately
	 * genericized so a fresh install validates clean, which means a grown project's copy of the same
	 * document is routinely LONGER and richer than canonical — `differs` is the expected steady state
	 * for most bundled documents, not a signal that something broke. Restoring one therefore
	 * REPLACES local prose rather than repairing corruption. `drift` exists so a caller can size that
	 * before deciding; a caller that reports "differs" without it is handing the user a decision they
	 * cannot make.
	 *
	 * CONFIRM-FIRST, per-artifact: called with no `opts` ( or `confirm: false` ), this only
	 * reports — `applied` is always `false` and nothing on disk changes. Pass `confirm: true` to
	 * actually overwrite, and only once the caller has seen the report. A target already
	 * `identical` to canonical is left untouched even with `confirm: true` — reset does not
	 * touch mtimes for no reason.
	 */
	static reset( vault: Vault, targetPath: string, substrateSource: string, opts?: { confirm?: boolean } ): ResetReport {
		const rel = targetPath.replace( /\\/g, '/' ).replace( /^\/+/, '' );
		const targetAbs = vault.toAbs( rel );

		const entry = InstallManifest.entryFor( rel );
		if ( !entry )
			return { path: rel, canonicalPath: '', hasCanonical: false, targetExisted: fs.existsSync( targetAbs ), identical: false, applied: false, drift: null };

		// `entry.vaultHome` may be a directory row ( e.g. `habits` ) covering `rel` as a descendant —
		// the tail below it carries over onto the bundle side unchanged.
		const tail = rel === entry.vaultHome ? '' : rel.slice( entry.vaultHome.length + 1 );
		const canonicalPath = path.join( substrateSource, entry.bundleSource, tail );

		const hasCanonical  = fs.existsSync( canonicalPath ) && fs.statSync( canonicalPath ).isFile();
		const targetExisted = fs.existsSync( targetAbs );

		if ( !hasCanonical )
			return { path: rel, canonicalPath, hasCanonical, targetExisted, identical: false, applied: false, drift: null };

		const canonicalContent = fs.readFileSync( canonicalPath, 'utf-8' );
		const deployedContent  = targetExisted ? fs.readFileSync( targetAbs, 'utf-8' ) : null;
		const identical        = deployedContent === canonicalContent;

		// Only measured when there are two real, differing files to measure. Nothing to compare and
		// nothing to decide are the same case, and both report `null` rather than a misleading zero.
		const drift = deployedContent === null || identical
			? null
			: VaultUtilities.lineDrift( deployedContent, canonicalContent );

		const apply = !!opts?.confirm && !identical;
		if ( apply ) vault.write( rel, canonicalContent );

		return { path: rel, canonicalPath, hasCanonical, targetExisted, identical, applied: apply, drift };
	}

	/**
	 * Lines one side holds that the other does not, counted as a multiset — a line appearing twice on
	 * the left and once on the right contributes one. Deliberately NOT a diff: no alignment, no
	 * hunks, no move detection, so a block that shifted position still reads as unchanged content.
	 *
	 * Line-ending and trailing-whitespace insensitive, because a CRLF/LF mismatch is not a content
	 * difference and this project has documents of both conventions ( `root.html` is CRLF,
	 * `CLAUDE.md` is LF ) — counting that as a full rewrite would make every number useless.
	 *
	 * It CANNOT see through reflow, though: a minified document and a wrapped one share no whole
	 * lines at all, so the counts read as a total rewrite. That is why the totals are returned
	 * alongside — the caller needs them to tell the two situations apart.
	 */
	private static lineDrift( left: string, right: string ): NonNullable<ResetReport[ 'drift' ]> {
		const bag = ( s: string ): Map<string, number> => {
			const m = new Map<string, number>();
			for ( const line of s.split( /\r?\n/ ) ) {
				const k = line.trimEnd();
				m.set( k, ( m.get( k ) ?? 0 ) + 1 );
			}
			return m;
		};

		const l = bag( left ), r = bag( right );
		let onlyInDeployed = 0, onlyInCanonical = 0;

		for ( const [ k, n ] of l ) onlyInDeployed  += Math.max( 0, n - ( r.get( k ) ?? 0 ) );
		for ( const [ k, n ] of r ) onlyInCanonical += Math.max( 0, n - ( l.get( k ) ?? 0 ) );

		// Counted off the same split, so a total can never disagree with the drift derived from it.
		let deployedLines = 0, canonicalLines = 0;
		for ( const n of l.values() ) deployedLines  += n;
		for ( const n of r.values() ) canonicalLines += n;

		return { onlyInDeployed, onlyInCanonical, deployedLines, canonicalLines };
	}

	/**
	 * Categorize every file under `kcd/` into one of the three real migration states. `overrides`
	 * maps a `kcd/`-stripped PREFIX to its real target prefix ( e.g. `{ 'docs/': 'references/kcd_sdk/'
	 * }` ) for the cases where the flat mirror of a `kcd/` path is not an actual home — deliberately a
	 * CALLER-supplied table, not baked in here: a different project's `kcd/` shape will need different
	 * overrides, and this function stays generic by not guessing at one project's history.
	 *
	 * Duplicate detection runs on the UN-overridden flat path — a file already deployed at its
	 * natural mirror is a duplicate regardless of where an unrelated file's override sends it.
	 */
	static planKcdMigration( vault: Vault, overrides: Record<string, string> = {} ): MigrationPlan {
		const actions: MigrationAction[] = [];
		const notes: string[] = [];

		for ( const f of vault.scan() ) {
			const rel = f.relativePath.replace( /\\/g, '/' );
			if ( rel !== 'kcd' && !rel.startsWith( 'kcd/' ) ) continue;
			const stripped = rel.slice( 4 ); // 'kcd/'.length

			if ( stripped.startsWith( 'templates/' ) ) {
				actions.push( { kind: 'extract-template', kcdPath: rel } );
				continue;
			}

			if ( vault.exists( `${ DOC_ROOT_PREFIX }/${ stripped }` ) ) {
				const diverged = vault.read( rel ) !== vault.read( stripped );
				actions.push( { kind: 'delete-duplicate', kcdPath: rel, deployedPath: stripped, diverged } );
				continue;
			}

			let target = stripped;
			for ( const [ from, to ] of Object.entries( overrides ) ) {
				if ( stripped.startsWith( from ) ) { target = to + stripped.slice( from.length ); break; }
			}
			actions.push( { kind: 'relocate', kcdPath: rel, targetPath: target } );
		}

		if ( actions.some( a => a.kcdPath === 'kcd/kcd.css' ) )
			notes.push( 'kcd/kcd.css is linked via a plain <link> tag, not a data-kcd-* href — no heal here sees it. Run fixStylesheetLinks() once its new home is settled.' );

		return { actions, notes };
	}

	/**
	 * Apply a plan's `delete-duplicate` and `relocate` actions — confirm-gated like every other
	 * write in this class. `extract-template` is reported, never applied: its destination is OUTSIDE
	 * the vault, in whatever package consumes this project, and that mapping is not this generic
	 * utility's to know. `relocate` reuses `vault.move()` verbatim — link-healing for free, same
	 * proven mechanism `kcd_move` already runs. `delete-duplicate` cannot use `move()` ( its
	 * destination already exists, which `move()` refuses by design ) — so it re-derives the same
	 * repoint-then-remove shape by hand: every inbound link to the `kcd/` copy is rewritten to point
	 * at the real deployed copy, then the stale file is removed, then the same post-condition
	 * `move()`/`delete()` both assert — no link may still resolve to the old path — is checked here too.
	 */
	static applyKcdMigration( vault: Vault, plan: MigrationPlan, opts?: { confirm?: boolean } ): MigrationApplyReport[] {
		const reports: MigrationApplyReport[] = [];

		for ( const action of plan.actions ) {
			if ( action.kind === 'extract-template' ) {
				reports.push( { action, applied: false, error: 'extract-template is not applied here — relocate it outside the vault, then delete the kcd/ source separately' } );
				continue;
			}
			if ( !opts?.confirm ) { reports.push( { action, applied: false } ); continue; }

			try {
				if ( action.kind === 'delete-duplicate' ) {
					const kcdAbs  = vault.toAbs( action.kcdPath );
					const newHref = `${ DOC_ROOT_PREFIX }/${ action.deployedPath }`;
					// Both passes, exactly as `move()` does it — this IS a move with the destination
					// already occupied, so it must see the same references a real move would.
					const found = vault.healOccurrences( kcdAbs, newHref );
					for ( const edit of [ ...found.graph, ...found.text ] ) vault.rewriteHref( edit );
					fs.unlinkSync( kcdAbs );
					const after = vault.healOccurrences( kcdAbs );
					vault.assertNoResidual( kcdAbs, 'migrate', [ ...after.graph, ...after.text ] );
				} else {
					vault.move( action.kcdPath, action.targetPath! );
				}
				reports.push( { action, applied: true } );
			} catch ( e ) {
				reports.push( { action, applied: false, error: e instanceof Error ? e.message : String( e ) } );
			}
		}
		return reports;
	}

	/**
	 * Bring every document up to the TWO-TIER stylesheet contract ( protocol §8.1, amended 2026-08-17 ):
	 * an inline baseline followed by a depth-relative `<link>`. Repairs both halves, reports both.
	 *
	 * `cssVaultRel` is where `kcd.css` sits relative to the vault root — omit it for a current vault
	 * ( root ), pass `kcd/kcd.css` for one created before 2026-07-26. The per-file href is DERIVED from
	 * it by `KcdEmit.cssHrefFor`, the same function the emitter calls, so the sweep and the writer
	 * cannot disagree. It previously took a finished href as a parameter and stamped one value across
	 * the corpus; handing one in is exactly how a machine-bound `file:///` URL reached 35 documents.
	 *
	 * LOAD-BEARING, not tidiness. An existing corpus carries no baseline at all until this runs, and
	 * until then those documents are unreadable in any viewer that will not load a stylesheet — which
	 * is the surface most readers use. A document written through `kcd_save` is born with both tiers.
	 *
	 * NOT A RE-EMIT, deliberately. Rebuilding each document through `KcdEmit` would also re-serialize
	 * its body, and `HtmlTree` normalizes whitespace on that round trip — so a repair sweep would
	 * flatten every document it touched. This performs head surgery instead and leaves the body's bytes
	 * alone. Revisit once the emitter stops flattening.
	 *
	 * KNOWN GAP ( narrowed 2026-08-17 ): matches one exact `<link rel="stylesheet" href="…">` form and
	 * passes over a document with no link, or a link whose attribute order differs, WITHOUT reporting
	 * it. The totals are "of the links we recognized", never "of every document". The OTHER half of
	 * that gap is closed — it walked `vault.scan()`, which drops anything that fails to parse, so a
	 * malformed document was invisible to the verb whose job is repairing documents.
	 */
	static fixStylesheetLinks( vault: Vault, cssVaultRel?: string, opts?: { confirm?: boolean } ): StylesheetFixReport[] {
		const reports: StylesheetFixReport[] = [];

		// RAW WALK, not `scan()` — a repair tool must reach the file it is repairing. `scan()` parses
		// each file and drops what fails, so the malformed document was invisible to the verb whose job
		// is fixing documents. Same correction as `health`; this docstring admitted the gap for weeks
		// while the code kept the behaviour.
		for ( const rel of vault.documentPaths() ) {
			const raw  = vault.read( rel );
			const link = KcdEmit.stylesheetLink( raw );
			if ( !link ) continue;

			// A LINK WE COULD NOT READ IS NOT A DOCUMENT WITHOUT ONE. Reported rather than skipped, so the
			// totals mean "of every document" instead of "of the ones we recognised" — the difference this
			// verb used to hide, because an unmatched tag left no trace at all.
			if ( link.href === null ) {
				reports.push( { path: rel, oldHref: '( unreadable href )', newHref: '', applied: false, baselineAdded: false } );
				continue;
			}

			const oldHref = link.href;
			const newHref = KcdEmit.cssHrefFor( rel, cssVaultRel );
			const before  = raw.slice( 0, link.index );
			const after   = raw.slice( link.index + link.tag.length );
			const tag     = link.tag.replace( oldHref, newHref );

			// The link's own indentation, which `before` ends with. It has to be lifted off and put back
			// in FRONT of the link, or the inserted block inherits it ( `\t\t<style>` ) and the link is
			// left flush against the margin — harmless to render and exactly the kind of stair-stepped
			// head that makes a corpus look machine-mangled.
			const indent = /([ \t]*)$/.exec( before )?.[ 1 ] ?? '';
			let   head   = before.slice( 0, before.length - indent.length );

			// Any baseline already sitting immediately before the link is REMOVED and rebuilt rather than
			// left alone. That is what makes this verb idempotent — a re-run repairs rather than
			// duplicating, and a block written by an older version of this code gets corrected instead of
			// being permanently grandfathered by a has-one-already check.
			const priorBaseline = /[ \t]*<style\b[^>]*>[\s\S]*?<\/style>[ \t]*\r?\n?$/i;
			const hadBaseline   = priorBaseline.test( head );
			head = head.replace( priorBaseline, '' );

			// Baseline in FRONT of the link, never behind it — §8.1's cascade rule. Behind it, the
			// document looks repaired and is styled by the wrong sheet.
			const rebuilt = head + KcdEmit.baselineBlock() + indent + tag + after;

			// Compared as bytes rather than guessed at from the two flags: "already correct" then means
			// the file is byte-identical to what this verb would write, not merely that it has A link and
			// A style block somewhere.
			if ( rebuilt === raw ) {
				reports.push( { path: rel, oldHref, newHref, applied: false, baselineAdded: false } );
				continue;
			}

			if ( opts?.confirm ) vault.write( rel, rebuilt );
			reports.push( { path: rel, oldHref, newHref, applied: !!opts?.confirm, baselineAdded: !hadBaseline } );
		}
		return reports;
	}
}
