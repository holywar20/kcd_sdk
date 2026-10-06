import * as fs from 'fs';
import { KCDPrimitive, KCDValidationError, LensObject } from '../primitives';
import type { SlotMode, LinkEntry, AddressEntry } from '../primitives';
import type { Vault } from './Vault';
import type { ArtifactRef } from '../core';
// `path`, `InstallManifest` and `KcdEmit` LEFT WITH THE SEVEN DELETED MEMBERS on 2026-10-05
// ( TASK-730 ) — they were reached only by `applySeed`, `reset` and `fixStylesheetLinks`. What is
// left here resolves paths through the `Vault` facade, which is what this class was always meant to
// compose over.
import { VaultLayout, Glob } from '../core';

/** Where the seed source lives, vault-relative — protocol §10's one payload-per-host document. */
const ROOT_CONTEXT_PATH = 'root-context.html';

/**
 * THE DOC ROOT IS THE VAULT'S, NOT A CONSTANT HERE. This file used to hold
 * `const DOC_ROOT_PREFIX = '_Claude'` because `Vault.docRoot` was private — a literal asserting one
 * vendor owns the folder, in a system that is not vendor-specific, with nowhere to override it. The
 * cost was not theoretical: `lensIndex` wrote `_Claude/lenses/…` hrefs into the entry document of a
 * vault actually named `_kcd`, and nothing reported the mismatch. `docRoot` is a project VARIABLE;
 * it is now read off the vault at every site that needs it.
 */

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
 *  matter what the lens authors ( the merged care band, the manifest, the structure ).
 *
 *  DISPLAY-ONLY, and deliberately NOT `SlotMode`. `SlotMode` is the core off/on/load currency the whole
 *  composition UI is built on; this type is consumed only by `lensView`, so a new value here cannot reach
 *  the slotting surfaces. */
export type SlotState = SlotMode | 'empty' | 'fixed';

/** One row of a lens's compiled-context breakdown — a component, where it CAME FROM, its kind, its state,
 *  and the tokens it actually contributes to the compiled context. */
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

/** A lens's compiled-context detail — every component with its source, state and real token weight, plus the
 *  total. The structured form behind the `show` chart.
 *
 *  Priced from a BUILT AGENT, so this reports what a session wearing this lens ACTUALLY receives. `tokens` is
 *  the same number `compile` reports for
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
	/** Which page of refs to return, 1-based. Out of range clamps to the last page rather than
	 *  answering empty — an off-by-one should cost a reader nothing. Ignored by a census, which is
	 *  never paged. */
	page?:    number;
}

/** Either the matching refs, or — with `groupBy: 'type'` — a type census sorted by count descending. */
export type QueryMatches = ArtifactRef[] | { type: string; count: number }[];

/** What a query answers: what matched, and what it could not read well enough to say.
 *
 *  `unreadable` is not a subset of a failed match. Those documents were never examined — they could not
 *  be parsed — so nothing here claims they WOULD have matched, only that the answer above is silent
 *  about them. A caller that ignores the field gets exactly the old behaviour. */
export interface QueryResult {
	matches:    QueryMatches;
	unreadable: string[];
	/** How many refs matched IN TOTAL, before the page was cut — so a caller holding 20 rows knows
	 *  whether it is holding the answer or the start of one. A census reports its own length. */
	total:      number;
	/** The page returned, 1-based, and how many there are. Both `1` for a census, and for any result
	 *  that fits on one page — which is what lets a caller emit the bare array it always did. */
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

/** The result of applying one seed — a report always, a write only when `applied` is true.
 *  ORPHANED 2026-10-05 ( TASK-730 ): `applySeed` produced this and is deleted. Kept only because it is
 *  exported through the `@kcd` barrel. */
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
 *  WAS the whole file, so nothing of the project's own was ever at stake.
 *  ORPHANED 2026-10-05 ( TASK-730 ): `removeSeed` produced this and is deleted. */
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
 *  `applied` is true, same confirm-gated shape as `SeedApplyReport`.
 *  ORPHANED 2026-10-05 ( TASK-730 ): `gitignore` produced this and is deleted, and nothing writes a
 *  managed block into `.gitignore` any more. */
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



/** The result of a per-artifact restore-to-canonical — a report always, a write only when `applied`
 *  is true. ORPHANED 2026-10-05 ( TASK-730 ): `VaultUtilities.reset` produced this and is deleted.
 *  `VaultDeploy.apply` is the live deploy path and does NOT return this shape. */
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

/** A migration plan — the actions a planner decided, plus anything it found that no action covered.
 *  ORPHANED 2026-10-05 ( TASK-730 ): `planKcdMigration` and `applyKcdMigration` produced and consumed
 *  this and are both deleted; the type is kept only because it is exported through the `@kcd` barrel. */
export interface MigrationPlan {
	actions: MigrationAction[];
	notes:   string[];
}

/** ORPHANED 2026-10-05 ( TASK-730 ): `applyKcdMigration` produced this and is deleted. */
export interface MigrationApplyReport {
	action:  MigrationAction;
	applied: boolean;
	error?:  string;
}

/** One stylesheet `<link>` fix — `kcd.css`'s relative depth changes with every file it's linked
 *  from, and it is plain HTML, not a `data-kcd-*` href, so no existing heal mechanism sees it.
 *  ORPHANED 2026-10-05 ( TASK-730 ): `fixStylesheetLinks` produced this and is deleted. */
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
 * every caller — the documentation tools, the app's own saves, a test — reaches the SAME method
 * here, so a validation behaviour can never exist for one caller and not another.
 *
 * ── SEVEN MEMBERS WERE DELETED FROM THIS CLASS ON 2026-10-05 ( Bryan, TASK-730 ) ──
 * `applySeed`, `removeSeed`, `gitignore`, `reset`, `planKcdMigration`, `applyKcdMigration` and
 * `fixStylesheetLinks`, plus `reset`'s private helper `lineDrift`, which had no other caller. Every
 * one of them was named only in comments: no call site anywhere in the tree, and no test. The live
 * reset-and-repair path is `VaultDeploy.apply`, which is untouched.
 *
 * REGENERATING `CLAUDE.md` FROM `root-context.html` IS RULED OUT, NOT FORGOTTEN. This is the line
 * the deletion exists to leave behind. `applySeed` maintained the `<!-- kcd:begin -->` /
 * `<!-- kcd:end -->` managed block that the §10 seed mechanism wrote into a project's `CLAUDE.md`,
 * and nothing had regenerated that file from the vault for some time before it went. Bryan was
 * offered both ends on 2026-10-05 — delete the dead code, or wire the seed mechanism back in — and
 * chose deletion. So a later reader who notices that `CLAUDE.md` does not track `root-context.html`
 * is looking at a DECISION and not a defect, and re-deriving the capability means re-opening the
 * ruling rather than fixing a regression.
 *
 * THE SEED PARSE SURVIVES, AND THAT IS NOT A HALF-MEASURE. `parseSeeds`, `parseSeedsFrom`,
 * `installedPaths` and `forDocRoot` are all still here and all still called — `installedPaths`
 * feeds `Survey`'s skip list through `VaultTools`. Reading what a vault DECLARES it seeds is a live
 * capability; WRITING those declarations into a host file is what was retired.
 *
 * THE REPORT TYPES ABOVE ARE NOW ORPHANS and were deliberately left in place, since they are
 * exported through the `@kcd` barrel and removing them is an API change rather than a dead-code
 * sweep: `SeedApplyReport`, `SeedRemoveReport`, `IgnoreScope`, `IgnoreReport`, `ResetReport`,
 * `MigrationActionKind`, `MigrationAction`, `MigrationPlan`, `MigrationApplyReport` and
 * `StylesheetFixReport` have no producer any more. `SeedBlock` is the exception — it is what
 * `parseSeeds` still returns.
 */
export class VaultUtilities {

	/**
	 * How many refs one page of `query` carries.
	 *
	 * A CONSTANT AND NOT A PARAMETER, deliberately. The reason to page at all is that an unscoped query
	 * over a real vault spends hundreds of refs on a reader who usually wanted three, and a per-call
	 * limit would be honoured by whoever already knew to set it — which is never the caller paying the
	 * cost. Fixing it here makes the saving default. Twenty is the number a reader can actually scan
	 * before deciding to narrow; change it here and every face changes with it.
	 */
	static readonly QUERY_PAGE_SIZE = 20;

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
	 * AN UNPARSEABLE DOCUMENT IS REPORTED. It is counted in `checked` and raised as an `error` — see
	 * the raw-walk note at the loop below. This docblock previously said the opposite ( that
	 * `vault.scan()` sourced the file list, so anything the scan dropped was invisible ), which was
	 * true of the old behaviour and false from the moment the walk changed. Corrected 2026-09-05.
	 * **The failure mode is worth naming because this file has now hit it twice**: a docstring that
	 * admits a gap keeps admitting it long after the code closed it, and the next reader believes the
	 * prose over the loop. The second case was `fixStylesheetLinks`, whose docstring admitted the same
	 * gap for weeks after its loop was corrected; it was deleted on 2026-10-05 ( TASK-730 ).
	 *
	 * WHAT IT STILL CANNOT SEE, stated so a clean report is not over-read: reference probing only
	 * resolves `_Claude/`-rooted hrefs, so a `file://` or off-vault link is neither resolved nor
	 * reported. And the gap between the filesystem and `scanned` is not measured at all — `scanned`
	 * counts what the walk yielded, not what exists.
	 *
	 * THE `scanned` − `checked` GAP IS BY DESIGN, not a shortfall. `documentPaths()` walks every
	 * document; `isLibraryPath` decides which are GRADED. Scratch and output space ( `indexed: false`
	 * — `work/`, `logs/`, `audits/` ) and archival space ( `archival: true` — `plans_complete` ) are
	 * scanned and deliberately not graded, for the two different category-error reasons the gate
	 * documents. So a healthy vault shows a real gap here and that is correct; a reader comparing the
	 * two numbers is seeing the filter, not a silence.
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
				const artifact = KCDPrimitive.fromHtml( vault.read( filePath ), vault.toAbs( filePath ), vault.docRoot );

				for ( const issue of artifact.typeCheck() )
					issues.push( { path: rel, ...issue } );
			} catch ( e ) {
				// ONE ISSUE PER ERROR, not one per document. A validation throw carries every finding on
				// `errors`; its `message` can only name the first, and building a single issue from that
				// sentence made a four-error document report as one. The tally is what a repair loop reads,
				// so an undercount does not look like an undercount — it looks like progress, and the sweep
				// reads green while the document is still broken.
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
	 * Compile one or more lenses to a context string — the LENS-scoped compiler.
	 *
	 * Builds a dumb agent ( `Vault.buildAgent` ) and compiles that, so both faces run one engine. The only
	 * difference between them is the agent's ENVIRONMENT — root context, live MCP tool defs, DB memory —
	 * which has no vault-side source, so a vault agent never binds it. It compiles the lenses alone: an
	 * agent's own system prompt, habits and tools are the agent compiler's, not this.
	 *
	 * Each name is a bare lens name ( `lenses/{name}/{name}.html` ) or a raw vault-relative path; `[0]` is
	 * primary. Throws on an empty list or an unresolvable name. The returned `lenses` reports what actually
	 * COMPILED, read off the built agent, so a lens named by raw path reports its artifact NAME.
	 */
	static compile( vault: Vault, lensNames: string[] ): CompileResult {
		const agent    = vault.buildAgent( lensNames );
		const compiled = agent.lenses.map( l => l.getName() );
		const text     = agent.compile();

		return { lenses: compiled, text, tokens: KCDPrimitive._estimateTokens( text ) };
	}

	/**
	 * The composition behind the `show` chart: what a session WEARING this lens receives, file by file.
	 * Priced from the compiled blocks.
	 *
	 * A view of the COMPOSITION, not of the text — what the object is built from, what each file costs, and
	 * which lens brought it, so editing an object and inspecting how it assembles is one loop. A thin
	 * projection of `Agent.composition()` rather than its own analysis: a chart that recomputed
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
		const lens  = agent.lenses[ 0 ];
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
	 * Does this glob deliberately reach into EPHEMERAL space — `work/`, `logs/`, `reports/`, `audits/`?
	 *
	 * The same prefix test as its archival twin above, and for the same reason: naming a bucket is a
	 * caller asking for it, anything looser is a sweep that should not be handed it. Kept as a separate
	 * predicate rather than folded into one, because the two exclusions are not the same fact —
	 * ephemeral content never ships and may not be linked into, archival content ships and must stay
	 * linkable — and a single helper would make that distinction unreadable at the call sites.
	 *
	 * Top-level segment only, matching `isEphemeralHref`, which is what it gates.
	 */
	private static globReachesEphemeral( pattern: string | undefined ): boolean {
		if ( !pattern ) return false;
		const top = pattern.replace( /\\/g, '/' ).replace( /^\.\//, '' ).replace( /^_Claude\//, '' ).split( '/' )[ 0 ];
		return top !== undefined && VaultLayout.ephemeralDirs().includes( top );
	}

	/**
	 * The single read-query over a vault — glob, type, and text, AND-combined over one scan.
	 * `glob` short-circuits through the Vault's own path filter; `type`/`text` narrow the
	 * survivors. `groupBy: 'type'` returns a census instead of refs — the cheapest orientation
	 * call, and how `query_docs`'s inspector example works. Moved out of the MCP handler ( 1.i ):
	 * this was the one tool whose filtering logic lived only on one face.
	 *
	 * ── IT REPORTS WHAT IT COULD NOT READ ──
	 * An unparseable document is dropped by the scan, which is correct and was also silent: it is absent
	 * from the result exactly as a document that does not exist is absent, and a reader has no way to tell
	 * the two apart. That cost a real agent twenty minutes over `_lens-base.html` — on disk, the cause of a
	 * vault-wide outage, and returned by no query under any glob; its absence was the only clue, and it was
	 * found by falling back to a raw file glob and noticing the file was there.
	 *
	 * The hazard was already known and already answered ONCE, for the health sweep: `documentPaths()` exists
	 * so a sweep can grade the file that failed to be an artifact. A sweep is not the only reader that needs
	 * it, and an ordinary read is the one where the silence actually costs something.
	 *
	 * NOT FILTERED BY `type` OR `text`, deliberately. Both need a parsed document, so applying them to a
	 * document that has none would be inventing an answer. `glob`, the archival rule and the EPHEMERAL rule
	 * DO apply — those are path facts, true of a file whatever is inside it, and reporting outside the
	 * caller's scope is noise. The ephemeral gate is what makes the advisory affordable at all; see the
	 * comment at the filter.
	 *
	 * ── IT ANSWERS ONE PAGE ──
	 * Refs come back `QUERY_PAGE_SIZE` at a time, with `total` and `pages` saying what the whole answer is,
	 * so a reader holding twenty rows can tell the answer from the start of one. A census is never paged.
	 *
	 * ARCHIVAL BUCKETS ARE EXCLUDED from an unscoped query, on the same rule the grading gate uses:
	 * naming them still returns them, because the caller asked. A retired plan answers "what did we
	 * do"; every other query is asking "what is true now", and mixing the two is how a query for
	 * live work comes back mostly history. It also stops churn — a document written against a
	 * standard that has since moved on keeps inviting a rewrite nobody wants, and the cheapest way
	 * to stop that is to not surface it.
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

		// THE ADVISORY IS SCOPED TO GRADED SPACE, which is the whole reason it is affordable.
		//
		// The fault list rides on EVERY query, so anything in it is a tax on every documentation call in
		// the project. Ephemeral space — `work/`, `logs/`, `reports/`, `audits/` — is where this vault's
		// agents write scratch by the hundred, none of it KCD and none of it meant to be: measured live
		// 2026-09-25, forty-eight such files were named on every call, roughly 800 tokens of advice about
		// documents nobody intends to fix. An advisory whose lines cannot be acted on trains a reader to
		// skip the whole block, which costs the one case it exists for.
		//
		// Same rule the health sweep already applies through `isLibraryPath`, arriving here late: a sweep
		// was not the only reader that needed the ephemeral gate, exactly as it was not the only reader
		// that needed the fault list. And the same courtesy as the archival rule beside it — NAMING the
		// bucket still reports it, because then the caller is asking about that space and a silent drop
		// would be the original bug wearing different clothes.
		//
		// Note what this does NOT touch: `matches`. A parseable document under `work/` is still returned,
		// because it is a real document and the caller may well want it. What is withdrawn is the
		// unsolicited complaint about the ones that are not.
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
			// A CENSUS IS NEVER PAGED. It is one row per artifact type — a dozen at the outside — and it is
			// the call a reader makes to find out how big the vault is before asking for any of it. Cutting
			// the orientation answer into pages would be paging the map.
			return { matches: census, unreadable, total: census.length, page: 1, pages: 1 };
		}

		// PAGED, because an unscoped query over a real vault answers with hundreds of refs and every one of
		// them is spent whether or not the reader wanted the list. The page size is a constant rather than a
		// parameter ( see `QUERY_PAGE_SIZE` ); the page NUMBER is the caller's, so this is pagination and
		// not a cap — a ceiling with no way to reach record 21 is data loss wearing a helpful face.
		const refs  = files.map( f => vault.toRef( f ) );
		const pages = Math.max( 1, Math.ceil( refs.length / VaultUtilities.QUERY_PAGE_SIZE ) );
		// Clamped both ends. `page: 0`, a negative, a fraction and a page past the end are all reader
		// errors that should cost nothing: answering empty for an off-by-one hides the results entirely and
		// reads exactly like a query that matched nothing.
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
	 * The link graph around one artifact: `outbound` ( what it declares, resolved ), `addresses`
	 * ( its own, each flagged `occupied` — a fact, never a verdict, protocol §1.1 ), and `inbound`
	 * ( every other file whose links resolve here, found by scanning + resolving the whole vault ).
	 * Moved out of the MCP handler ( 1.i ), same reason as `query`.
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
	 * Parse every §10 seed payload out of the seed source. A seed is the "§5 non-executing script
	 * idiom with a markdown type" — `<script type="text/kcd-md" data-kcd-seed="host"
	 * data-kcd-target="…" data-kcd-mode="…">payload</script>` — one block per agent host. Attribute
	 * order is NOT assumed ( each is matched independently within the captured tag ), so a document
	 * author reordering them cannot silently break extraction. A `<script>` without
	 * `type="text/kcd-md"` is skipped, not an error — root-context may grow other script content
	 * later.
	 */
	static parseSeeds( vault: Vault ): SeedBlock[] {
		return VaultUtilities.parseSeedsFrom( vault.read( ROOT_CONTEXT_PATH ), vault.docRoot );
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
	 * the installer, and there would then be two lists of host targets that could disagree.
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
	 * A seed payload rewritten for the vault it is actually being installed beside.
	 *
	 * The payload is prose an agent reads as instructions — "KCD tool paths resolve against
	 * `_Claude/`" — and it ships from the bundle naming the DEFAULT. Installed unchanged into a vault
	 * called something else, it tells every agent that opens the project to look in a folder that is
	 * not there, and the file it says that in is the first thing they read. Found 2026-09-10: an
	 * install with `--doc-root _kcd` produced a correct vault and a `CLAUDE.md` pointing at `_Claude`.
	 *
	 * A BLUNT REPLACEMENT IS THE RIGHT INSTRUMENT HERE, and it is worth saying why rather than
	 * reaching for a placeholder token. Where the vault IS the default this is the identity function,
	 * so it cannot misfire on the common case; where it is not, every occurrence of the default in
	 * this payload is wrong by construction, because the payload's whole subject is where this
	 * project's vault lives. A `{docRoot}` placeholder would buy precision the input cannot use and
	 * would leave a brace in the file for anyone who reads the seed source directly.
	 */
	private static forDocRoot( payload: string, docRoot?: string ): string {
		if ( !docRoot || docRoot === LensObject.DEFAULT_DOC_ROOT ) return payload;
		return payload.split( LensObject.DEFAULT_DOC_ROOT ).join( docRoot );
	}
}
