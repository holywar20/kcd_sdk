/**
 * validate-canonical — sweep KcdValidate over every file in _Claude/kcd/ and report non-conforming ones.
 * Authored: 2026-07-19 · Species: diagnostic. DEV-ONLY — does not ship.
 * Run: cd kcd_sdk && npx tsx scripts/validate-canonical.ts
 */
import * as path from 'path';
import * as fs from 'fs';
import { KcdValidate } from '../src/core/html/KcdValidate';

const root = path.resolve( __dirname, '../..', '_Claude/kcd' );
const files: string[] = [];
const walk = ( d: string ): void => { for ( const e of fs.readdirSync( d, { withFileTypes: true } ) ) { const f = path.join( d, e.name ); if ( e.isDirectory() ) walk( f ); else if ( e.name.endsWith( '.html' ) ) files.push( f ); } };
walk( root );

let ok = 0; const bad: string[] = [];
for ( const f of files ) {
	const rep = KcdValidate.validate( fs.readFileSync( f, 'utf-8' ) );
	if ( rep.ok ) ok++;
	else bad.push( `${ path.relative( root, f ).replace( /\\/g, '/' ) }  —  ${ rep.errors[ 0 ]?.code } ${ rep.errors[ 0 ]?.msg }` );
}
console.log( `\nkcd/ validation:  ${ ok }/${ files.length } conform` );
if ( bad.length ) { console.log( `NON-CONFORMING (${ bad.length }):` ); for ( const b of bad ) console.log( '   ' + b ); }
else console.log( 'All canonical files conform. ✓' );
console.log();
