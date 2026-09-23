import { KCDPrimitive } from '../framework/KCDPrimitive';
import { KcdContext } from '../../core/html/KcdContext';
import type { SerializedArtifact } from '../types';

/**
 * The first sentence of a run of prose, or the whole of it when it is one sentence.
 *
 * A period ENDS a sentence only when a capital or a quote opens the next one, which is what keeps
 * `audit-*` and `e.g.` from cutting a trigger in half. Nothing here is clever about abbreviations in
 * general — it does not have to be: this reads a *When* section, whose first sentence is always the
 * authored statement of the trigger.
 */
function _firstSentence( text: string ): string {
	const end = text.search( /[.:](\s+["“(]?[A-Z]|\s*$)/ );
	return end === -1 ? text.trim() : text.slice( 0, end + 1 ).trim();
}

/**
 * A contract: an invocable procedure the project holds and any agent runs. Declares its trigger
 * condition; structure is enforced at parse time by KcdValidate.
 */
export class ContractObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'contract' );
	}

	static fromSerialized( json: SerializedArtifact ): ContractObject {
		const obj = new ContractObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	getRole() { return 'do' as const; }

	/**
	 * The trigger — what a session matches a request against to decide this contract applies. The sibling
	 * of `HabitObject.getWhy`, and the line a compiled context carries for this contract.
	 *
	 * THE OPENING STATEMENT AND THE ROWS, NOT THE WHOLE SECTION. A contract's *When* is authored as prose
	 * and runs to several paragraphs; what a session needs in order to decide is the sentence that names
	 * the trigger, plus the conditions enumerated under it. Everything after that first sentence is the
	 * contract elaborating on itself, which the session gets when it fetches the contract whole — and it
	 * is told to do exactly that before acting.
	 *
	 * The rows are the half this cannot drop. `readSection` collects every `<li>` into `items` and leaves
	 * `text` without them, so returning `text` alone took a sentence ending in a colon and welded the
	 * paragraph AFTER the list onto it: a trigger that promised its conditions and then named none.
	 */
	getWhen(): string {
		const when = KcdContext.habitSections( this.body )[ 'when' ];
		if ( !when ) return '';
		const opening = _firstSentence( when.text );
		if ( !when.items.length ) return opening;
		return `${ opening.replace( /[:.]$/, '' ) }: ${ when.items.join( '; ' ) }`;
	}
}
