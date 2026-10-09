/**
 * The Node-free core surface, run by both Electron main and the renderer: no `fs`, no `path` at module load,
 * no scanner, no server. The renderer imports it as `@kcd/core`; main gets it through `@kcd`.
 * Disk I/O is injected (see LensObject's `read`), supplied from `../node`. A behavior-bearing object crosses
 * the IPC bridge as `serialize()` JSON and is rebuilt by `fromSerialized()`; capabilities attach at the
 * receiving facade, never inside the object.
 */
export * from '../primitives';
export * from '../agent';
export * from '../session';
export * from '../constellation';
export * from './Assert';
export * from './Keystone';
export * from './Command';
export * from './AccessPolicy';
export * from './VaultLayout';
export * from './InstallManifest';
export * from './FileTypes';
export * from './TextTypes';
export * from './Glob';
export * from './PathText';
export * from './Blacklist';
export * from './Noise';
export * from './NameMatch';
export * from './EsCsv';
export * from './html';
