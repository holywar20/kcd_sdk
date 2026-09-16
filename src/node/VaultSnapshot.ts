import * as fs from 'fs'
import * as path from 'path'
import { LensObject } from '../core'

/**
 * VaultSnapshot — one copy of a vault, kept aside so a destructive operation has an undo.
 *
 * ONE SLOT, DELIBERATELY. This is not version control and must not grow into it: a project gets a
 * single folder, the copy in it is overwritten by the next snapshot, and the only thing offered on
 * top of it is "put it back". The moment it holds a history it acquires a browser, a diff, a pruning
 * policy and a story about which generation you meant — which is git, and git already exists. A vault
 * that matters is usually IN a repository; this is the courtesy for the one that is not.
 *
 * `.git` IS NEVER TOUCHED, in either direction, and that single rule carries most of the safety here.
 * A vault is very often its own repository, and the repository is worth more than any copy this could
 * make of it — 48 MB of history against 11 MB of documents, in the case that prompted this. So a
 * snapshot does not copy it ( the payload would be five-sixths git objects for no gain ), and a clear
 * does not delete it. What that buys is better than the snapshot: on a versioned vault the real undo
 * is `git checkout .`, with every generation rather than one, and a reinstall lands back inside the
 * same repository so the change is a diff the owner can read.
 */

/** What is in a project's snapshot slot. `exists: false` is the answer for a project that has never
 *  run a destructive operation — the ordinary case, and not a failure. */
export interface SnapshotInfo {
	/** The slot's folder, whether or not anything is in it. */
	path:   string
	exists: boolean
	/** When the copy was taken, epoch milliseconds — 0 when there is none. Milliseconds rather than an ISO
	 *  string because that is the time currency every other stamp in this codebase already carries, and a
	 *  second spelling of "when" is a conversion at every reader. */
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

	/** What is in the slot, without reading the tree — the stamp carries the counts so a card can report
	 *  "taken yesterday, 398 files" without walking eleven megabytes to find out. */
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
	 * Copy the vault into the slot, replacing whatever was there.
	 *
	 * The old copy is destroyed BEFORE the new one is written, rather than merged over it, because a
	 * merge would leave files from two different vaults in one folder and call the result a snapshot.
	 * One slot means one moment in time.
	 *
	 * Returns the stamp it wrote. A vault that does not exist yields an empty slot rather than throwing:
	 * there was nothing to lose, which is a fine outcome for a backup.
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
	 * Put the copy back, replacing the vault's current contents.
	 *
	 * A restore CLEARS FIRST and then copies, which makes it a true return to the snapshot rather than a
	 * merge: a file created after the snapshot was taken is gone afterwards, which is the only reading of
	 * "put it back" that is not a lie. `.git` survives, as everywhere here.
	 *
	 * False when there is nothing to restore, or when the copy was taken from a different doc root — the
	 * bundled text is retargeted at the vault it was installed into, so dropping a `_Claude` snapshot into
	 * a `_kcd` vault would install a library of links to a folder that is not there.
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
	 * Empty the vault, keeping the folder and anything in `PRESERVE`.
	 *
	 * The FOLDER stays. A vault is an address other things hold — the doc root on the project row, an
	 * agent's lens path, a person's editor — and removing the directory itself would break those in a way
	 * that emptying it does not. What a person means by "remove the documentation" is that the documents
	 * are gone, not that the mount point is.
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
