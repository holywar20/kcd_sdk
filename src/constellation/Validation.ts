/**
 * Constellation validation — the KCD `typeCheck` idiom, narrowed to STRINGS.
 *
 * Ruling (Bryan, 2026-06-24): no error objects, no severity, no codes, no located-issue type —
 * just human-readable message strings, drawn from named constants we can grep and (later) encode.
 * `validate()` returns a `ConstellationValidation` (empty = valid). Context-free messages are
 * constants; id-specific ones are tiny builders that still return a plain string.
 */

/** The result of validating a Constellation — a flat list of error messages. Empty = valid. */
export type ConstellationValidation = string[];

/** The structural error messages. Constants where context-free; builders (still → string) where not. */
export const ConstellationError = {
	NOT_COMMITTED:    'Constellation is not committed — call .commit() before running it.',
	EMPTY:            'Constellation has no nodes.',
	duplicateId:      ( id: string ) => `Duplicate node id "${ id }".`,
	emptyStepRef:     ( id: string ) => `Step node "${ id }" references no Step.`,
	agentNoRef:       ( id: string ) => `Agent node "${ id }" references no agent.`,
	branchNoContract: ( id: string ) => `Branch node "${ id }" has no contract.`,
	branchDeadPorts:  ( id: string ) => `Branch node "${ id }" wires neither a pass nor a fail port.`,
} as const;
