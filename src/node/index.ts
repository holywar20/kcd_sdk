/**
 * The main-process barrel — the full SDK surface. Re-exports the Node-free core, plus the
 * Node-only layers: the scanner, the server-building patterns, and the disk I/O helpers.
 * `@kcd` resolves here. The renderer must NOT import this barrel — only `@kcd/core`.
 */
export * from '../core';
export * from '../scanner';
export * from '../server';
export { fsReader, inferProjectRoot, loadLensFromDisk } from './io';
