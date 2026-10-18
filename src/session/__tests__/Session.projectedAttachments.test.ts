import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { Transcript, type Attachment } from '../TurnEntry';

/**
 * `projectedAttachments()` is what RIDES, as distinct from `attachments()`, which is what is attached and
 * includes everything. A caller reaching for the wrong one shows a file that cannot be turned back on, or
 * pays twice for history a compaction already summarised. It serves the non-replaying harness tier, which
 * asks for the window's attachments by name. A file attached on turn one must still ride on turn two.
 */

function fileEntry( name: string, removed?: boolean ): Attachment {
	return { at: 1, kind: 'injected-file', path: `C:/repo/${ name }`, name, mediaType: 'text/plain', bytes: 40, removed };
}

/** A session whose transcript holds one turn per attachment, in order. */
function sessionWith( ...attachments: Attachment[] ): Session {
	const session = Session.create( { id: 'session-1', agentId: 'agent-1' } );
	attachments.forEach( ( attachment, i ) => {
		const turn = session.transcript.openTurn( `turn-${ i + 1 }`, i );
		session.transcript.append( attachment, turn );
		session.transcript.append( { at: i, kind: 'user', text: `message ${ i + 1 }` }, turn );
	} );
	return session;
}

/** The harness's two-turn projection: prior attachments ride a past turn as pointers, and only what is injected now rides the live one. Flattening both would make every past attachment look like an injection. */
function projectedText( session: Session ): string {
	const only = new Transcript();
	const past = only.openTurn( 'attached', 0 );
	for ( const attachment of session.projectedAttachments() ) only.append( attachment, past );
	only.openTurn( 'injecting', 1 );
	return JSON.stringify( only.wireMessages() );
}

describe( 'Session.projectedAttachments', () => {
	it( 'still returns a file attached on an EARLIER turn', () => {
		const session = sessionWith( fileEntry( 'a.ts' ) );
		// turn two — a later exchange, nothing newly attached
		const later = session.transcript.openTurn( 'turn-2', 2 );
		session.transcript.append( { at: 2, kind: 'user', text: 'follow-up' }, later );

		// Riding only newly attached files would empty this, leaving an earlier attachment unreachable.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
	} );

	it( 'includes attachments still pending, so a file rides on the turn it was attached to', () => {
		const session = sessionWith( fileEntry( 'a.ts' ) );
		session.pendingEntries.push( fileEntry( 'b.ts' ) );

		// Pending sits outside the transcript until a turn drains it; pre-drain state must not be counted twice.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts', 'b.ts' ] );
	} );

	it( 'returns REMOVED entries, which are still riding', () => {
		const session = sessionWith( fileEntry( 'a.ts', true ) );

		// Removal is an intent until the compaction that executes it; filtering here would copy that rule and split the tiers.
		expect( session.projectedAttachments() ).toHaveLength( 1 );
		expect( projectedText( session ) ).toContain( 'a.ts' );
	} );

	// A failed turn is the only thing that drops a turn out of `windowed()`; a file on it stays attached.
	it( 'drops a file whose turn does not ride, because that turn FAILED', () => {
		const session = sessionWith( fileEntry( 'a.ts' ), fileEntry( 'b.ts' ) );
		session.transcript.failTurn( 'turn-1' );

		// It is still ATTACHED — the gutter must show it, or there is no way to reach it — but it does not
		// ride, because its turn does not.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'b.ts' ] );
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts', 'b.ts' ] );
	} );

	it( 'drops a file whose turn was COMPACTED, so history is not paid for twice', () => {
		const session = sessionWith( fileEntry( 'a.ts' ), fileEntry( 'b.ts' ) );
		session.bindCompactions( [ {
			id:            'c1',
			sessionId:     'session-1',
			createdAt:     10,
			fromTurnId:    'turn-1',
			throughTurnId: 'turn-1',
			summary:       'the first exchange',
			model:         'test',
			tokensIn:      0,
			tokensOut:     0
		} ] );
		session.transcript.compactThrough( 'turn-1' );

		// The summary stands in for that turn; re-sending its file would pay for the same history twice.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'b.ts' ] );
		// Unlike the failed-turn case, a compacted turn is one-way, so its chip leaves the gutter too.
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'b.ts' ] );
	} );

	it( 'agrees with what wireMessages actually sends on a replaying tier', () => {
		const session = sessionWith( fileEntry( 'a.ts' ), fileEntry( 'b.ts', true ) );
		const wire = JSON.stringify( session.wireMessages() );

		// The two tiers must agree on which files ride, including a removed one whose intent neither acts on.
		expect( session.projectedAttachments().some( ( a ) => a.name === 'a.ts' ) ).toBe( true );
		expect( wire ).toContain( 'C:/repo/a.ts' );
		expect( wire ).toContain( 'C:/repo/b.ts' );
		expect( projectedText( session ) ).toContain( 'C:/repo/b.ts' );
	} );
} );
