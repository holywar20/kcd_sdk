import { describe, it, expect } from 'vitest';
import { ContractObject } from '../index';

/**
 * A contract's TRIGGER — the one line a compiled context carries for it ( plan agents-own-behaviour,
 * task 75 ).
 *
 * A *When* section is authored as prose and runs to several paragraphs, and `readSection` hands back its
 * rows separately from its text. Both halves of that are traps. Returning the text alone drops the very
 * conditions the trigger is made of; returning all of it puts three paragraphs of a contract's own
 * elaboration into every agent's context, for every contract in the project.
 */
function contract( when: string ): ContractObject {
	return ContractObject.fromSerialized( {
		path:        'C:/v/contracts/x.html',
		type:        'contract',
		frontmatter: { name: 'x', type: 'contract' },
		sections:    {},
		links:       [],
		body:        `<section data-kcd-section="when"><h2 data-kcd-heading>When</h2>${ when }</section>`
	} as never );
}

describe( 'ContractObject.getWhen', () => {

	it( 'carries the opening statement and stops before the elaboration', () => {
		const c = contract(
			'<p>Invoked explicitly as #close, or by description. It closes a TASK or a group of tasks.</p>'
			+ '<p>Run it while the context that knows what happened is still loaded.</p>' );
		expect( c.getWhen() ).toBe( 'Invoked explicitly as #close, or by description.' );
	} );

	// The half that was lost. A statement ending in a colon names its conditions in the list under it,
	// and `text` does not contain them — so the line promised the conditions and then named none.
	it( 'carries the rows a colon promised, not the paragraph after them', () => {
		const c = contract(
			'<p>This contract activates whenever an audit analyzer:</p>'
			+ '<ul><li>Runs its census phase</li><li>Finishes examining any unit of its scope</li></ul>'
			+ '<p>Every analyzer in the audit-* family keeps a ledger, with one exception.</p>' );
		expect( c.getWhen() ).toBe(
			'This contract activates whenever an audit analyzer: Runs its census phase; Finishes examining any unit of its scope' );
	} );

	it( 'takes a one-sentence trigger whole, and a period mid-name in its stride', () => {
		expect( contract( '<p>Whenever an audit-* analyzer writes its Coverage section.</p>' ).getWhen() )
			.toBe( 'Whenever an audit-* analyzer writes its Coverage section.' );
		expect( contract( '<p>Invoked as #plan, e.g. "let us make a plan". The phase is named in plain language.</p>' ).getWhen() )
			.toBe( 'Invoked as #plan, e.g. "let us make a plan".' );
	} );

	it( 'says nothing for a contract that declares no trigger', () => {
		expect( ContractObject.fromSerialized( {
			path: 'C:/v/contracts/x.html', type: 'contract', frontmatter: { name: 'x' }, sections: {}, links: [], body: ''
		} as never ).getWhen() ).toBe( '' );
	} );
} );
