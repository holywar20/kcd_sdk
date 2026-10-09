/**
 * The committed-tree types for a Constellation — single-currency, Node-free (`@kcd/core`).
 * WIRES ARE IMPLICIT in the tree: spine order is the sequential wire, and a branch's pass/fail are its outgoing
 * edges. A null port terminates the run (pass unwired = success, fail unwired = failed). Every node carries its
 * own `id`, distinct from a step's `ref`, so validation and the board can point at WHERE a thing is.
 */

/** The entry the read head (Navigator) begins at. Single exit; the board enforces that it connects only to an agent. */
export interface StartNode {
	kind: 'start';
	id:   string;
}

/** A terminal marker: the read head reaching one ends the run as done. A pass port wired into an End is the
 *  explicit "work complete here". */
export interface EndNode {
	kind: 'end';
	id:   string;
}

/** The EXECUTOR, the "who": the agent drives the work chained to its right. With nothing chained it resolves to a
 *  session, the human-in-the-loop terminal. */
export interface AgentNode {
	kind:  'agent';
	id:    string;
	agent: string;         // the agent id this node executes as
}

/** One unit of agent work: a code Step in the main-side registry (`ref`), else the authored artifact at `source`,
 *  whose vault path is its identity. `source` is absent only for code-step refs. */
export interface StepNode {
	kind:    'step';
	id:      string;          // node id — unique within this constellation
	ref:     string;          // human stem — the registry id, the head/log label, the result key
	source?: string;          // vault-relative artifact path — identity + what the loader composes
	model?:  string;          // model KEY: node override, else the staffed agent's; absent → the Step's default
	// ── Commit-time SNAPSHOT (frozen at compile; the run uses these, not live state — re-commit to refresh) ──
	agentId?:     string;     // the staffed agent's id — rides the turn so telemetry can key the run by agent
	agentName?:   string;     // the staffed agent's display NAME — surfaced in the transcript / telemetry ("basic tester")
	identity?:    string;     // the "who" — the staffed agent's frozen IDENTITY (systemPrompt + its lens compile)
	instruction?: string;     // the "what" — the artifact body; two frozen blocks, framing a run-time knob
	toolNames?:   string[];   // the agent's included tool NAMES; schemas resolve at run (never baked — wire stays lean)
}

/**
 * Routes on a contract's resolution. The `contract` id is stored now and evaluated in Phase 3; until then a
 * branch is valid but not walked. A null port terminates that path.
 */
export interface BranchNode {
	kind:     'branch';
	id:       string;
	contract: string;                // routing contract id (evaluated in Phase 3)
	model?:   string;                // EVALUATOR's model KEY; absent → the eval default
	pass:     ConNode[] | null;      // sub-sequence; null = terminate (success)
	fail:     ConNode[] | null;      // sub-sequence; null = terminate (failed); often loops back
}

/** Deterministic code with node-set `args`, self-evaluating to the boolean verdict a downstream Boolean Branch
 *  routes on. `args` are NEVER agent-set: that is the security barrier. */
export interface UtilityNode {
	kind:     'utility';
	id:       string;
	language: 'javascript';      // the box's language selector — only vanilla JS for now
	code:     string;            // the utility body — returns the boolean verdict (output captured too)
	args:     unknown[];         // node-configured arguments (untyped); never agent-set (the security barrier)
}

/** The routing primitive, DECOUPLED from evaluation: the upstream node produces the verdict and this only routes
 *  on it. A null port terminates that path. */
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

/** A map node — a data-shape step between steps. Typed for forward-compat; no builder. */
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

export type ConNode = StartNode | EndNode | AgentNode | StepNode | UtilityNode | BranchNode | BooleanBranchNode | ParallelNode | MapNode | NestedNode;

/**
 * The wire form — mirrors `SerializedAgent`. A Constellation only ever serializes once committed,
 * so `fromSerialized` rebuilds it pre-frozen.
 */
export interface SerializedConstellation {
	id:    string;
	nodes: ConNode[];
}
