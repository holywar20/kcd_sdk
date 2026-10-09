import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';
import { KcdSynth } from './KcdSynth';

/**
 * KcdEdit — the pure slot-mutation head of the parser family. Every method is STRING IN, STRING OUT: it returns a
 * new body, or `null` when the edit found no target or is a no-op, so a caller can tell "nothing changed" from
 * "changed". Nothing here touches disk or holds state.
 * Re-serialization is NORMALIZED ( HtmlTree.innerHtml ): parity is asserted on slot names, links and modes, never on
 * body bytes. Byte-fidelity via KcdExcise's span-splice was deliberately not taken here.
 */
export const KcdEdit = new class KcdEdit {

	// ── slot addressing ─────────────────────────────────────────────────────────

	/** The slot whose `where` href ends with `refPath` ( the node's absolute path ends with the slot's
	 *  vault-relative href ), searched anywhere in `scope`. */
	findSlot( scope: HtmlEl, refPath: string ): HtmlEl | null {
		const key = refPath.replace( /\\/g, '/' );
		return HtmlTree.first( scope, ( el ) => {
			if( !HtmlTree.has( el, 'data-kcd-slot' ) ) return false;
			const where = HtmlTree.first( el, ( c ) => c.tag === 'a' && HtmlTree.get( c, 'data-kcd-field' ) === 'where' );
			const href  = where ? HtmlTree.get( where, 'href' ) : undefined;
			return href != null && key.endsWith( href.replace( /\\/g, '/' ) );
		} );
	}

	/** The `[data-kcd-table]` in `[data-kcd-section=SECTION]`, or null. `_region` is unused, so a section is found
	 *  wherever it sits and the Do-region ops ( habits, tools ) refuse on a lens. */
	table( root: HtmlEl, _region: string, section: string ): HtmlEl | null {
		const sec = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-section' ) === section );
		if( !sec ) return null;
		return HtmlTree.first( sec, ( el ) => HtmlTree.has( el, 'data-kcd-table' ) );
	}

	vaultHref( absPath: string ): string {
		const norm = absPath.replace( /\\/g, '/' );
		const i = norm.lastIndexOf( '/_Claude/' );
		return i >= 0 ? norm.slice( i + 1 ) : norm;
	}

	// ── tree construction / mutation ( HtmlTree is plain objects, so we build + splice directly ) ──

	el( tag: string, attrs: Record<string, string>, kids: HtmlNode[] = [] ): HtmlEl {
		return { type: 'el', tag, attrs, kids };
	}
	text( value: string ): HtmlNode {
		return { type: 'text', value };
	}

	drop( root: HtmlEl, target: HtmlEl ): boolean {
		const i = root.kids.indexOf( target );
		if( i >= 0 ) { root.kids.splice( i, 1 ); return true; }
		for( const k of root.kids ) if( HtmlTree.isEl( k ) && this.drop( k, target ) ) return true;
		return false;
	}

	/** `data-kcd-mode` gates auto-load: `load` rides inline, `on` is a routing row only. The kind is always
	 *  stamped, never bare, because the validator rejects a bare `data-kcd-slot`. */
	buildSlot( name: string, vaultHref: string, included: boolean, kind: string, habitClass?: string ): HtmlEl {
		const attrs: Record<string, string> = { 'data-kcd-slot': kind, 'data-kcd-mode': included ? 'load' : 'on' };
		if( habitClass ) attrs[ 'data-kcd-habit-class' ] = habitClass;
		return this.el( 'div', attrs, [
			this.el( 'span', { 'data-kcd-field': 'what',  'data-kcd-type': 'text' }, [ this.text( name ) ] ),
			this.el( 'a',    { 'data-kcd-field': 'where', 'data-kcd-type': 'path', href: vaultHref }, [ this.text( name ) ] ),
			this.el( 'span', { 'data-kcd-field': 'why',   'data-kcd-type': 'text' }, [] ),
		] );
	}

	// ── reference / habit ops ─────────────────────────────────────────────────────

	setCondition( body: string, refPath: string, why: string ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, refPath );
		const w    = slot ? HtmlTree.first( slot, ( el ) => HtmlTree.get( el, 'data-kcd-field' ) === 'why' ) : null;
		if( !w ) return null;
		w.kids = why ? [ this.text( why ) ] : [];
		return HtmlTree.innerHtml( root );
	}

	setMode( body: string, path: string, included: boolean ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, path );
		if( !slot ) return null;
		slot.attrs[ 'data-kcd-mode' ] = included ? 'load' : 'on';
		return HtmlTree.innerHtml( root );
	}

	removeRef( body: string, refPath: string ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, refPath );
		if( !slot || !this.drop( root, slot ) ) return null;
		return HtmlTree.innerHtml( root );
	}

	addRef( body: string, refPath: string, name: string ): string | null {
		const root = HtmlTree.parse( body );
		if( this.findSlot( root, refPath ) ) return null;
		const table = this.table( root, 'know', 'references' );
		if( !table ) return null;
		table.kids.push( this.buildSlot( name, this.vaultHref( refPath ), true, 'reference' ) );
		return HtmlTree.innerHtml( root );
	}

	/** Choose ( or clear ) a habit: the slot RADIO drops every existing slot of the class, then appends the pick.
	 *  A classless habit adds or removes only its own slot. */
	setHabit( body: string, habitClass: string | null, habitPath: string, name: string, on: boolean ): string | null {
		const root  = HtmlTree.parse( body );
		const table = this.table( root, 'do', 'habits' );
		if( !table ) return null;
		if( habitClass ) {
			for( const s of HtmlTree.collect( table, ( el ) => HtmlTree.has( el, 'data-kcd-slot' ) && HtmlTree.get( el, 'data-kcd-habit-class' ) === habitClass ) ) this.drop( root, s );
		} else {
			const s = this.findSlot( table, habitPath );
			if( s ) this.drop( root, s );
		}
		if( on ) table.kids.push( this.buildSlot( name, this.vaultHref( habitPath ), true, 'habit', habitClass ?? undefined ) );
		return HtmlTree.innerHtml( root );
	}

	// ── habit ops ─────────────────────────────────────────────────────────────────

	/** Rewrite a habit's Why section as one paragraph under its heading. Null when the section is missing or
	 *  the text blank: a habit's why is required, so there is nothing sound to write. */
	setHabitWhy( body: string, why: string ): string | null {
		const text = why.trim();
		if( !text ) return null;
		const root = HtmlTree.parse( body );
		const sec  = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-section' ) === 'why' );
		if( !sec ) return null;
		const head = sec.kids.find( ( k ): k is HtmlEl => k.type === 'el' && /^h[1-6]$/.test( k.tag ) );
		sec.kids = [ ...( head ? [ head ] : [] ), this.el( 'p', {}, [ this.text( text ) ] ) ];
		return HtmlTree.innerHtml( root );
	}

	// ── section prose ─────────────────────────────────────────────────────────────

	/** One section's inner markup without its heading: null when absent, `''` when present and empty.
	 *  HTML OUT, NOT PROSE — a flattening round-trip would silently drop tables, lists and links on every save. */
	sectionProse( body: string, section: string ): string | null {
		const root = HtmlTree.parse( body );
		const sec  = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-section' ) === section );
		if( !sec ) return null;
		const kids = sec.kids.filter( ( k ) => !( k.type === 'el' && /^h[1-6]$/.test( k.tag ) ) );
		return HtmlTree.innerHtml( { type: 'el', tag: 'div', attrs: {}, kids } ).trim();
	}

	/**
	 * Rewrite one section's prose, keeping its heading and its place. Takes either plain text or authored
	 * block HTML — `KcdSynth.proseToHtml` decides which, by the same crude-but-safe test every authoring
	 * path uses, so a human typing paragraphs and an agent emitting `<p>` land identically.
	 *
	 * Null when the text is blank. BLANK IS A REFUSAL RATHER THAN A CLEAR: an empty section trips the
	 * validator's own `empty-section` rule, so writing one would produce a draft that cannot be saved — a
	 * failure discovered at Save, far from the keystroke that caused it. Removing a section is a different
	 * act and does not belong on the text-editing op.
	 *
	 * A SECTION THE DOCUMENT DOES NOT CARRY IS CREATED, but only when the caller names a `title` for it.
	 *
	 * The title is the caller's because only the caller knows what the heading should READ — the section id
	 * is a slug and the heading is prose. No title means no creation, so an edit of an existing section
	 * cannot start authoring new ones.
	 *
	 * WHERE IT LANDS: immediately before `references` when the document has one, else at the end of the
	 * article. Prose before tables is the shape every artifact type here keeps, and appending blindly would
	 * put a philosophy under the reference list of every lens that has one.
	 *
	 * NOT A VALIDATION GATE. This shapes one section; whether the DOCUMENT still stands is `KcdValidate`'s
	 * question at save, and it stays the only one asking — the same division `KcdSynth` documents.
	 */
	setSection( body: string, section: string, prose: string, title?: string ): string | null {
		const html = KcdSynth.proseToHtml( prose );
		if( !html ) return null;
		const root = HtmlTree.parse( body );
		const sec  = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-section' ) === section );
		if( sec ) {
			const head = sec.kids.find( ( k ): k is HtmlEl => k.type === 'el' && /^h[1-6]$/.test( k.tag ) );
			sec.kids = [ ...( head ? [ head ] : [] ), ...HtmlTree.parse( html ).kids ];
			return HtmlTree.innerHtml( root );
		}
		if ( !title ) return null;

		const made = this.el( 'section', { 'data-kcd-section': section }, [
			this.el( 'h3', { 'data-kcd-heading': '' }, [ this.text( title ) ] ),
			...HtmlTree.parse( html ).kids
		] );
		// The article is where a section belongs; a document with no article element is malformed enough
		// that appending at the root is as good an answer as refusing, and the validator will say so.
		const host = HtmlTree.first( root, ( el ) => el.tag === 'article' ) ?? root;
		const refs = host.kids.findIndex(
			( k ) => k.type === 'el' && HtmlTree.get( k, 'data-kcd-section' ) === 'references' );
		if ( refs >= 0 ) host.kids.splice( refs, 0, made );
		else host.kids.push( made );
		return HtmlTree.innerHtml( root );
	}

	// ── identity ──────────────────────────────────────────────────────────────────

	/** Splices only the id row. A normalizing rewrite would turn a vault-wide stamp into a whitespace diff.
	 *  Null when the id already matches or there is no frontmatter block. */
	setId( html: string, id: string ): string | null {
		const open = /<dl\b[^>]*\bdata-kcd-frontmatter\b[^>]*>/i.exec( html );
		if( !open ) return null;
		const close = html.indexOf( '</dl>', open.index );
		if( close < 0 ) return null;
		const block = html.slice( open.index, close );

		const held = /(<dd\b[^>]*\bdata-kcd-field=["']id["'][^>]*>)([^<]*)(<\/dd>)/i.exec( block );
		if( held ) {
			if( held[ 2 ].trim() === id ) return null;
			const at = open.index + held.index;
			return html.slice( 0, at ) + held[ 1 ] + id + held[ 3 ] + html.slice( at + held[ 0 ].length );
		}

		const row  = `<dt>id</dt><dd data-kcd-field="id" data-kcd-type="text">${ id }</dd>`;
		const name = /<dd\b[^>]*\bdata-kcd-field=["']name["'][^>]*>[\s\S]*?<\/dd>/i.exec( block );
		if( !name ) return html.slice( 0, close ) + row + html.slice( close );

		// After the name row, at its indentation, so a hand-formatted block reads as if the row was always there.
		// A block written on one line gets the row on one line too.
		const start  = open.index + name.index;
		const end    = start + name[ 0 ].length;
		const inline = !/\n/.test( block );
		if( inline ) return html.slice( 0, end ) + row + html.slice( end );
		const indent = /^[\t ]*/.exec( html.slice( html.lastIndexOf( '\n', start ) + 1 ) )![ 0 ];
		return html.slice( 0, end ) + '\n' + indent + row + html.slice( end );
	}

	// ── tool ops ( where-LESS slots under the Do region's `tools` section ) ────────

	toolTable( root: HtmlEl ): HtmlEl | null {
		return this.table( root, 'do', 'tools' );
	}

	ensureToolTable( root: HtmlEl ): HtmlEl | null {
		const existing = this.toolTable( root );
		if( existing ) return existing;
		const doRegion = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-region' ) === 'do' );
		if( !doRegion ) return null;
		const head = this.el( 'div', { 'data-kcd-head': '' }, [ 'Tool', 'Mode' ].map( ( l ) => this.el( 'span', {}, [ this.text( l ) ] ) ) );
		const table = this.el( 'div', { 'data-kcd-table': '' }, [ head ] );
		doRegion.kids.push( this.el( 'section', { 'data-kcd-section': 'tools' }, [ this.el( 'h3', {}, [ this.text( 'Tools' ) ] ), table ] ) );
		return table;
	}

	findToolSlot( table: HtmlEl, toolName: string ): HtmlEl | null {
		return HtmlTree.first( table, ( el ) => {
			if( !HtmlTree.has( el, 'data-kcd-slot' ) ) return false;
			if( HtmlTree.first( el, ( c ) => c.tag === 'a' && HtmlTree.get( c, 'data-kcd-field' ) === 'where' ) ) return false; // a real slot, not a tool row
			const what = HtmlTree.first( el, ( c ) => HtmlTree.get( c, 'data-kcd-field' ) === 'what' );
			return !!what && HtmlTree.textOf( what ).trim() === toolName;
		} );
	}

	buildToolSlot( toolName: string, mode: 'on' | 'load' ): HtmlEl {
		return this.el( 'div', { 'data-kcd-slot': 'tool', 'data-kcd-mode': mode }, [
			this.el( 'span', { 'data-kcd-field': 'what', 'data-kcd-type': 'text' }, [ this.text( toolName ) ] ),
			this.el( 'span', { 'data-kcd-field': 'why',  'data-kcd-type': 'text' }, [ this.text( mode ) ] ),
		] );
	}

	/** `toolName` is the `group.tool` identity, written verbatim. `off` removes the row: off is absence.
	 *  The agent's own tool policies still override this at compile. */
	setTool( body: string, toolName: string, mode: 'off' | 'on' | 'load' ): string | null {
		const root = HtmlTree.parse( body );
		if( mode === 'off' ) {
			const table = this.toolTable( root );
			const slot  = table ? this.findToolSlot( table, toolName ) : null;
			if( !slot ) return null;
			this.drop( root, slot );
			return HtmlTree.innerHtml( root );
		}
		const table = this.ensureToolTable( root );
		if( !table ) return null;
		const prior = this.findToolSlot( table, toolName );
		if( prior ) this.drop( root, prior );   // replace any existing mode
		table.kids.push( this.buildToolSlot( toolName, mode ) );
		return HtmlTree.innerHtml( root );
	}

}();
