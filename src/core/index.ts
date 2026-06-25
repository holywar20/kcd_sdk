/**
 * The Node-free core surface. Everything here runs in BOTH the Electron main process
 * and the renderer (browser) — no `fs`, no `path` calls at module load, no scanner, no
 * server. The renderer imports from here (`@kcd/core`); main gets it too, via `@kcd`
 * (the node barrel re-exports core).
 *
 * Disk I/O is NOT here by design — it's an injected capability (see LensObject's `read`
 * strategy) supplied on the main side from `../node`. A behavior-bearing object crosses
 * the IPC bridge as `serialize()` JSON and is rebuilt with `fromSerialized()` on the far
 * side; capabilities are attached at the receiving facade, never imported into the object.
 */
export * from '../primitives';
export * from '../agent';
export * from '../constellation';
export * from './FileTypes';
export * from './TextTypes';
export * from './Glob';
