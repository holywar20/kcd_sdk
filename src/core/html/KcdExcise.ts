/**
 * KcdExcise — remove a link ( and its structural record ) from an HTML source, span-precise.
 * Edits only the matched node's exact source span, using HtmlTree's offsets rather than a second raw-text
 * matcher, and never re-serializes, so all other bytes and hand-authored alignment survive. Slot-field
 * links remove the whole record row, since it is meaningless once its target is gone; bare prose links
 * unwrap to their inner text. Cuts never overlap ( slots do not nest ), so they apply back-to-front.
 */

import { HtmlTree } from './HtmlTree';
import type { HtmlEl } from './HtmlTree';

interface Cut { start: number; end: number; text: string; }

export const KcdExcise = new class KcdExcise {

	html( source: string, matches: ( href: string ) => boolean ): string {
		const root    = HtmlTree.parse( source );
		const slots   = new Set<HtmlEl>();
		const unwraps: Array<{ a: HtmlEl; slot: HtmlEl | undefined }> = [];
		this.scan( root, undefined, matches, slots, unwraps );

		const cuts: Cut[] = [];
		for ( const slot of slots ) cuts.push( this.removeSpan( source, slot ) );
		// an <a> whose enclosing slot is already being removed is subsumed by that removal — skip it.
		for ( const u of unwraps ) if ( !u.slot || !slots.has( u.slot ) ) cuts.push( this.unwrapSpan( source, u.a ) );

		cuts.sort( ( x, y ) => y.start - x.start );
		let out = source;
		for ( const c of cuts ) out = out.slice( 0, c.start ) + c.text + out.slice( c.end );
		return out;
	}

	/** The `.js` comment-body counterpart: unwrap `[text](href)` → `text` for a matching href. */
	js( source: string, matches: ( href: string ) => boolean ): string {
		return source.replace( /\[([^\]]*)\]\(([^)]+)\)/g, ( whole, text, href ) => matches( href ) ? text : whole );
	}

	// ── internals ──────────────────────────────────────────────────────────────

	scan(
		el: HtmlEl,
		slot: HtmlEl | undefined,
		matches: ( href: string ) => boolean,
		slots: Set<HtmlEl>,
		unwraps: Array<{ a: HtmlEl; slot: HtmlEl | undefined }>
	): void {
		const here = HtmlTree.has( el, 'data-kcd-slot' ) ? el : slot;
		if ( el.tag === 'a' && HtmlTree.has( el, 'href' ) && matches( HtmlTree.get( el, 'href' )! ) ) {
			if ( HtmlTree.has( el, 'data-kcd-field' ) && here ) slots.add( here );
			else unwraps.push( { a: el, slot: here } );
		}
		for ( const k of el.kids ) if ( HtmlTree.isEl( k ) ) this.scan( k, here, matches, slots, unwraps );
	}

	/** A whole-element removal, widened to swallow its own line ( leading indent + trailing newline ) so
	 *  no blank row is left where a record used to be. */
	removeSpan( source: string, el: HtmlEl ): Cut {
		let a = el.start!, b = el.end!;
		const lineStart = source.lastIndexOf( '\n', a - 1 ) + 1;
		if ( source.slice( lineStart, a ).trim() === '' ) a = lineStart;
		if ( source[ b ] === '\r' ) b++;
		if ( source[ b ] === '\n' ) b++;
		return { start: a, end: b, text: '' };
	}

	/** Replace an `<a>…</a>` with its own inner source ( the link's text, verbatim — never re-escaped ). */
	unwrapSpan( source: string, a: HtmlEl ): Cut {
		const openEnd    = source.indexOf( '>', a.start! ) + 1;
		const closeStart = a.end! - '</a>'.length;
		return { start: a.start!, end: a.end!, text: source.slice( openEnd, closeStart ) };
	}
}();
