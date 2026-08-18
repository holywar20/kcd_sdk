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
	type SeedBlock, type SeedApplyReport, type LensIndexRow, type LensIndexReport,
	type MigrationActionKind, type MigrationAction, type MigrationPlan, type MigrationApplyReport,
	type StylesheetFixReport,
} from './VaultUtilities';
export { VaultDeploy, type DeployReport, type DeployItem, type DeployItemKind } from './VaultDeploy';
export {
	Survey,
	type SurveyReport, type SurveyComponent, type ComponentKind,
	type SurveyLanguage, type SurveyEntryPoint, type SurveyTests,
} from './Survey';
export {
	SdkFileAccess, LIST_CAP, READ_CAP_BYTES, GLOB_CAP, GLOB_WALK_CAP,
	SEARCH_MATCH_CAP, SEARCH_WALK_CAP, SEARCH_YIELD_EVERY, SEARCH_ES_TIMEOUT_MS,
	type FileWarn, type SearchToken, type AccessVerdict
} from './SdkFileAccess';
