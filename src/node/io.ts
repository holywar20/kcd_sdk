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
 * Walk up from a start path to the nearest directory holding a `package.json` — "which package am I
 * part of?".
 *
 * The companion to `inferProjectRoot` above, and the answer to a different question: that one finds the
 * WORKSPACE by its vault, this one finds the PACKAGE by its manifest. Reach for this whenever code needs
 * a path inside its own project, because the alternative is counting directories up and naming a folder
 * on the way back down — an assertion about the tree's shape that nothing checks and that a differently
 * named checkout silently invalidates.
 *
 * Throws rather than falling back. A guessed root can name a directory that exists but belongs to someone
 * else, and writing to the wrong tree while reporting success is worse than not starting.
 */
export function findPackageRoot( startPath: string ): string {
	let dir = path.resolve( startPath );
	while ( true ) {
		if ( fs.existsSync( path.join( dir, 'package.json' ) ) ) return dir;
		const parent = path.dirname( dir );
		if ( parent === dir ) throw new Error( `Could not find a package root above "${ startPath }" — no ancestor contains a package.json` );
		dir = parent;
	}
}

/**
 * Dredge a lens from disk with the real fs reader injected — the node-side convenience so
 * main never hand-wires `fs` into LensObject.load. projectRoot is inferred if not given.
 */
export function loadLensFromDisk( lensPath: string, opts?: { projectRoot?: string; depth?: number; eager?: boolean } ): LensObject {
	const projectRoot = opts?.projectRoot ?? inferProjectRoot( lensPath );
	return LensObject.load( lensPath, { projectRoot, depth: opts?.depth, eager: opts?.eager, read: fsReader } );
}
