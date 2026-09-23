/**
 * The main-process barrel — the full SDK surface. Re-exports the Node-free core, plus the
 * Node-only layers: the scanner, the server-building patterns, and the disk I/O helpers.
 * `@kcd` resolves here. The renderer must NOT import this barrel — only `@kcd/core`.
 */
export * from '../core';
export * from '../scanner';
export * from '../server';
export { fsReader, inferProjectRoot, findPackageRoot, loadLensFromDisk } from './io';
export { Vault, type HealPlan, type HealEdit, type HealFindings, type RefIssue } from './Vault';
export {
	VaultUtilities,
	type HealthReport, type HealthIssue, type CompileResult,
	type LensView, type LensSlot, type SlotState,
	type ResetReport, type QueryOptions, type QueryResult, type LinksResult,
	type SeedBlock, type SeedApplyReport,
	type MigrationActionKind, type MigrationAction, type MigrationPlan, type MigrationApplyReport,
	type StylesheetFixReport,
} from './VaultUtilities';
export { VaultDeploy, type DeployReport, type DeployItem, type DeployItemKind, type DeployOptions } from './VaultDeploy';
export { VaultSnapshot, type SnapshotInfo } from './VaultSnapshot';
export { NavIndex, type NavIndexEntry, type NavIndexResult } from './NavIndex';
export {
	VaultTools, VAULT_TOOL_OPS,
	type VaultToolOp, type VaultToolNames, type VaultToolSpec, type VaultToolInvoke, type VaultBatchStep, type VaultToolsOptions,
} from './VaultTools';
export {
	Survey,
	type SurveyReport, type SurveyComponent, type ComponentKind,
	type SurveyLanguage, type SurveyEntryPoint, type SurveyTests,
} from './Survey';
export {
	SdkFileAccess, LIST_CAP, READ_CAP_BYTES, GLOB_CAP, GLOB_WALK_CAP,
	SEARCH_MATCH_CAP, SEARCH_WALK_CAP, SEARCH_YIELD_EVERY, SEARCH_ES_TIMEOUT_MS,
	GREP_ROW_CAP, GREP_FILE_CAP, GREP_LINE_CHARS, GREP_READ_BYTES, GREP_WALK_CAP,
	type FileWarn, type SearchToken, type AccessVerdict, type GrepScanOptions
} from './SdkFileAccess';
