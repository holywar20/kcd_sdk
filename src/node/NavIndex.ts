import * as fs from 'fs'
import * as path from 'path'
import { Vault } from './Vault'
import { HtmlTree, KcdEmit, KcdValidate, VaultLayout } from '../core'
import type { SerializedArtifact } from '../primitives'

/**
 * NavIndex — every folder `nav-index.html` is DERIVED from the documents under it, never kept by hand.
 *
 * A hand-kept index is a second copy of every document's name and description, and a second copy drifts:
 * a move healed its href and a delete removed its row, but nothing added a row when a document was born
 * and nothing touched one when a description changed. Measured before this existed: two ACTIVE plans
 * missing from the registry the plan contract calls "the registry of every plan", a whole habit class
 * missing from the habit index, and tombstones the source documents had already shed still standing in
 * the catalog. Deriving the index deletes the copy, and with it every way for the two to disagree.
 *
 * MECHANICAL, and it judges nothing. A row is what the document says about itself:
 *   • what  — its `<h1>`, falling back to its `name`
 *   • where — its path
 *   • why   — the LEAD of its `description`: the first sentence, cut back to its first clause when it runs
 *             past `WHY_MAX`. The index-format habit asks for one phrase, and this is also the pressure
 *             that makes a description open with its purpose
 *   • lens  — a fourth column, only when some document in the index declares one ( plans do )
 * grouped into sections by `status`, and within a section by category folder — the first folder below
 * the index, because the folder IS the category.
 *
 * WHAT IS A DOCUMENT is a head read, not a parse: an `.html` file carrying `<article data-kcd="…">` and a
 * frontmatter `<dl>` with a `name`. Anything else — a stray page, a half-written file, a text dump with
 * the wrong extension — is ignored rather than refused, because an index is not the place to grade a
 * vault; `health` is. A bundle ( `x/x.html` ) is one document: its main file is indexed and everything
 * else under that folder belongs to it — unless that main file declares a `habit-class`, because a habit
 * class folder holds its poles side by side and a pole may share the class's name. The pole says what it
 * is, so the folder is a category.
 *
 * DRAFTS. A directory whose layout row declares `drafts` ( `plans` → `work/{lens}/plans` ) also lists what is
 * being drafted for it, in a section of its own and grouped by lens. Those rows are ADDRESSES, never links —
 * a draft lives in ephemeral space and authorizes nothing — and a write to a draft rebuilds the index it is
 * drafted for.
 *
 * WHAT IT NEVER TOUCHES: the vault ROOT index, which deploy writes once as a map the project grows and
 * is deliberately not generated ( see `VaultDeploy._navIndex` ), and any index in ephemeral space —
 * `work/` holds indexes that are somebody's scratch.
 *
 * THE COST IS BOUNDED THREE WAYS, because a vault is not always kept tidy:
 *   • SCOPE — a write rebuilds only the indexes in its own ancestor folders, never the vault.
 *   • READ  — each candidate costs a head read of a few KB ( to the end of its `<h1>` ), never the whole
 *             file; a non-`.html` file costs nothing past the directory listing.
 *   • CAP   — an index over `CAP` candidate files is left as it stands and the write says so, rather than
 *             stalling every save in a vault somebody filled with ten thousand pages.
 * NOTHING CACHES, matching `VaultTools`: every rebuild reads what is on disk, so a document edited by any
 * other means — a script, a plain file tool, another process — is picked up by the next write.
 *
 * WRITE-IF-CHANGED. The rebuilt index is compared with the file on disk before `updated` is stamped, so
 * a write that changes nothing an index shows leaves the index's bytes and mtime alone.
 *
 * A BATCH REBUILDS ONCE. `defer` / `flush` hold the rebuild for the length of a batch, keyed by VAULT
 * rather than by caller — Starmind builds a fresh `VaultTools` per call, so a flag on one instance would
 * never be seen by the siblings the batch dispatches. The price, stated: a write that lands on the same
 * vault DURING someone else's batch has its index rebuilt when that batch ends, not before.
 */

/** One indexed document, as its own head describes it. */
export interface NavIndexEntry {
	/** Vault-relative, forward slashes. */
	rel:    string
	type:   string
	what:   string
	why:    string
	status: string
	lens:   string[]
	/** The category folder it files under — the first folder below the index, or '' at the top. */
	group?: string
	/** Found in the directory's declared drafts location, not under the directory itself. */
	draft?: boolean
}

/** What one refresh did. Paths are vault-relative. */
export interface NavIndexResult {
	written: string[]
	skipped: Array<{ path: string; reason: string }>
}

/** Sections in this order; any status not named here sorts alphabetically after `paused`. */
const STATUS_ORDER = [ 'active', 'draft', 'paused', '*', 'complete', 'retired', 'disabled' ]

/** The named entities a description actually carries, decoded for display; any other passes through untouched. */
const NAMED: Record<string, string> = {
	mdash: '—', ndash: '–', middot: '·', rarr: '→', larr: '←', hellip: '…', nbsp: ' ',
	lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', times: '×', bull: '•',
}

/** Folders a walk never enters — a vault is not always kept tidy, and neither of these is ever a document. */
const SKIP_DIRS = new Set( [ 'node_modules', '.git' ] )

export class NavIndex {

	/** Above this many candidate `.html` files under one index, the index is not rebuilt on a write. */
	static readonly CAP = 5000

	/** A why cell longer than this is cut back to its first clause, or at a word with an ellipsis. */
	static readonly WHY_MAX = 160

	/** First read of a head; grown to `HEAD_MAX` only when the frontmatter has not closed inside it. */
	static readonly HEAD_BYTES = 8192
	static readonly HEAD_MAX   = 65536

	/** Batch deferral, per vault root. */
	private static readonly held    = new Map<string, number>()
	private static readonly pending = new Map<string, Set<string>>()

	/** `cap` is `CAP` unless a caller ( a test ) needs the ceiling somewhere it can reach. */
	constructor( private readonly vault: Vault, private readonly cssVaultRel?: string, private readonly cap: number = NavIndex.CAP ) {}

	// ── Batch deferral ────────────────────────────────────────────────────────

	/** Hold rebuilds on this vault until the matching `flush`. Nests. */
	defer(): void {
		const root = this.vault.root
		NavIndex.held.set( root, ( NavIndex.held.get( root ) ?? 0 ) + 1 )
	}

	/** Release one hold; the last release rebuilds everything the held writes reached, once. */
	flush(): NavIndexResult {
		const root  = this.vault.root
		const depth = ( NavIndex.held.get( root ) ?? 1 ) - 1
		if ( depth > 0 ) { NavIndex.held.set( root, depth ); return { written: [], skipped: [] } }

		NavIndex.held.delete( root )
		const paths = [ ...( NavIndex.pending.get( root ) ?? [] ) ]
		NavIndex.pending.delete( root )
		return this.refresh( paths )
	}

	// ── Rebuild ───────────────────────────────────────────────────────────────

	/**
	 * Rebuild every index these absolute paths reach — or, inside a batch, remember them for `flush`.
	 * Never throws: a rebuild that fails is reported as skipped, because the write that caused it has
	 * already landed and an index is not worth losing it over.
	 */
	refresh( absPaths: string[] ): NavIndexResult {
		const root = this.vault.root
		if ( NavIndex.held.has( root ) ) {
			const set = NavIndex.pending.get( root ) ?? new Set<string>()
			for ( const p of absPaths ) set.add( p )
			NavIndex.pending.set( root, set )
			return { written: [], skipped: [] }
		}

		const out: NavIndexResult = { written: [], skipped: [] }
		for ( const index of this.affected( absPaths ) ) {
			try {
				const r = this.rebuild( index )
				if ( r === 'written' ) out.written.push( index )
				else if ( r !== 'unchanged' ) out.skipped.push( { path: index, reason: r.skipped } )
			} catch ( e ) {
				out.skipped.push( { path: index, reason: e instanceof Error ? e.message : String( e ) } )
			}
		}
		return out
	}

	/**
	 * The folder indexes a change to these paths reaches: every `nav-index.html` in an ancestor folder of
	 * each path, nearest first. Never the vault root's own, and never one in ephemeral space.
	 */
	affected( absPaths: string[] ): string[] {
		const ephemeral = new Set( VaultLayout.ephemeralDirs() )
		const found     = new Set<string>()

		for ( const abs of absPaths ) {
			const rel = path.relative( this.vault.root, abs ).split( path.sep ).join( '/' )
			if ( !rel || rel.startsWith( '..' ) || path.isAbsolute( rel ) ) continue

			for ( const entry of VaultLayout.all() ) {
				if ( !entry.drafts || !NavIndex.underGlob( rel, entry.drafts ) ) continue
				const index = `${ entry.dir }/${ VaultLayout.NAV_INDEX_FILE }`
				if ( fs.existsSync( path.join( this.vault.root, index ) ) ) found.add( index )
			}
			if ( ephemeral.has( rel.split( '/' )[ 0 ] ) ) continue

			for ( let dir = path.posix.dirname( rel ); dir !== '.' && dir !== ''; dir = path.posix.dirname( dir ) ) {
				const index = `${ dir }/${ VaultLayout.NAV_INDEX_FILE }`
				if ( fs.existsSync( path.join( this.vault.root, index ) ) ) found.add( index )
			}
		}
		return [ ...found ]
	}

	/** Rebuild one index from the documents under its folder. */
	rebuild( indexRel: string ): 'written' | 'unchanged' | { skipped: string } {
		const dir     = path.posix.dirname( indexRel )
		const indexAbs = path.join( this.vault.root, indexRel )

		const files     = this.candidates( dir )
		const draftGlob = VaultLayout.all().find( e => e.dir === dir )?.drafts
		const drafts    = draftGlob ? this.expandGlob( draftGlob ).map( d => ( { dir: d, files: this.candidates( d ) } ) ) : []
		const total     = files.length + drafts.reduce( ( n, d ) => n + d.files.length, 0 )
		if ( total > this.cap )
			return { skipped: `${ total } files under ${ dir }/${ draftGlob ? ` and ${ draftGlob }/` : '' } exceeds the index cap of ${ this.cap } — left as it stood` }

		const isBundle = this.bundleTest( dir, files )
		const entries: NavIndexEntry[] = []
		for ( const rel of this.documents( dir, files, isBundle ) ) {
			const entry = this.entryFor( rel )
			if ( entry ) entries.push( { ...entry, group: this.groupOf( dir, rel, isBundle ) } )
		}
		for ( const d of drafts ) {
			for ( const rel of this.documents( d.dir, d.files ) ) {
				const entry = this.entryFor( rel )
				if ( entry ) entries.push( { ...entry, draft: true, group: NavIndex.globMatch( rel, draftGlob! ) } )
			}
		}

		const own      = this.ownFrontmatter( indexAbs )
		const today    = NavIndex.today()
		const artifact = ( updated: string ): SerializedArtifact => ( {
			path:        indexRel,
			type:        'nav-index',
			frontmatter: {
				name:             own.name || dir.split( '/' ).pop() || dir,
				description:      own.description,
				type:             'nav-index',
				status:           own.status || 'active',
				'schema-version': own[ 'schema-version' ],
				author:           own.author,
				updated,
			},
			sections: {},
			body:     this.body( dir, own.description, entries ),
			links:    [],
		} )

		const css      = KcdEmit.cssHrefFor( indexRel, this.cssVaultRel )
		const existing = fs.existsSync( indexAbs ) ? fs.readFileSync( indexAbs, 'utf8' ).replace( /\r\n/g, '\n' ) : ''
		if ( own.updated && KcdEmit.emit( artifact( own.updated ), css ) === existing ) return 'unchanged'

		const html   = KcdEmit.emit( artifact( today ), css )
		const report = KcdValidate.validate( html, { path: indexRel, docRoot: this.vault.docRoot } )
		if ( !report.ok )
			return { skipped: 'the rebuilt index failed validation — ' + report.errors.map( e => `${ e.code } @ ${ e.where }: ${ e.msg }` ).join( '; ' ) }

		fs.writeFileSync( indexAbs, html, 'utf8' )
		return 'written'
	}

	// ── Reading documents ─────────────────────────────────────────────────────

	/** Every `.html` file under `dir`, vault-relative, other indexes excluded. Opens nothing. */
	candidates( dir: string ): string[] {
		const out: string[] = []
		const walk = ( rel: string ): void => {
			let kids: fs.Dirent[]
			try { kids = fs.readdirSync( path.join( this.vault.root, rel ), { withFileTypes: true } ) } catch { return }
			for ( const kid of kids ) {
				const child = `${ rel }/${ kid.name }`
				if ( kid.isDirectory() ) {
					if ( !SKIP_DIRS.has( kid.name ) && !kid.name.startsWith( '.' ) ) walk( child )
				} else if ( kid.isFile() && kid.name.toLowerCase().endsWith( '.html' ) && kid.name !== VaultLayout.NAV_INDEX_FILE ) {
					out.push( child )
				}
			}
		}
		walk( dir )
		return out.sort()
	}

	/**
	 * The candidates that are documents in their own right. A bundle — a folder `b/` holding `b/b.html` — is
	 * ONE document: its main file stands for it, and everything else under the folder belongs to it. The
	 * index's own folder is never treated as a bundle.
	 */
	documents( dir: string, files: string[], isBundle: ( folder: string ) => boolean = this.bundleTest( dir, files ) ): string[] {
		return files.filter( rel => {
			for ( let folder = path.posix.dirname( rel ); folder !== dir && folder.startsWith( dir + '/' ); folder = path.posix.dirname( folder ) ) {
				if ( isBundle( folder ) && rel !== `${ folder }/${ path.posix.basename( folder ) }.html` ) return false
			}
			return true
		} )
	}

	/**
	 * Is this folder a bundle — does it hold `folder/folder.html`, and is that file a bundle's main rather than
	 * one pole of a habit class? Memoized for one rebuild: every file under a folder asks about it.
	 */
	bundleTest( dir: string, files: string[] ): ( folder: string ) => boolean {
		const present = new Set( files )
		const known   = new Map<string, boolean>()
		return ( folder: string ): boolean => {
			const hit = known.get( folder )
			if ( hit !== undefined ) return hit
			const main = `${ folder }/${ path.posix.basename( folder ) }.html`
			let bundle = folder !== dir && present.has( main )
			if ( bundle ) {
				const head = this.head( path.join( this.vault.root, main ) )
				if ( head && this.frontmatter( head )[ 'habit-class' ] ) bundle = false
			}
			known.set( folder, bundle )
			return bundle
		}
	}

	/** A document's row, read from its head — or null when the file is not a KCD document. */
	entryFor( rel: string ): NavIndexEntry | null {
		const head = this.head( path.join( this.vault.root, rel ) )
		if ( !head ) return null

		const type = /<article\b[^>]*\bdata-kcd="([a-z-]+)"/.exec( head )?.[ 1 ]
		if ( !type || type === 'nav-index' ) return null

		const fm = this.frontmatter( head )
		if ( !fm.name ) return null

		const h1   = /<\/dl>\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec( head )?.[ 1 ]
		const what = h1 ? NavIndex.plain( h1 ) : ''

		return {
			rel,
			type,
			what:   what || fm.name,
			why:    NavIndex.lead( fm.description ?? '' ),
			status: fm.status ?? '',
			lens:   fm.lens ?? [],
		}
	}

	/**
	 * The front of a file — through the end of its `<h1>` when one follows the frontmatter, else through
	 * `</dl>`. Null when there is no frontmatter inside `HEAD_MAX`, which is also how a non-document is
	 * turned away without reading it whole.
	 */
	head( abs: string ): string | null {
		let fd: number
		try { fd = fs.openSync( abs, 'r' ) } catch { return null }
		try {
			let size = NavIndex.HEAD_BYTES
			for ( ;; ) {
				const buf  = Buffer.alloc( size )
				const n    = fs.readSync( fd, buf, 0, size, 0 )
				const text = buf.toString( 'utf8', 0, n )
				const dl   = text.indexOf( '</dl>' )
				if ( dl >= 0 ) {
					const h1 = text.indexOf( '</h1>', dl )
					return text.slice( 0, h1 >= 0 ? h1 + 5 : dl + 5 )
				}
				if ( n < size || size >= NavIndex.HEAD_MAX ) return null
				size = Math.min( size * 4, NavIndex.HEAD_MAX )
			}
		} finally {
			fs.closeSync( fd )
		}
	}

	/** The frontmatter fields an index uses, from a head. A list field ( `lens` ) comes back as its chips. */
	frontmatter( head: string ): { name?: string; description?: string; status?: string; lens?: string[]; author?: string; updated?: string; 'schema-version'?: string; 'habit-class'?: string } {
		const start = head.indexOf( '<dl' )
		const end   = head.indexOf( '</dl>' )
		if ( start < 0 || end < start ) return {}

		const dl  = HtmlTree.parse( head.slice( start, end + 5 ) )
		const out: Record<string, unknown> = {}
		for ( const dd of HtmlTree.collect( dl, el => el.tag === 'dd' && typeof el.attrs[ 'data-kcd-field' ] === 'string' ) ) {
			const key = dd.attrs[ 'data-kcd-field' ]
			if ( dd.attrs[ 'data-kcd-type' ] === 'list' ) {
				out[ key ] = HtmlTree.collect( dd, el => el.tag === 'li' ).map( li => NavIndex.text( HtmlTree.textOf( li ) ) ).filter( Boolean )
			} else {
				out[ key ] = NavIndex.text( HtmlTree.textOf( dd ) )
			}
		}
		return out
	}

	/** The index's own identity, kept across rebuilds — the one hand-authored thing in a generated index. */
	private ownFrontmatter( indexAbs: string ): ReturnType<NavIndex[ 'frontmatter' ]> {
		const head = fs.existsSync( indexAbs ) ? this.head( indexAbs ) : null
		return head ? this.frontmatter( head ) : {}
	}

	// ── Emitting ──────────────────────────────────────────────────────────────

	/**
	 * The article body: title, the index's own description, the generated notice, then one section per status
	 * — with the drafts section, when there is one, directly after `active`.
	 */
	body( dir: string, description: string | undefined, entries: NavIndexEntry[] ): string {
		const esc      = ( s: string ) => HtmlTree.escapeText( s )
		const docRoot  = this.vault.docRoot
		const withLens = entries.some( e => e.lens.length > 0 )
		const label    = dir.split( '/' ).pop() || dir

		const parts: string[] = [ `<h1>${ esc( label ) } — Nav index</h1>` ]
		if ( description ) parts.push( `<p>${ esc( description ) }</p>` )
		parts.push(
			`<p><em>Generated from the documents under <code>${ esc( `${ docRoot }/${ dir }/` ) }</code> on every write, `
			+ `so an edit to a row here is overwritten. To change a row, change the document — its heading, its status, `
			+ `or the first sentence of its description.</em></p>`
		)

		const row = ( e: NavIndexEntry ): string => {
			const stem  = esc( path.posix.basename( e.rel, '.html' ) )
			const where = e.draft
				? `<code data-kcd-field="where" data-kcd-type="address" data-kcd-address="${ HtmlTree.escapeAttr( `${ docRoot }/${ e.rel }` ) }">${ stem }</code>`
				: `<a data-kcd-field="where" data-kcd-type="path" href="${ HtmlTree.escapeAttr( `${ docRoot }/${ e.rel }` ) }">${ stem }</a>`
			return '<div data-kcd-slot="link">'
				+ `<span data-kcd-field="what" data-kcd-type="text">${ esc( e.what ) }</span>`
				+ where
				+ `<span data-kcd-field="why" data-kcd-type="text">${ esc( e.why ) }</span>`
				+ ( withLens ? `<span data-kcd-field="lens" data-kcd-type="text">${ esc( e.lens.join( ' · ' ) ) }</span>` : '' )
				+ '</div>'
		}

		/** One section: its heading, an optional lead line, then a table per group ( the top group unheaded ). */
		const section = ( slug: string, heading: string, lead: string, rows: NavIndexEntry[] ): string => {
			const groups = new Map<string, NavIndexEntry[]>()
			for ( const e of rows ) groups.set( e.group ?? '', [ ...( groups.get( e.group ?? '' ) ?? [] ), e ] )
			const names = [ ...groups.keys() ].sort( ( a, b ) => a === '' ? -1 : b === '' ? 1 : a.localeCompare( b ) )

			const block: string[] = [ `<section data-kcd-section="${ slug }">`, `<h2 data-kcd-heading>${ esc( heading ) }</h2>` ]
			if ( lead ) block.push( `<p>${ lead }</p>` )
			for ( const g of names ) {
				if ( g ) block.push( `<h3>${ esc( g ) }</h3>` )
				block.push( '<div data-kcd-table>' )
				block.push( '<div data-kcd-head><span>What</span><span>Where</span><span>Why</span>' + ( withLens ? '<span>Lens</span>' : '' ) + '</div>' )
				for ( const e of groups.get( g )! ) block.push( row( e ) )
				block.push( '</div>' )
			}
			block.push( '</section>' )
			return block.join( '\n' )
		}

		const promoted = entries.filter( e => !e.draft )
		const drafted  = entries.filter( e => e.draft )
		const sections: Array<{ status: string; html: string }> = NavIndex.statusOrder( promoted.map( e => e.status ) ).map( status => ( {
			status,
			html: section( status || 'no-status', status ? status[ 0 ].toUpperCase() + status.slice( 1 ) : 'No status', '', promoted.filter( e => e.status === status ) ),
		} ) )
		if ( drafted.length ) {
			const at = sections.findIndex( s => s.status === 'active' ) + 1
			sections.splice( at, 0, {
				status: '',
				html:   section( 'drafts', 'Drafts', `Being drafted in <code>${ esc( `${ docRoot }/` ) }work/</code> — scratch that authorizes nothing until it is promoted here. Addresses, not links: ephemeral space is not installed into a vault.`, drafted ),
			} )
		}
		for ( const s of sections ) parts.push( s.html )
		return parts.join( '\n\n' )
	}

	/** The category a document files under: the first folder below the index — unless that folder is a
	 *  bundle, which is a document and not a category, in which case it files at the top. */
	groupOf( dir: string, rel: string, isBundle: ( folder: string ) => boolean ): string {
		const inner = rel.slice( dir.length + 1 ).split( '/' )
		if ( inner.length === 1 ) return ''
		return isBundle( `${ dir }/${ inner[ 0 ] }` ) ? '' : inner[ 0 ]
	}

	// ── Text ──────────────────────────────────────────────────────────────────

	/**
	 * Parsed text → display text: entities decoded, whitespace collapsed. For a value that has ALREADY been
	 * through `HtmlTree` — whose `textOf` decodes `&lt;` and `&gt;` — so it must never strip "tags": the
	 * `<name@host>` in an author field is text by then, and a tag-stripper deletes it.
	 */
	static text( s: string ): string {
		return HtmlTree.decode( s ).replace( /&(mdash|ndash|middot|rarr|larr|hellip|nbsp|lsquo|rsquo|ldquo|rdquo|times|bull);/g, ( _, n: string ) => NAMED[ n ] ).replace( /\s+/g, ' ' ).trim()
	}

	/** Raw markup → display text: tags stripped FIRST, while `<` still only ever opens one. */
	static plain( html: string ): string {
		return NavIndex.text( html.replace( /<[^>]+>/g, ' ' ) )
	}

	/**
	 * The first sentence: up to the first `.` `!` or `?` that is followed by whitespace and a capital, a
	 * digit or an opening mark — so "e.g. the", "vs. a" and a path's dots do not end it. The whole text
	 * when no sentence ends inside it.
	 */
	static firstSentence( text: string ): string {
		const t = text.replace( /\s+/g, ' ' ).trim()
		const m = /^(.+?[.!?])(?=\s+[A-Z0-9"'(`‘“*])/.exec( t )
		return m ? m[ 1 ] : t
	}

	/**
	 * A why cell: the first sentence, and when that runs past `WHY_MAX`, its first clause — the text before
	 * the first `:` `;` or dash that falls after a short opening ( so a "Ruling 2026-09-16:" prefix is not
	 * mistaken for the clause ). With no clause break in reach, a cut at a word with an ellipsis.
	 */
	static lead( text: string ): string {
		const s = NavIndex.firstSentence( NavIndex.text( text ) )
		if ( s.length <= NavIndex.WHY_MAX ) return s

		const re = /\s*(?:[:;]|\s[—–]\s)/g
		for ( let m = re.exec( s ); m && m.index < NavIndex.WHY_MAX; m = re.exec( s ) ) {
			if ( m.index >= 30 ) return s.slice( 0, m.index ).trim()
		}
		const cut = s.lastIndexOf( ' ', NavIndex.WHY_MAX - 1 )
		return s.slice( 0, cut > 30 ? cut : NavIndex.WHY_MAX - 1 ).replace( /[\s,;:—–-]+$/, '' ) + '…'
	}

	/** The folders a drafts glob names — each `*` matches one existing folder. */
	expandGlob( glob: string ): string[] {
		let dirs = [ '' ]
		for ( const seg of glob.split( '/' ) ) {
			const next: string[] = []
			for ( const d of dirs ) {
				if ( seg === '*' ) {
					let kids: fs.Dirent[] = []
					try { kids = fs.readdirSync( path.join( this.vault.root, d ), { withFileTypes: true } ) } catch { /* no such folder */ }
					for ( const k of kids ) {
						if ( k.isDirectory() && !k.name.startsWith( '.' ) && !SKIP_DIRS.has( k.name ) ) next.push( d ? `${ d }/${ k.name }` : k.name )
					}
				} else {
					const p = d ? `${ d }/${ seg }` : seg
					if ( fs.existsSync( path.join( this.vault.root, p ) ) ) next.push( p )
				}
			}
			dirs = next
		}
		return dirs.sort()
	}

	/** Does a vault-relative path sit under a drafts glob? */
	static underGlob( rel: string, glob: string ): boolean {
		const g = glob.split( '/' ), r = rel.split( '/' )
		return r.length > g.length && g.every( ( seg, i ) => seg === '*' || seg === r[ i ] )
	}

	/** What a path's `*` segments matched — a draft's lens, for grouping. */
	static globMatch( rel: string, glob: string ): string {
		const r = rel.split( '/' )
		return glob.split( '/' ).map( ( seg, i ) => seg === '*' ? r[ i ] : '' ).filter( Boolean ).join( '/' )
	}

	/** Present statuses in section order. */
	static statusOrder( statuses: string[] ): string[] {
		const present = [ ...new Set( statuses ) ]
		const rank = ( s: string ): number => {
			if ( s === '' ) return STATUS_ORDER.length + 1
			const i = STATUS_ORDER.indexOf( s )
			return i >= 0 ? i : STATUS_ORDER.indexOf( '*' )
		}
		return present.sort( ( a, b ) => rank( a ) - rank( b ) || a.localeCompare( b ) )
	}

	/** Local calendar date, `YYYY-MM-DD`. */
	static today(): string {
		const d = new Date()
		return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`
	}
}
