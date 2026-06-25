import { describe, it, expect } from 'vitest';
import { Constellation } from '../Constellation';
import { ConstellationError } from '../Validation';
import type { BranchNode, ParallelNode } from '../types';

/**
 * Constellation primitive — the fluent builder IS the graph, it round-trips across the bridge
 * (mirroring Agent), and `validate()` returns plain message strings. Structural only; binding
 * validation (does each id resolve here) is the Navigator's job, main-side.
 */

describe( 'Constellation — authoring + the committed tree', () => {

	it( 'builds a linear spine of Steps with unique node ids', () => {
		const c = Constellation.define( 'demo' ).then( 'seed-note' ).then( 'summarize' ).commit();
		const nodes = c.nodes();
		expect( nodes ).toHaveLength( 2 );
		expect( nodes[ 0 ] ).toMatchObject( { kind: 'step', ref: 'seed-note' } );
		expect( nodes[ 1 ] ).toMatchObject( { kind: 'step', ref: 'summarize' } );
		expect( nodes[ 0 ].id ).not.toBe( nodes[ 1 ].id );
	} );

	it( 'nests branch ports as sub-sequences with a stored contract', () => {
		const c = Constellation.define( 'repair-docs' )
			.then( 'audit-structure' )
			.branch( 'merge-ready', {
				pass: ( w ) => w.then( 'apply-repairs' ),
				fail: ( w ) => w.then( 'audit-structure' ),
			} )
			.commit();

		const branch = c.nodes()[ 1 ] as BranchNode;
		expect( branch.kind ).toBe( 'branch' );
		expect( branch.contract ).toBe( 'merge-ready' );
		expect( branch.pass ).toHaveLength( 1 );
		expect( branch.fail ).toHaveLength( 1 );
		expect( branch.pass![ 0 ] ).toMatchObject( { kind: 'step', ref: 'apply-repairs' } );
	} );

	it( 'nests parallel lanes as sub-sequences', () => {
		const c = Constellation.define( 'fan' )
			.parallel( [ ( w ) => w.then( 'a' ), ( w ) => w.then( 'b' ).then( 'c' ) ] )
			.commit();

		const par = c.nodes()[ 0 ] as ParallelNode;
		expect( par.kind ).toBe( 'parallel' );
		expect( par.lanes ).toHaveLength( 2 );
		expect( par.lanes[ 1 ] ).toHaveLength( 2 );
	} );

	it( 'refuses authoring after commit', () => {
		const c = Constellation.define( 'frozen' ).then( 'a' ).commit();
		expect( () => c.then( 'b' ) ).toThrow();
	} );
} );

describe( 'Constellation — round-trip across the bridge', () => {

	it( 'serializeForWire ⇄ fromSerialized survives a branch + parallel nest', () => {
		const original = Constellation.define( 'mixed' )
			.then( 'audit-structure' )
			.branch( 'merge-ready', {
				pass: ( w ) => w.parallel( [ ( x ) => x.then( 'apply-repairs' ), ( x ) => x.then( 'log' ) ] ),
				fail: ( w ) => w.then( 'audit-structure' ),
			} )
			.commit();

		const wire    = original.serializeForWire();
		const rebuilt = Constellation.fromSerialized( wire );

		expect( rebuilt.id ).toBe( 'mixed' );
		expect( rebuilt.serializeForWire() ).toEqual( wire );   // deep structural equality
		expect( rebuilt.isCommitted() ).toBe( true );
		expect( rebuilt.isExecutable() ).toBe( true );
	} );
} );

describe( 'Constellation — validation (plain strings)', () => {

	it( 'a committed, well-formed constellation is valid + executable', () => {
		const c = Constellation.define( 'ok' ).then( 'a' ).commit();
		expect( c.validate() ).toEqual( [] );
		expect( c.isExecutable() ).toBe( true );
	} );

	it( 'an empty constellation reports EMPTY and is not executable', () => {
		const c = Constellation.define( 'empty' ).commit();
		expect( c.validate() ).toContain( ConstellationError.EMPTY );
		expect( c.isExecutable() ).toBe( false );
	} );

	it( 'a branch with no ports is a dead branch', () => {
		const c = Constellation.define( 'dead' ).branch( 'merge-ready', {} ).commit();
		const branch = c.nodes()[ 0 ] as BranchNode;
		expect( c.validate() ).toContain( ConstellationError.branchDeadPorts( branch.id ) );
	} );

	it( 'an uncommitted constellation can still validate (renderer checks a draft live)', () => {
		const c = Constellation.define( 'draft' ).then( 'a' );   // no commit
		expect( c.validate() ).toEqual( [] );
		expect( c.isCommitted() ).toBe( false );
		expect( c.isExecutable() ).toBe( false );                 // valid, but not frozen → not runnable
	} );
} );

describe( 'Constellation — Start + Agent nodes (the board entry + executor)', () => {

	it( 'builds + round-trips a Start → Agent spine', () => {
		const c = Constellation.define( 'launch' ).start().agent( 'agent-7' ).commit();

		expect( c.nodes()[ 0 ] ).toMatchObject( { kind: 'start' } );
		expect( c.nodes()[ 1 ] ).toMatchObject( { kind: 'agent', agent: 'agent-7' } );
		expect( c.isExecutable() ).toBe( true );

		const rebuilt = Constellation.fromSerialized( c.serializeForWire() );
		expect( rebuilt.serializeForWire() ).toEqual( c.serializeForWire() );
	} );

	it( 'flags an agent node with no agent ref', () => {
		const c = Constellation.define( 'bad' ).start().agent( '' ).commit();
		const agentNode = c.nodes()[ 1 ];
		expect( c.validate() ).toContain( ConstellationError.agentNoRef( agentNode.id ) );
	} );
} );
