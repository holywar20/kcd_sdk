import * as fs from 'fs'
import * as path from 'path'
import { LensObject } from '../core'

/**
 * VaultSnapshot — one copy of a vault, kept aside so a destructive operation has an undo.
 * ONE SLOT, DELIBERATELY: this is not version control and must not grow into it — that is git.
 * `.git` IS NEVER TOUCHED, in either direction; that single rule carries most of the safety here.
 */

/** What is in a project's snapshot slot. `exists: false` is the answer for a project that has never
 *  run a destructive operation — the ordinary case, and not a failure. */
export interface SnapshotInfo {
	/** The slot's folder, whether or not anything is in it. */
	path:   string
	exists: boolean
	/** When the copy was taken, epoch milliseconds — 0 when there is none. Milliseconds, like every
	 *  other stamp in the codebase. */
	taken:  number
	/** The doc root the copy was taken from — a vault restored into a differently-named folder would be
	 *  a vault full of links to the wrong place, so a restore checks this rather than assuming. */
	docRoot: string
	files:  number
	bytes:  number
}

/** Never copied out of a vault, never deleted from one. See the class note — this list is the safety. */
const PRESERVE = [ '.git' ]

/** The copied tree and the stamp sit side by side inside the slot, so the stamp can never collide with
 *  a file that happened to be in the vault under the same name. */
const TREE  = 'vault'
const STAMP = 'snapshot.json'

export class VaultSnapshot {

	/** What is in the slot, without reading the tree: the stamp carries the counts, so nothing walks the copy. */
	static read( slot: string ): SnapshotInfo {
		const empty: SnapshotInfo = { path: slot, exists: false, taken: 0, docRoot: '', files: 0, bytes: 0 }
		const stamp = path.join( slot, STAMP )
		if( !fs.existsSync( stamp ) || !fs.existsSync( path.join( slot, TREE ) ) ) return empty
		try {
			const held = JSON.parse( fs.readFileSync( stamp, 'utf-8' ) ) as Partial<SnapshotInfo>
			return {
				path:    slot,
				exists:  true,
				taken:   Number( held.taken ?? 0 ),
				docRoot: String( held.docRoot ?? LensObject.DEFAULT_DOC_ROOT ),
				files:   Number( held.files ?? 0 ),
				bytes:   Number( held.bytes ?? 0 )
			}
		} catch {
			// A stamp we cannot read is a slot we cannot honestly offer to restore from.
			return empty
		}
	}

	/**
	 * Copy the vault into the slot, replacing whatever was there. The old copy is destroyed BEFORE the new
	 * one is written, never merged: a merge would leave two vaults' files in one folder.
	 */
	static take( projectRoot: string, slot: string, opts?: { docRoot?: string } ): SnapshotInfo {
		const docRoot = opts?.docRoot || LensObject.DEFAULT_DOC_ROOT
		const vault   = path.resolve( projectRoot, docRoot )

		fs.rmSync( slot, { recursive: true, force: true } )
		if( !fs.existsSync( vault ) ) return VaultSnapshot.read( slot )

		const tree  = path.join( slot, TREE )
		fs.mkdirSync( tree, { recursive: true } )
		const count = VaultSnapshot._copy( vault, tree )

		const info: SnapshotInfo = {
			path:    slot,
			exists:  true,
			taken:   Date.now(),
			docRoot,
			files:   count.files,
			bytes:   count.bytes
		}
		fs.writeFileSync( path.join( slot, STAMP ), JSON.stringify( info, null, '\t' ), 'utf-8' )
		return info
	}

	/**
	 * Puts the copy back over the vault, after clearing it so nothing created since the snapshot survives.
	 * False when there is nothing to restore or the doc root differs: a `_Claude` copy in a `_kcd` vault would be dead links.
	 */
	static restore( slot: string, projectRoot: string, opts?: { docRoot?: string } ): boolean {
		const docRoot = opts?.docRoot || LensObject.DEFAULT_DOC_ROOT
		const info    = VaultSnapshot.read( slot )
		if( !info.exists ) return false
		if( info.docRoot !== docRoot ) return false

		const vault = path.resolve( projectRoot, docRoot )
		VaultSnapshot.clear( projectRoot, { docRoot } )
		fs.mkdirSync( vault, { recursive: true } )
		VaultSnapshot._copy( path.join( slot, TREE ), vault )
		return true
	}

	/**
	 * Empty the vault, keeping the folder and anything in `PRESERVE`. The folder stays because a vault is an
	 * address other things hold — the project row, an agent's lens path, a person's editor.
	 */
	static clear( projectRoot: string, opts?: { docRoot?: string } ): number {
		const docRoot = opts?.docRoot || LensObject.DEFAULT_DOC_ROOT
		const vault   = path.resolve( projectRoot, docRoot )
		if( !fs.existsSync( vault ) ) return 0

		let gone = 0
		for( const entry of fs.readdirSync( vault, { withFileTypes: true } ) ) {
			if( PRESERVE.includes( entry.name ) ) continue
			fs.rmSync( path.join( vault, entry.name ), { recursive: true, force: true } )
			gone++
		}
		return gone
	}

	/** A plain recursive byte copy — no retargeting, because a snapshot restores what WAS there rather
	 *  than what a fresh install would write. Returns what it moved, for the stamp. */
	private static _copy( from: string, to: string ): { files: number; bytes: number } {
		let files = 0
		let bytes = 0
		fs.mkdirSync( to, { recursive: true } )

		for( const entry of fs.readdirSync( from, { withFileTypes: true } ) ) {
			if( PRESERVE.includes( entry.name ) ) continue
			const src = path.join( from, entry.name )
			const dst = path.join( to, entry.name )

			if( entry.isDirectory() ) {
				const under = VaultSnapshot._copy( src, dst )
				files += under.files
				bytes += under.bytes
				continue
			}
			fs.copyFileSync( src, dst )
			files++
			bytes += fs.statSync( dst ).size
		}
		return { files, bytes }
	}

}
