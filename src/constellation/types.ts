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

/**
 * A utility node — runs a deterministic code utility (vanilla JS for now) with NODE-set arguments,
 * captures its output, AND self-evaluates to a boolean verdict. The exit surface is the crux: a utility
 * is not arbitrary code, it is code that JUDGES itself — `code` returns the boolean a downstream
 * Boolean Branch routes on (a richer `{ pass, output }` return is also honoured). `args` are configured
 * by the user/node and are NEVER set by an agent — that is the security barrier (an agent-set parameter
 * would reach across the wall). Single exit. The "AI-call → declarative utility" thesis, made concrete.
 */
export interface UtilityNode {
	kind:     'utility';
	id:       string;
	language: 'javascript';      // the box's language selector — only vanilla JS for now
	code:     string;            // the utility body — returns the boolean verdict (output captured too)
	args:     unknown[];         // node-configured arguments (untyped); never agent-set (the security barrier)
}

/**
 * A boolean branch — the routing primitive, DECOUPLED from evaluation. The upstream node (a utility, a
 * contract) PRODUCES the boolean verdict; this node only ROUTES the read head on it. Two ports: a null
 * port terminates that path (pass unwired = success, fail unwired = failed). Named "boolean" so the
 * interface it expects — a boolean verdict on the prior result — is explicit at the call site.
 */
export interface BooleanBranchNode {
	kind: 'boolean-branch';
	id:   string;
	pass: ConNode[] | null;      // sub-sequence; null = terminate (success)
	fail: ConNode[] | null;      // sub-sequence; null = terminate (failed); often loops back to re-evaluate
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

export type ConNode = StartNode | AgentNode | StepNode | UtilityNode | BranchNode | BooleanBranchNode | ParallelNode | MapNode | NestedNode;

/**
 * The wire form — mirrors `SerializedAgent`. A Constellation only ever serializes once committed,
 * so `fromSerialized` rebuilds it pre-frozen.
 */
export interface SerializedConstellation {
	id:    string;
	nodes: ConNode[];
}
