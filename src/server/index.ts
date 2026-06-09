/**
 * Server-building patterns. kcd_sdk's second role (alongside the KCD primitives):
 * the shared base every internal MCP server is built from. Dependency-free — Node
 * builtins only — so servers and the Starmind main process both consume it.
 */
export { McpServer } from './McpServer';
export type { ToolDefinition, ToolResult, ContentBlock, ServerInfo } from './McpServer';

export { StarmindServer } from './StarmindServer';
export type { ServerManifest } from './manifest';
export type { TestSpec, Assertion, VerifyReport } from './verify';
