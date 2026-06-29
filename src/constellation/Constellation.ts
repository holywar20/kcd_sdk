import { ConstellationError, type ConstellationValidation } from './Validation';
import type { ConNode, BranchNode, BooleanBranchNode, SerializedConstellation } from './types';

/**
 * A Constellation — many Steps wired into one named, runnable pattern. The root primitive of the
 * workflow layer (built above the orchestrator, not a rewrite of it).
 *
 * Mirrors `Agent`: a standalone, pure-data class (no `fs`) that a fluent builder authors AND that
 * crosses the IPC bridge via `serializeForWire()` / `fromSerialized()`. The builder and the graph
 * are ONE object — you hold the instance, chain verbs onto it, and `.commit()` freezes it. An
 * invalid Constellation still freezes (its issues stay inspectable) but is NOT executable.
 *
 * `validate()` runs on the instance and is pure structural, so the renderer can check a graph live.
 * BINDING validation — does each step / contract id resolve HERE — is the Navigator's job, main-side.
 */
export class Constellation {

	readonly id: string;
	private _nodes:     ConNode[];
	private _committed: boolean;
	private _cursor:    ConNode[];          // where the next verb appends (top-level by default)
	private _ids:       { n: number };      // node-id counter, shared across the builder tree

	private constructor( id: string, nodes: ConNode[] = [], committed = false, ids = { n: 0 } ) {
		this.id         = id;
		this._nodes     = nodes;
		this._committed = committed;
		this._cursor    = this._nodes;
		this._ids       = ids;
	}

	// ── Authoring ──────────────────────────────────────────────────────────────

	static define( id: string ): Constellation {
		return new Constellation( id );
	}

	/** Append a Start node — the read head's entry point (the board's gray "Start" box). */
	start(): this {
		this._guardOpen();
		this._cursor.push( { kind: 'start', id: this._mint( 'start' ) } );
		return this;
	}

	/** Append an End node — a terminal marker; the head reaching one ends the run as done. */
	end(): this {
		this._guardOpen();
		this._cursor.push( { kind: 'end', id: this._mint( 'end' ) } );
		return this;
	}

	/** Append an Agent node — the executor the head runs the chained work as. */
	agent( agentId: string ): this {
		this._guardOpen();
		this._cursor.push( { kind: 'agent', id: this._mint( 'agent' ), agent: agentId } );
		return this;
	}

	/** Append a Step to the spine. `ref` is the registry Step id the Navigator resolves. */
	then( ref: string ): this {
		this._guardOpen();
		this._cursor.push( { kind: 'step', id: this._mint( 'step' ), ref } );
		return this;
	}

	/**
	 * Append a Utility — a self-evaluating code node. `language` selects the runtime (vanilla JS only,
	 * for now); `code` is the body that returns the boolean verdict; `args` are node-set (never agent-set
	 * — the security barrier). Single exit; pair it with a `.booleanBranch()` to route on its verdict.
	 */
	utility( spec: { language?: 'javascript'; code: string; args?: unknown[] } ): this {
		this._guardOpen();
		this._cursor.push( {
			kind:     'utility',
			id:       this._mint( 'utility' ),
			language: spec.language ?? 'javascript',
			code:     spec.code,
			args:     spec.args ?? [],
		} );
		return this;
	}

	/**
	 * Append a Boolean Branch — routes the head on the PRIOR node's boolean verdict (decoupled from
	 * evaluation: the upstream utility/contract produced the boolean; this only routes it). `pass` / `fail`
	 * are sub-builders; an omitted port terminates that path (pass = success, fail = failed).
	 */
	booleanBranch( ports: { pass?: ( w: Constellation ) => void; fail?: ( w: Constellation ) => void } ): this {
		this._guardOpen();
		const node: BooleanBranchNode = { kind: 'boolean-branch', id: this._mint( 'boolbranch' ), pass: null, fail: null };
		if ( ports.pass ) node.pass = this._sub( ports.pass );
		if ( ports.fail ) node.fail = this._sub( ports.fail );
		this._cursor.push( node );
		return this;
	}

	/**
	 * Append a branch that routes on a contract. `pass` / `fail` are sub-builders (`w => w.then(…)`)
	 * authored against a fresh cursor; an omitted port stays null (= terminate that path). The
	 * contract is stored now; routing on it lands in Phase 3.
	 */
	branch( contract: string, ports: { pass?: ( w: Constellation ) => void; fail?: ( w: Constellation ) => void } ): this {
		this._guardOpen();
		const node: BranchNode = { kind: 'branch', id: this._mint( 'branch' ), contract, pass: null, fail: null };
		if ( ports.pass ) node.pass = this._sub( ports.pass );
		if ( ports.fail ) node.fail = this._sub( ports.fail );
		this._cursor.push( node );
		return this;
	}

	/** Append a parallel fan-out. Each lane is a sub-builder authored against its own cursor. */
	parallel( lanes: Array<( w: Constellation ) => void> ): this {
		this._guardOpen();
		this._cursor.push( { kind: 'parallel', id: this._mint( 'parallel' ), lanes: lanes.map( ( l ) => this._sub( l ) ) } );
		return this;
	}

	/** Freeze the tree. Validation is read via `validate()` / `isExecutable()`; an invalid one still freezes. */
	commit(): this {
		this._committed = true;
		return this;
	}

	// ── Validation (strings, not objects) ──────────────────────────────────────

	isCommitted():  boolean { return this._committed; }
	isExecutable(): boolean { return this._committed && this.validate().length === 0; }

	/**
	 * Structural validation — pure, runs in the renderer. An extensible rule list: as the system
	 * grows, add rules here (orphan / seam-shape / fail-loop governor). Returns plain strings.
	 */
	validate(): ConstellationValidation {
		const errors: ConstellationValidation = [];
		if ( !this._nodes.length ) errors.push( ConstellationError.EMPTY );
		const seen = new Set<string>();
		this._walk( this._nodes, ( n ) => {
			if ( seen.has( n.id ) ) errors.push( ConstellationError.duplicateId( n.id ) );
			seen.add( n.id );
			if ( n.kind === 'step'    && !n.ref )             errors.push( ConstellationError.emptyStepRef( n.id ) );
			if ( n.kind === 'agent'   && !n.agent )          errors.push( ConstellationError.agentNoRef( n.id ) );
			if ( n.kind === 'utility' && !n.code.trim() )    errors.push( ConstellationError.utilityNoCode( n.id ) );
			if ( n.kind === 'branch'  && !n.contract )       errors.push( ConstellationError.branchNoContract( n.id ) );
			if ( n.kind === 'branch'  && !n.pass && !n.fail ) errors.push( ConstellationError.branchDeadPorts( n.id ) );
			if ( n.kind === 'boolean-branch' && !n.pass && !n.fail ) errors.push( ConstellationError.boolBranchDead( n.id ) );
		} );
		return errors;
	}

	// ── Bridge (mirrors Agent) ──────────────────────────────────────────────────

	serializeForWire(): SerializedConstellation {
		return { id: this.id, nodes: structuredClone( this._nodes ) };
	}

	static fromSerialized( json: SerializedConstellation ): Constellation {
		return new Constellation( json.id, structuredClone( json.nodes ), true );   // serialized ⇒ committed
	}

	/** The committed spine (read-only access for the Navigator's walk). */
	nodes(): ConNode[] { return this._nodes; }

	// ── internals ────────────────────────────────────────────────────────────────

	private _guardOpen(): void {
		if ( this._committed ) throw new Error( `Constellation "${ this.id }" is committed — cannot author further.` );
	}

	/** Author a sub-sequence against a transient builder that SHARES this tree's id counter. */
	private _sub( build: ( w: Constellation ) => void ): ConNode[] {
		const sub = new Constellation( this.id, [], false, this._ids );
		build( sub );
		return sub._nodes;
	}

	private _mint( prefix: string ): string {
		this._ids.n += 1;
		return `${ prefix }-${ this._ids.n }`;
	}

	/** Depth-first visit of every node, descending into branch ports and parallel lanes. */
	private _walk( nodes: ConNode[], visit: ( n: ConNode ) => void ): void {
		for ( const n of nodes ) {
			visit( n );
			if ( n.kind === 'branch' || n.kind === 'boolean-branch' ) {
				if ( n.pass ) this._walk( n.pass, visit );
				if ( n.fail ) this._walk( n.fail, visit );
			} else if ( n.kind === 'parallel' ) {
				for ( const lane of n.lanes ) this._walk( lane, visit );
			}
		}
	}
}
