import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from '../Vault';
import { VaultTools } from '../VaultTools';
import type { VaultToolNames } from '../VaultTools';
import { KcdShapes } from '../../core';
import type { ToolResult } from '../../server/McpServer';

/**
 * TASK-2544, plan 86 phase 2.b — AN ANALYZER'S DEFAULT TASK BRIEF, through the authoring door.
 *
 * This is the half of the card that has to be proved at `save` rather than at the shape table: the claim is
 * that the writing door ACCEPTS the section and does not warn on it, and that a reader can get the brief
 * back off the parsed document afterwards. A shape entry nobody drove a write through is a table entry.
 *
 * ── THE SECOND CASE IS THE REGRESSION THE STEP MUST NOT CAUSE ──
 * There are hundreds of analyzers and other governed documents already on disk, and not one of them has ever
 * heard of a patrol. So the same door is driven with an analyzer carrying NO brief, and the write is asserted
 * to come back with no warning about the section either — which is what the `optional` tier buys and the only
 * thing that keeps this from being a corpus-wide advisory.
 *
 * ── AN HONEST NOTE ABOUT WHAT THESE CHECKS CAN AND CANNOT DISTINGUISH ──
 * An `analyzer` is an OPEN type ( `KcdShapes` sets `open: true` ), and for an open type `audit` returns an
 * EMPTY `unexpected` list by construction and `save` raises its undeclared-section advisory only for a
 * CLOSED one. So the save door accepted this section and stayed silent about it BEFORE the shape declared
 * it, and these two cases would have passed then as well — they are a regression guard, not the proof the
 * declaration landed.
 *
 * It was checked rather than assumed: the shape entry was withdrawn and this file re-run, and it stayed
 * green. What DOES distinguish before from after is the shape table's own answer — `orderFor` and
 * `audit().order`, which is what synthesis orders by and what a refusal quotes — and that is asserted
 * against the table directly, in the third case below and in `PatrolTargetResolve.test.ts` beside it.
 */

const NAMES: VaultToolNames = {
	query: 'find', get: 'read', links: 'edges', health: 'check', compile: 'compose',
	survey: 'scout', save: 'write', move: 'rename', delete: 'remove', batch: 'run',
};

let root = '';

const tools = () => new VaultTools( new Vault( root, '_Claude' ), NAMES );
const text  = ( r: ToolResult ): string => r.content.map( c => c.text ).join( '' );
const json  = ( r: ToolResult ): Record<string, unknown> => JSON.parse( text( r ) ) as Record<string, unknown>;

/** The section name, spelled here exactly once and read from the shape everywhere else. */
const BRIEF = 'task-brief';

/** The sections every analyzer already on disk carries — the shape's own required and expected set. */
const EXISTING = {
	know:           'Reads one document\'s full body prose. Reads nothing else.',
	care:           'THE ONE QUESTION: does this document say what it does?',
	parameters:     'subject ( text, default: none ) — the one document to check, project-root-relative.',
	do:             'One judgment pass over the prose.',
	'report-shape': 'ORDINAL BUCKETS, never summed: 0 clean, 1 borderline, 2 finding.',
};

const analyzer = ( name: string, sections: Record<string, string> ): Record<string, unknown> => ( {
	type:        'analyzer',
	frontmatter: { name, description: 'A fixture analyzer.', type: 'analyzer', status: 'draft' },
	content:     { sections },
} );

const save = ( name: string, sections: Record<string, string> ): ToolResult =>
	tools().save( { path: `analyzers/${ name }/${ name }.html`, artifact: analyzer( name, sections ) } );

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'kcd-analyzer-brief-' ) );
	mkdirSync( join( root, '_Claude', 'analyzers' ), { recursive: true } );
	// A stylesheet is not needed for a save; the folder is, so `Vault.write` has somewhere to land.
	writeFileSync( join( root, '_Claude', '.keep' ), '' );
} );

afterEach( () => { if ( root ) rmSync( root, { recursive: true, force: true } ); } );

describe( 'an analyzer carrying a default task brief', () => {

	it( 'saves with no warning about the section, and the brief reads back off the document', () => {
		const r = save( 'check-with-brief', {
			...EXISTING,
			[ BRIEF ]: 'Read the subject against this analyzer.\n\nFile one finding per violation, not per file.',
		} );

		expect( r.isError ).toBeUndefined();
		const warnings = json( r )[ 'warnings' ] as string[];
		// NOT "no warnings at all" — an unrelated advisory is the validator's business and not this card's.
		// What must be absent is any warning ABOUT this section.
		expect( warnings.join( ' | ' ) ).not.toContain( BRIEF );
		expect( warnings.join( ' | ' ) ).not.toContain( 'not declared' );

		// …and a reader gets the prose back, which is the other half of the card's first proof.
		const read = json( tools().get( { path: 'analyzers/check-with-brief/check-with-brief.html' } ) );
		const sections = read[ 'sections' ] as Record<string, string>;
		expect( sections[ BRIEF ] ).toContain( 'File one finding per violation' );
	} );

	/**
	 * THE ONE CASE HERE THAT FAILS WITHOUT THE DECLARATION — the shape's own answer, checked against the
	 * bytes the save actually wrote.
	 *
	 * `orderFor` is what synthesis emits by and what a refusal quotes, so a section the table does not name
	 * is a section the author cannot be told about and a `fix` cannot place. Withdraw the shape entry and
	 * the first expectation below goes red: `orderFor( 'analyzer' )` stops naming it, the filtered list
	 * comes back one short, and the count no longer matches the sections on disk.
	 */
	it( 'is named by the shape, and the written document follows the shape\'s order', () => {
		save( 'check-ordered', {
			// supplied FIRST on purpose: the emitted order must come from the shape, never from the order a
			// caller happened to write the keys in
			[ BRIEF ]: 'The brief.',
			...EXISTING,
		} );

		const html = readFileSync( join( root, '_Claude', 'analyzers', 'check-ordered', 'check-ordered.html' ), 'utf-8' );
		const at = ( name: string ): number => html.indexOf( `data-kcd-section="${ name }"` );

		// THE DECLARATION ITSELF: the table names it, so it is one of the six the shape governs.
		const order = KcdShapes.orderFor( 'analyzer' );
		expect( order ).toContain( BRIEF );

		// every section this document carries is a section the shape names — nothing trailed as undeclared
		const present = order.filter( ( s ) => at( s ) > -1 );
		expect( present ).toHaveLength( Object.keys( EXISTING ).length + 1 );

		// …and they are on disk in exactly the table's order, asserted against it rather than restated
		expect( present ).toEqual( [ ...present ].sort( ( a, b ) => at( a ) - at( b ) ) );
	} );
} );

describe( 'an analyzer with no such section', () => {

	/** THE 860-DOCUMENT REGRESSION THIS STEP MUST NOT CAUSE. The tier is `optional`, so absence is silent;
	 *  `expected` would have put this warning on every analyzer in the corpus. */
	it( 'still saves clean, with no warning naming the brief', () => {
		const r = save( 'check-no-brief', EXISTING );

		expect( r.isError ).toBeUndefined();
		const warnings = json( r )[ 'warnings' ] as string[];
		expect( warnings.join( ' | ' ) ).not.toContain( BRIEF );
		expect( warnings.join( ' | ' ) ).not.toContain( 'Task Brief' );
	} );

	/** And it validates clean through `check`, which is the read half of the same gate — a document already
	 *  on disk is judged by this one, not by `save`. */
	it( 'validates clean', () => {
		save( 'check-no-brief', EXISTING );
		const r = tools().health( { path: 'analyzers/check-no-brief/check-no-brief.html' } );
		expect( r.isError ).toBeUndefined();
		expect( text( r ) ).not.toContain( BRIEF );
	} );
} );
