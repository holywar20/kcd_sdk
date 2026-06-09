import * as fs from 'fs';
import * as path from 'path';
import { LensObject } from '../core';
import type { ReaderFn } from '../core';

/**
 * Node-side I/O — the disk capabilities the Node-free core deliberately omits. Main
 * injects these into core objects; the renderer never imports this module.
 */

/** The real disk reader injected into a LensObject before it dredges (main side only). */
export const fsReader: ReaderFn = ( absPath ) => fs.readFileSync( absPath, 'utf-8' );

/**
 * Walk up from a start path until an ancestor contains the doc root. Disk discovery, so
 * it lives node-side (it was a LensObject static; moved here when core lost `fs`).
 */
export function inferProjectRoot( startPath: string, docRoot = LensObject.DEFAULT_DOC_ROOT ): string {
	let dir = path.dirname( path.resolve( startPath ) );
	while ( true ) {
		if ( fs.existsSync( path.join( dir, docRoot ) ) ) return dir;
		const parent = path.dirname( dir );
		if ( parent === dir ) break;
		dir = parent;
	}
	throw new Error( `Could not infer projectRoot from "${ startPath }" — no ancestor contains "${ docRoot }"` );
}

/**
 * Dredge a lens from disk with the real fs reader injected — the node-side convenience so
 * main never hand-wires `fs` into LensObject.load. projectRoot is inferred if not given.
 */
export function loadLensFromDisk( lensPath: string, opts?: { projectRoot?: string; depth?: number } ): LensObject {
	const projectRoot = opts?.projectRoot ?? inferProjectRoot( lensPath );
	return LensObject.load( lensPath, { projectRoot, depth: opts?.depth, read: fsReader } );
}
