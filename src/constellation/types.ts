/**
 * The committed-tree types for a Constellation — single-currency, Node-free (`@kcd/core`).
 *
 * A Constellation serializes as a tree: an ordered spine of nodes, where a branch's pass/fail
 * and a parallel's lanes hold their own sub-sequences. WIRES ARE IMPLICIT in the tree —
 * spine order is the sequential wire; a branch's pass/fail are its outgoing edges; a null port
 * terminates the run (the no-sink ruling — `pass` unwired = done/success, `fail` unwired =
 * done/failed). Every node carries its own `id` (distinct from a step's `ref`) so validation and
 * the board can point at WHERE a thing is.
 */

/**
 * A start node — the entry the read head (Navigator) begins at. Single exit, and the board enforces
 * that it can only connect to an agent. The board's repurposed gray "Start" box.
 */
export interface StartNode {
	kind: 'start';
	id:   string;
}

/**
 * An agent node — the EXECUTOR (the "who"). The head moves here and the agent drives the work chained
 * to its right (Task nodes, in sequence); an agent with nothing chained resolves to a session (the
 * human-in-the-loop terminal). `agent` is the agent id this node runs as.
 */
export interface AgentNode {
	kind:  'agent';
	id:    string;
	agent: string;         // the agent id this node executes as
}

/** A step node — runs one registered Step (resolved by `ref` in the main-side StepRegistry). */
export interface StepNode {
	kind: 'step';
	id:   string;          // node id — unique within this constellation
	ref:  string;          // the registry Step id this node runs
}

/**
 * A branch node — routes on a contract's resolution. The `contract` id is STORED now and
 * EVALUATED in Phase 3; in Phases 1–2 a branch is structurally valid but not yet walked.
 * A null port terminates that path.
 */
export interface BranchNode {
	kind:     'branch';
	id:       string;
	contract: string;                // routing contract id (evaluated in Phase 3)
	pass:     ConNode[] | null;      // sub-sequence; null = terminate (success)
	fail:     ConNode[] | null;      // sub-sequence; null = terminate (failed); often loops back
}

/** A parallel node — fan out across lanes, then join. Each lane is its own sub-sequence. */
export interface ParallelNode {
	kind:  'parallel';
	id:    string;
	lanes: ConNode[][];
}

/** A map node — a data-shape step between steps. Typed for forward-compat; no builder this slice. */
export interface MapNode {
	kind: 'map';
	id:   string;
}

/** A nested constellation, run as a single step — fractal composition. `ref` is another id. */
export interface NestedNode {
	kind: 'constellation';
	id:   string;
	ref:  string;
}

export type ConNode = StartNode | AgentNode | StepNode | BranchNode | ParallelNode | MapNode | NestedNode;

/**
 * The wire form — mirrors `SerializedAgent`. A Constellation only ever serializes once committed,
 * so `fromSerialized` rebuilds it pre-frozen.
 */
export interface SerializedConstellation {
	id:    string;
	nodes: ConNode[];
}
