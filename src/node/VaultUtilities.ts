import * as fs from 'fs';
import { KCDPrimitive, SlotResolver } from '../primitives';
import type { SlotMode } from '../primitives';
import type { Vault } from './Vault';

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

/** Full health output — the flat issue list plus an errors-vs-warnings tally. */
export interface HealthReport {
	issues:  HealthIssue[];
	summary: {
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

/** The display state of one slot in a lens view: its dredge mode, or `empty` when nothing fills it. */
export type SlotState = SlotMode | 'empty';

/** One row of a lens's compiled-context breakdown — a component ( the lens's own identity, or one dredged
 *  slot ), its kind, its state ( off/on/suggested/empty ), and the tokens it contributes. */
export interface LensSlot {
	what:   string;
	kind:   string;
	state:  SlotState;
	tokens: number;
}

/** A lens's compiled-context detail — every component with its state and token weight, plus the total. The
 *  structured form behind the `show` chart; `slots[0]` is the lens's own identity, the rest its dredge slots. */
export interface LensView {
	lens:   string;
	path:   string;
	slots:  LensSlot[];
	tokens: number;
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
	 * Returns `{ issues, summary }`. The pre-flight before a save/move sweep and the observable
	 * form of the "internal state always viable" invariant.
	 */
	static health( vault: Vault, onlyFile?: string ): HealthReport {
		const issues: HealthIssue[] = [];

		const checkFile = ( filePath: string ) => {
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
			checkFile( onlyFile );
		} else {
			// The registry decides what is graded. Directories marked `indexed: false` are
			// scratch and output space — never library artifacts — so a whole-vault sweep
			// passes them through untouched rather than reporting them as malformed.
			// ...and only DOCUMENTS are validated as documents. A `.js` utility in the library is
			// declarative code, not a KCD artifact — the protocol says so outright ( "utility is
			// not a document type" ) — so grading it against the document schema reports a
			// category error, not a defect. This is the file-kind gate.
			for ( const f of vault.scan() )
				if ( vault.isLibraryPath( f.relativePath ) && /\.html?$/i.test( f.relativePath ) )
					checkFile( f.path );
		}

		for ( const ri of vault.referenceIssues( onlyFile || undefined ) )
			issues.push( { path: ri.path, severity: ri.severity, message: ri.message } );

		return {
			issues,
			summary: {
				total:    issues.length,
				errors:   issues.filter( i => i.severity === 'error' ).length,
				warnings: issues.filter( i => i.severity === 'warn' ).length,
			},
		};
	}

	/**
	 * Compile one or more lenses to a context string — Daedalus's LENS-scoped compiler.
	 *
	 * Deliberately NOT the agent compiler: it reuses only the stable low-level primitives a lens
	 * already self-compiles through ( `LensObject.getContextBlocks` → `SlotResolver.compile`, exactly
	 * what `LensObject.serializeForContext` does ), and touches none of the agent's environment-folding
	 * ( root context, live MCP tool defs, DB memory ) — those are RUNTIME layers a standalone vault has
	 * no source for, and they belong to Starmind. For a single lens the output equals that lens's own
	 * `serializeForContext()`; multiple lenses fold into one context, cross-lens habit contention resolved
	 * together. The "basic compilation framework" — advanced composition ( full agents ) requires Starmind.
	 *
	 * Each name is a bare lens name ( mapped to the `lenses/{name}/{name}.html` convention ) OR a raw
	 * vault-relative path. `[0]` is primary. Throws on an empty list or a name that resolves to nothing.
	 */
	static compile( vault: Vault, lensNames: string[] ): CompileResult {
		if ( lensNames.length === 0 )
			throw new Error( 'compile requires at least one lens' );

		const lenses = lensNames.map( name => {
			const rel = this.lensPath( name );
			// Existence checked in the VAULT-ROOT path space `loadLens` uses ( via `toAbs` ) — NOT
			// `vault.exists`, which resolves hrefs against the project root ( the `_Claude/`-prefixed link
			// space ) and would miss a lens sitting at its own vault-relative path.
			if ( !fs.existsSync( vault.toAbs( rel ) ) )
				throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );
			return vault.loadLens( rel );
		} );

		const blocks = lenses.flatMap( l => l.getContextBlocks() );
		const text   = SlotResolver.compile( blocks );

		return { lenses: lensNames, text, tokens: KCDPrimitive._estimateTokens( text ) };
	}

	/**
	 * A lens's compiled-context DETAIL — the structured breakdown behind the `show` chart. Reads the same
	 * lens-scoped composition `compile()` produces, but keeps it decomposed: `slots[0]` is the lens's OWN
	 * identity ( its Care/Know body + the routing tables it authors ), and each following row is one dredge
	 * SLOT off the lens's policy — its state ( off / on / suggested, or `empty` when the slot is a
	 * placeholder nothing fills ) and the tokens that component contributes. Single lens only ( a lens is
	 * what you inspect; a multi-lens compile is `compile()` ).
	 */
	static lensView( vault: Vault, name: string ): LensView {
		const rel = this.lensPath( name );
		if ( !fs.existsSync( vault.toAbs( rel ) ) )
			throw new Error( `no lens found for "${ name }" ( looked for ${ rel } )` );

		const lens = vault.loadLens( rel );
		const base = ( p: string ): string => p.replace( /\\/g, '/' ).split( '/' ).pop() ?? '';

		const lensPath = lens.getPath() ?? rel;
		const slots: LensSlot[] = [
			// The lens's own identity — its Care/Know body, always fully in.
			{ what: 'identity', kind: 'lens', state: 'suggested', tokens: lens.bodyTokens() },
		];

		// Each dredge slot is a policy row. Rather than lean on the dredge ( which loads `on` children as
		// display-only, skips `off` and plans, and a non-eager lens loads none at all ), resolve + load each
		// target DIRECTLY through the same resolver the dredge uses. That lets every slot report its artifact's
		// real type and the token cost it pays AT ITS MODE ( `modeTokens` — `on` = routing row, `suggested` =
		// full body, `off` = 0 ) uniformly across references, habits, plans, and contracts. A placeholder href
		// ( `{…}` ) is an empty slot nothing fills.
		for ( const entry of lens.getPolicy() ) {
			const href = entry.href?.trim() ?? '';
			if ( href === '' || /^\{.*\}$/.test( href ) ) {
				slots.push( { what: entry.what || '( unnamed )', kind: '', state: 'empty', tokens: 0 } );
				continue;
			}
			const target = this.tryLoad( vault, href );
			slots.push( {
				what:   entry.what || ( target ? target.getName() : base( href ) ),
				kind:   target ? target.getType() : this.kindFromHref( href ),
				state:  entry.mode,
				// The cost the compile ACTUALLY pays at this slot's mode — `on` reduces to its routing row
				// ( ~tens of tokens ), `suggested` rides the full body ( ~hundreds ), `off` contributes nothing.
				// The same `modeTokens` split the Starmind composition UI reads, so the two never disagree.
				tokens: target ? target.modeTokens( entry.mode, entry.why ) : 0,
			} );
		}

		return {
			lens:   lens.getName() || name,
			path:   lensPath,
			slots,
			tokens: slots.reduce( ( sum, s ) => sum + s.tokens, 0 ),
		};
	}

	/** Resolve a policy href to disk ( the resolver the dredge uses ) and load the full artifact — for the
	 *  `show` breakdown, which prices every slot regardless of mode. Null on an unresolvable or unreadable
	 *  target ( a dangling link ), so the caller falls back to an href-inferred kind and zero weight. */
	private static tryLoad( vault: Vault, href: string ): KCDPrimitive | null {
		try {
			const abs = vault.resolveHref( href );
			if ( !fs.existsSync( abs ) ) return null;
			return KCDPrimitive.fromHtml( fs.readFileSync( abs, 'utf-8' ), abs );
		} catch {
			return null;
		}
	}

	/** Best-effort artifact kind from an href's path segment — the fallback when a slot's target can't be
	 *  loaded ( a dangling link ), so its real `getType()` is unavailable. */
	private static kindFromHref( href: string ): string {
		const h = href.replace( /\\/g, '/' );
		if ( /(^|\/)references?\//.test( h ) ) return 'reference';
		if ( /(^|\/)habits?\//.test( h ) )     return 'habit';
		if ( /(^|\/)plans?\//.test( h ) )      return 'plan';
		if ( /(^|\/)contracts?\//.test( h ) )  return 'contract';
		return '';
	}

	/** A bare name → the lens-file convention; a value already carrying a slash or an `.html` tail is a
	 *  raw vault-relative path, used as-is. */
	private static lensPath( nameOrPath: string ): string {
		if ( nameOrPath.includes( '/' ) || /\.html?$/i.test( nameOrPath ) ) return nameOrPath;
		return `lenses/${ nameOrPath }/${ nameOrPath }.html`;
	}
}
