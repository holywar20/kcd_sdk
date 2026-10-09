/**
 * A KEYSTONE — a first-party tool inside our perimeter, with both ends of the call in our hands, governed
 * like every other tool. Fields are grouped by WHO READS them: the model (`blurb`, `doc`), the person
 * (`caption`, `resultShape`), the interface (`inputSchema`, `gates`). The constructor is positional, so new
 * fields are APPENDED, never reordered. `blurb` is model text, never trimmed for a person.
 * Policy, surface and services are answered elsewhere (passport, mode map, package row), not on this class.
 */

/**
 * Gate id → the input property holding its subjects, or `null` when nothing is enumerable. Re-spelled from the
 * app's `ToolGateDecl`, which this package cannot import.
 */
export type KeystoneGates = Record<string, string | null>;

/**
 * Gate ids that mean the tool changes something; read by `summarize` only. Re-spelled, so a gate missing here
 * silences posture rather than claiming read-only. `browse` and `command` stay off: neither id settles it.
 */
const MUTATING_GATES = new Set( [ 'write', 'delete', 'starmind_self' ] );

export interface SerializedKeystone {
	name:         string;
	blurb:        string;
	group?:       string;
	gates?:       KeystoneGates;
	inputSchema?: Record<string, unknown>;
	doc?:         string;
	/** The human caption, RAW — unauthored stays empty here rather than resolving, so a round trip through
	 *  this shape cannot turn a fallback into an authored value. Resolve with `humanCaption()`. */
	caption?:     string;
	/** The illustrative result shape, as authored. */
	resultShape?: string;
}

export class Keystone {

	constructor(
		// Grouped by who reads each field, in comments. Parameters are positional: new ones are APPENDED, never reordered.
		//
		// ── IDENTITY ── `name` and `group`: every party reads these.
		/** The tool name an agent sees. Bare here — the group qualifies it at the wire, so this stays the
		 *  name a person says out loud. */
		readonly name: string,
		// ── THE MODEL READS ── `blurb` here, and `doc` below ( positional, so it stays last ).
		/** What it does, in one sentence — the tool description the model is handed. Write it for a model and do
		 *  not trim it to suit a person; their read is `caption`. */
		readonly blurb: string,
		/** The package it belongs to — a plain string, as the app's roster is out of reach here; main checks it at
		 *  registration. Not a server: a package is the app's install and routing namespace. Empty means ungrouped. */
		readonly group: string = '',
		/** Its security declaration, in the same shape as every other tool's. `{}` means genuinely none apply;
		 *  an absent one is refused at serve. `validateToolGates` is the one guard, not a `promoted` flag. */
		readonly gates: KeystoneGates = {},
		// ── THE INTERFACE READS ── `inputSchema` here, and `gates` above.
		/** What it takes, as JSON Schema — the same shape any other tool publishes, because from an agent's
		 *  side this IS any other tool. */
		readonly inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
		/** The full account, fetched rather than carried. Empty when the blurb already exhausts the tool; write
		 *  one for a scope, a refusal an agent must interpret, or a rule the schema does not show. */
		readonly doc: string = '',
		// ── THE PERSON READS ── `caption` and `resultShape`.
		/** The short human read, five to twelve words, with no tool names, backticks or gate vocabulary. Read it only
		 *  through `humanCaption()`, which falls back to `blurb` while this is empty. */
		readonly caption: string = '',
		/** Illustrative and hand-maintained, beside the implementation: change it in the same commit as the tool's
		 *  output. A string, never parsed, and never sent to the model — a parsed example becomes a contract. */
		readonly resultShape: string = ''
	) {}

	/** The authored `caption`, or `blurb` when none was written — the one place this fallback lives. A service falls
	 *  back to nothing, since its prose is long; a keystone's blurb is one sentence, so falling back costs nothing. */
	humanCaption(): string {
		return this.caption.trim() || this.blurb;
	}

	/** Three lines for a tooltip: `name · group`, the human caption, then what it takes and governs. Posture is
	 *  one-way: `WRITES` on a mutating gate, never a read-only claim. The group is shown, never joined as `group__tool`. */
	summarize(): string {
		const title = this.group ? `${ this.name } · ${ this.group }` : this.name;
		return [ title, this.humanCaption(), `${ this._takes() } ${ this._governs() }` ]
			.filter( ( line ) => line.trim() )
			.join( '\n' );
	}

	/** What it is ABOUT — the arguments with no default. Nothing names the optional ones: the required set is
	 *  what says what the tool does, and the whole schema is what `inputSchema` is for. */
	private _takes(): string {
		const properties = ( this.inputSchema[ 'properties' ] ?? {} ) as Record<string, unknown>;
		const required   = ( this.inputSchema[ 'required' ]   ?? [] ) as unknown[];
		const named      = required.filter( ( r ): r is string => typeof r === 'string' );
		if( named.length ) return `Takes ${ named.join( ', ' ) }.`;
		// TWO DIFFERENT FACTS, and a person choosing a tool reads them differently: one takes nothing at all,
		// the other takes several things and insists on none of them.
		return Object.keys( properties ).length ? 'Every argument optional.' : 'Takes no arguments.';
	}

	/** What governs it, off the declaration. `{}` reads as UNGOVERNED out loud: the one fact a person choosing
	 *  a toolset cannot see anywhere else. */
	private _governs(): string {
		const ids = Object.keys( this.gates );
		if( !ids.length ) return 'Ungoverned — no action gate applies.';
		const writes = ids.some( ( id ) => MUTATING_GATES.has( id ) );
		return `Governed by ${ ids.join( ', ' ) }${ writes ? ' — WRITES.' : '.' }`;
	}

	serialize(): SerializedKeystone {
		return {
			name: this.name, blurb: this.blurb, group: this.group,
			gates: { ...this.gates }, inputSchema: this.inputSchema, doc: this.doc,
			caption: this.caption, resultShape: this.resultShape
		};
	}

	static fromSerialized( json: SerializedKeystone ): Keystone {
		return new Keystone(
			json.name, json.blurb, json.group ?? '', json.gates ?? {},
			json.inputSchema ?? { type: 'object', properties: {} }, json.doc ?? '',
			json.caption ?? '', json.resultShape ?? ''
		);
	}
}
