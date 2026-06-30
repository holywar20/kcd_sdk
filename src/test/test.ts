#!/usr/bin/env node
'use strict';

const path = require( 'path' );

// Paths relative to compiled dist/test/ — walking up three levels lands at the
// ContextManager project root, where _Claude lives.
const PROJECT_ROOT  = path.resolve( __dirname, '../../..' );
const LENS_DIR      = path.join( PROJECT_ROOT, '_Claude/lenses/parser' );
const LENS_FILE     = path.join( LENS_DIR, 'parser.html' );

const { scan, loadLensFromDisk } = require( '../../dist/index.js' );

// ── Scanner smoke test ───────────────────────────────────────────────────────

console.log( '\n=== scan() ===\n' );
const scanned = scan( LENS_DIR );
console.log( `Files found: ${scanned.length}` );
scanned.forEach( f => console.log( ' -', f.relativePath ) );

// ── LensObject.load() smoke test ─────────────────────────────────────────────

console.log( '\n=== loadLensFromDisk() ===\n' );
const lens = loadLensFromDisk( LENS_FILE );
console.log( 'type        :', lens.getType() );
console.log( 'path        :', lens.getPath() );
console.log( 'nodes loaded:', lens.getNodes().length );
console.log( 'policy      :' );
lens.getPolicy().forEach( e => {
	console.log( `  [${e.always ? 'always' : 'cond  '}]  ${e.what}  →  ${e.href}` );
} );

console.log( '\n=== serializeForContext() (first 500 chars) ===\n' );
console.log( lens.serializeForContext().slice( 0, 500 ) );
