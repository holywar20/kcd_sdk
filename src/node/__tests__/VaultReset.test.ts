import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VaultDeploy } from '../VaultDeploy';
import { VaultSnapshot } from '../VaultSnapshot';
import { InstallManifest } from '../../core';

/**
 * RESET, REMOVE, AND THE ONE COPY THAT MAKES THEM OFFERABLE.
 *
 * A repair fills gaps and is safe by construction. A reset overwrites, and a remove deletes — both
 * reach real work, so what they must NOT reach is the thing worth proving here:
 *
 *   - a reset writes over a framework file that drifted, and leaves a file the project wrote itself
 *     alone even when it sits in the same folder as the ones being overwritten;
 *   - a clear empties the vault and never touches `.git`, because a vault is very often its own
 *     repository and that repository outweighs any copy this module could make of it;
 *   - a restore is a RETURN, not a merge — a file made after the snapshot is gone afterwards.
 */

const DOC_ROOT = '_Claude';

let root      = '';
let substrate = '';
let slot      = '';

const vault = ( ...parts: string[] ): string => join( root, DOC_ROOT, ...parts );

/** Canonical content, and the same file after somebody edited it. */
const SHIPPED = '<p>shipped</p>\n';
const EDITED  = '<p>shipped, then improved locally</p>\n';

beforeEach( () => {
	root      = mkdtempSync( join( tmpdir(), 'kcd-reset-root-' ) );
	substrate = mkdtempSync( join( tmpdir(), 'kcd-reset-sub-' ) );
	slot      = join( mkdtempSync( join( tmpdir(), 'kcd-reset-slot-' ) ), 'snapshot' );

	// A COMPLETE substrate, built from the manifest itself rather than a hand-listed few. Half a bundle
	// would make `missing` permanently non-zero and every assertion here relative to an arbitrary floor;
	// generating it from the table also means a row added later cannot quietly fall out of this fixture.
	for ( const entry of InstallManifest.all() ) {
		const at = join( substrate, entry.bundleSource );
		if ( entry.bundleSource.endsWith( '.html' ) || entry.bundleSource.endsWith( '.css' ) ) {
			mkdirSync( join( at, '..' ), { recursive: true } );
			writeFileSync( at, SHIPPED );
			continue;
		}
		mkdirSync( at, { recursive: true } );
		writeFileSync( join( at, 'shipped.html' ), SHIPPED );
	}

	VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate } );
} );

afterEach( () => {
	for ( const dir of [ root, substrate, join( slot, '..' ) ] ) rmSync( dir, { recursive: true, force: true } );
} );

describe( 'drift is measured without being acted on', () => {

	it( 'reports a complete vault as complete, and still counts what was edited', () => {
		writeFileSync( vault( 'habits', 'shipped.html' ), EDITED );

		const found = VaultDeploy.inspect( root, { docRoot: DOC_ROOT, substrateSource: substrate } );

		// THE POINT: nothing to repair, and something to reset. A vault can be whole and drifted at once,
		// so the two numbers cannot be folded into one.
		expect( found.missing ).toBe( 0 );
		expect( found.changed ).toBe( 1 );
		expect( readFileSync( vault( 'habits', 'shipped.html' ), 'utf-8' ) ).toBe( EDITED );
	} );

	it( 'counts a missing file as missing and NOT as changed', () => {
		rmSync( vault( 'habits', 'shipped.html' ) );

		const found = VaultDeploy.inspect( root, { docRoot: DOC_ROOT, substrateSource: substrate } );
		expect( found.missing ).toBeGreaterThan( 0 );
		expect( found.changed ).toBe( 0 );
	} );

} );

describe( 'reset overwrites the framework and nothing else', () => {

	it( 'leaves an edited file alone without force, and restores it with force', () => {
		writeFileSync( vault( 'habits', 'shipped.html' ), EDITED );
		writeFileSync( vault( 'root.html' ), EDITED );

		VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate } );
		expect( readFileSync( vault( 'habits', 'shipped.html' ), 'utf-8' ) ).toBe( EDITED );
		expect( readFileSync( vault( 'root.html' ), 'utf-8' ) ).toBe( EDITED );

		VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate, force: true } );
		expect( readFileSync( vault( 'habits', 'shipped.html' ), 'utf-8' ) ).toBe( SHIPPED );
		expect( readFileSync( vault( 'root.html' ), 'utf-8' ) ).toBe( SHIPPED );
	} );

	it( 'cannot reach a file the project wrote, even inside a framework folder', () => {
		const mine = vault( 'habits', 'my-own-habit.html' );
		writeFileSync( mine, '<p>mine</p>\n' );
		writeFileSync( vault( 'references', 'note.html' ), '<p>also mine</p>\n' );
		writeFileSync( vault( 'habits', 'shipped.html' ), EDITED );

		VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate, force: true } );

		// The overwrite landed, and the neighbour survived it. A reset is bounded by the manifest, which
		// is the whole reason it is safe enough to offer next to a repair.
		expect( readFileSync( vault( 'habits', 'shipped.html' ), 'utf-8' ) ).toBe( SHIPPED );
		expect( readFileSync( mine, 'utf-8' ) ).toBe( '<p>mine</p>\n' );
		expect( readFileSync( vault( 'references', 'note.html' ), 'utf-8' ) ).toBe( '<p>also mine</p>\n' );
	} );

	it( 'reports nothing left to reset once it has reset', () => {
		writeFileSync( vault( 'habits', 'shipped.html' ), EDITED );
		VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate, force: true } );

		expect( VaultDeploy.inspect( root, { docRoot: DOC_ROOT, substrateSource: substrate } ).changed ).toBe( 0 );
	} );

} );

describe( 'the snapshot slot', () => {

	it( 'is empty before anything has been taken', () => {
		expect( VaultSnapshot.read( slot ).exists ).toBe( false );
	} );

	it( 'copies the vault, skips .git, and puts it back', () => {
		mkdirSync( vault( '.git', 'objects' ), { recursive: true } );
		writeFileSync( vault( '.git', 'objects', 'pack' ), 'history' );
		writeFileSync( vault( 'references', 'note.html' ), '<p>mine</p>\n' );

		const taken = VaultSnapshot.take( root, slot, { docRoot: DOC_ROOT } );
		expect( taken.exists ).toBe( true );
		expect( taken.files ).toBeGreaterThan( 0 );
		expect( existsSync( join( slot, 'vault', '.git' ) ) ).toBe( false );

		// Break it thoroughly, then take it back.
		rmSync( vault( 'references', 'note.html' ) );
		writeFileSync( vault( 'habits', 'shipped.html' ), EDITED );

		expect( VaultSnapshot.restore( slot, root, { docRoot: DOC_ROOT } ) ).toBe( true );
		expect( readFileSync( vault( 'references', 'note.html' ), 'utf-8' ) ).toBe( '<p>mine</p>\n' );
		expect( readFileSync( vault( 'habits', 'shipped.html' ), 'utf-8' ) ).toBe( SHIPPED );
	} );

	it( 'restores by RETURNING, so a file made after the snapshot is gone', () => {
		VaultSnapshot.take( root, slot, { docRoot: DOC_ROOT } );
		writeFileSync( vault( 'references', 'later.html' ), '<p>after</p>\n' );

		VaultSnapshot.restore( slot, root, { docRoot: DOC_ROOT } );
		expect( existsSync( vault( 'references', 'later.html' ) ) ).toBe( false );
	} );

	it( 'refuses to restore a copy taken from a different doc root', () => {
		VaultSnapshot.take( root, slot, { docRoot: DOC_ROOT } );
		expect( VaultSnapshot.restore( slot, root, { docRoot: '_kcd' } ) ).toBe( false );
	} );

	it( 'overwrites the one slot rather than accumulating copies', () => {
		VaultSnapshot.take( root, slot, { docRoot: DOC_ROOT } );
		writeFileSync( vault( 'references', 'second.html' ), '<p>second</p>\n' );
		VaultSnapshot.take( root, slot, { docRoot: DOC_ROOT } );

		// The second take replaced the first WHOLE — the new file is in, and there is still one copy.
		expect( existsSync( join( slot, 'vault', 'references', 'second.html' ) ) ).toBe( true );
		rmSync( vault( 'references', 'second.html' ) );
		VaultSnapshot.restore( slot, root, { docRoot: DOC_ROOT } );
		expect( existsSync( vault( 'references', 'second.html' ) ) ).toBe( true );
	} );

} );

describe( 'clearing a vault', () => {

	it( 'empties it, keeps the folder, and never touches .git', () => {
		mkdirSync( vault( '.git', 'objects' ), { recursive: true } );
		writeFileSync( vault( '.git', 'objects', 'pack' ), 'history' );
		writeFileSync( vault( 'references', 'note.html' ), '<p>mine</p>\n' );

		VaultSnapshot.clear( root, { docRoot: DOC_ROOT } );

		// The repository is the better undo, so it is the one thing a removal is not allowed to take.
		expect( existsSync( vault( '.git', 'objects', 'pack' ) ) ).toBe( true );
		expect( existsSync( vault() ) ).toBe( true );
		expect( existsSync( vault( 'references' ) ) ).toBe( false );
		expect( existsSync( vault( 'root.html' ) ) ).toBe( false );
	} );

	it( 'leaves a vault a fresh deploy can land in', () => {
		VaultSnapshot.clear( root, { docRoot: DOC_ROOT } );
		const done = VaultDeploy.apply( root, { docRoot: DOC_ROOT, substrateSource: substrate } );

		expect( done.missing ).toBeGreaterThan( 0 );
		expect( readFileSync( vault( 'root.html' ), 'utf-8' ) ).toBe( SHIPPED );
		expect( VaultDeploy.inspect( root, { docRoot: DOC_ROOT, substrateSource: substrate } ).missing ).toBe( 0 );
	} );

} );
