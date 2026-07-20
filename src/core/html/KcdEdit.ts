import { HtmlTree, type HtmlEl, type HtmlNode } from './HtmlTree';

/**
 * KcdEdit — the pure slot-mutation head of the parser family, the composition-editing twin of KcdExcise
 * ( delete surgeon ) and KcdEmit ( serializer ). It ports the lens-edit ops that used to live in the
 * renderer's Kcd store ( DOMParser-based, so renderer-only ) onto the Node-free HtmlTree, so MAIN can own
 * lens editing — the single source of truth for the in-memory draft, its compile, and its save.
 *
 * Every method is STRING IN, STRING OUT: it takes a lens BODY ( the artifact's inner content, the same
 * `body` the renderer patched ) and returns a NEW body string, or `null` when the edit found no target /
 * is a no-op — the exact `false`-aborts-the-write contract the old `_editLens` mutator callbacks carried,
 * so the caller can tell "nothing changed" from "changed" ( and skip marking the draft dirty ). Nothing
 * here touches disk or holds state; the main-side lens-edit concern decides WHEN to apply and persist.
 *
 * Re-serialization is NORMALIZED ( HtmlTree.innerHtml ) — incidental whitespace / comments in the body are
 * not byte-preserved, which matches the canonical save path ( KcdEmit ) that normalizes on write anyway;
 * parity is asserted on slot names / links / modes, never on body bytes. If byte-fidelity is ever needed,
 * the span-splice route ( KcdExcise ) is the upgrade — deliberately not taken here, per "simplicity is gold".
 */
export const KcdEdit = new class KcdEdit {

	// ── slot addressing ─────────────────────────────────────────────────────────

	/** The slot whose `where` href ends with `refPath` ( the node's absolute path ends with the slot's
	 *  vault-relative href ), searched anywhere in `scope`. Mirrors the old `_findSlot`. */
	findSlot( scope: HtmlEl, refPath: string ): HtmlEl | null {
		const key = refPath.replace( /\\/g, '/' );
		return HtmlTree.first( scope, ( el ) => {
			if( !HtmlTree.has( el, 'data-kcd-slot' ) ) return false;
			const where = HtmlTree.first( el, ( c ) => c.tag === 'a' && HtmlTree.get( c, 'data-kcd-field' ) === 'where' );
			const href  = where ? HtmlTree.get( where, 'href' ) : undefined;
			return href != null && key.endsWith( href.replace( /\\/g, '/' ) );
		} );
	}

	/** The `[data-kcd-table]` under `[data-kcd-region=REGION]` › `[data-kcd-section=SECTION]`, or null —
	 *  the HtmlTree read of the descendant-combinator selectors the renderer helpers used. */
	table( root: HtmlEl, region: string, section: string ): HtmlEl | null {
		const reg = HtmlTree.first( root, ( el ) => HtmlTree.get( el, 'data-kcd-region' ) === region );
		if( !reg ) return null;
		const sec = HtmlTree.first( reg, ( el ) => HtmlTree.get( el, 'data-kcd-section' ) === section );
		if( !sec ) return null;
		return HtmlTree.first( sec, ( el ) => HtmlTree.has( el, 'data-kcd-table' ) );
	}

	/** A vault-root-relative href ( `_Claude/…` ) from an absolute artifact path. */
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

	/** Remove `target` from anywhere under `root` by identity. Returns whether it was found + removed. */
	drop( root: HtmlEl, target: HtmlEl ): boolean {
		const i = root.kids.indexOf( target );
		if( i >= 0 ) { root.kids.splice( i, 1 ); return true; }
		for( const k of root.kids ) if( HtmlTree.isEl( k ) && this.drop( k, target ) ) return true;
		return false;
	}

	/** A fresh `<div data-kcd-slot="<kind>">` ( what · where · why ), `data-kcd-mode` gating auto-load:
	 *  `suggested` = rides inline ( Included ), `on` = routing row only ( Conditional ). `kind` is the
	 *  explicit slot role ( `reference` / `habit` — protocol §3 ), stamped so a newly-added slot carries the
	 *  same kind the rest of the corpus does ( never a bare `data-kcd-slot`, which the validator rejects ). */
	buildSlot( name: string, vaultHref: string, included: boolean, kind: string, habitClass?: string ): HtmlEl {
		const attrs: Record<string, string> = { 'data-kcd-slot': kind, 'data-kcd-mode': included ? 'suggested' : 'on' };
		if( habitClass ) attrs[ 'data-kcd-habit-class' ] = habitClass;
		return this.el( 'div', attrs, [
			this.el( 'span', { 'data-kcd-field': 'what',  'data-kcd-type': 'text' }, [ this.text( name ) ] ),
			this.el( 'a',    { 'data-kcd-field': 'where', 'data-kcd-type': 'path', href: vaultHref }, [ this.text( name ) ] ),
			this.el( 'span', { 'data-kcd-field': 'why',   'data-kcd-type': 'text' }, [] ),
		] );
	}

	// ── reference / habit ops ─────────────────────────────────────────────────────

	/** Set / clear a conditional reference's condition ( the slot's `why` text ). */
	setCondition( body: string, refPath: string, why: string ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, refPath );
		const w    = slot ? HtmlTree.first( slot, ( el ) => HtmlTree.get( el, 'data-kcd-field' ) === 'why' ) : null;
		if( !w ) return null;
		w.kids = why ? [ this.text( why ) ] : [];
		return HtmlTree.innerHtml( root );
	}

	/** Set a slot's `data-kcd-mode` gate: `included` ⇒ `suggested` ( full text inline ), else `on`
	 *  ( a routing row ). Matched by where-href, so it serves the reference move AND the habit mode toggle. */
	setMode( body: string, path: string, included: boolean ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, path );
		if( !slot ) return null;
		slot.attrs[ 'data-kcd-mode' ] = included ? 'suggested' : 'on';
		return HtmlTree.innerHtml( root );
	}

	/** Remove a reference's whole slot from the lens. */
	removeRef( body: string, refPath: string ): string | null {
		const root = HtmlTree.parse( body );
		const slot = this.findSlot( root, refPath );
		if( !slot || !this.drop( root, slot ) ) return null;
		return HtmlTree.innerHtml( root );
	}

	/** Add a reference to the lens's References table ( default always-loaded ). No-op if already present. */
	addRef( body: string, refPath: string, name: string ): string | null {
		const root = HtmlTree.parse( body );
		if( this.findSlot( root, refPath ) ) return null;
		const table = this.table( root, 'know', 'references' );
		if( !table ) return null;
		table.kids.push( this.buildSlot( name, this.vaultHref( refPath ), true, 'reference' ) );
		return HtmlTree.innerHtml( root );
	}

	/** Choose ( or clear ) the habit for a class — the slot RADIO: every existing slot of the class is
	 *  dropped, then the pick is appended ( `on` false just clears ). A classless habit adds/removes only
	 *  its own slot. */
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

	// ── tool ops ( where-LESS slots under the Do region's `tools` section ) ────────

	toolTable( root: HtmlEl ): HtmlEl | null {
		return this.table( root, 'do', 'tools' );
	}

	/** The Tools table, minting the whole `<section data-kcd-section="tools">` ( heading + table head )
	 *  under the Do region if the lens has none yet — the first tool docked mints it. */
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

	/** The where-less tool slot whose `what` names `toolName`, or null. */
	findToolSlot( table: HtmlEl, toolName: string ): HtmlEl | null {
		return HtmlTree.first( table, ( el ) => {
			if( !HtmlTree.has( el, 'data-kcd-slot' ) ) return false;
			if( HtmlTree.first( el, ( c ) => c.tag === 'a' && HtmlTree.get( c, 'data-kcd-field' ) === 'where' ) ) return false; // a real slot, not a tool row
			const what = HtmlTree.first( el, ( c ) => HtmlTree.get( c, 'data-kcd-field' ) === 'what' );
			return !!what && HtmlTree.textOf( what ).trim() === toolName;
		} );
	}

	buildToolSlot( toolName: string, mode: 'on' | 'suggested' ): HtmlEl {
		return this.el( 'div', { 'data-kcd-slot': 'tool', 'data-kcd-mode': mode }, [
			this.el( 'span', { 'data-kcd-field': 'what', 'data-kcd-type': 'text' }, [ this.text( toolName ) ] ),
			this.el( 'span', { 'data-kcd-field': 'why',  'data-kcd-type': 'text' }, [ this.text( mode ) ] ),
		] );
	}

	/** Set ( or clear ) a tool's mode on the lens's Tools table. `off` REMOVES the row ( a lens carries only
	 *  the tools it contributes — off is absence ); `on`/`suggested` replace the row's mode, minting the
	 *  section on first use. The agent's own `toolModes` still overrides this at compile. */
	setTool( body: string, toolName: string, mode: 'off' | 'on' | 'suggested' ): string | null {
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
