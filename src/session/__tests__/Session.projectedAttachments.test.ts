import { describe, it, expect } from 'vitest';
import { Session } from '../Session';
import { Transcript, type Attachment } from '../TurnEntry';

/**
 * `projectedAttachments()` — what RIDES, as distinct from what is attached.
 *
 * The pair it belongs to is deliberately asymmetric and the asymmetry is the whole point:
 * `attachments()` answers "what is attached" for the gutter and includes everything, while this answers
 * "what rides" and obeys the window. A caller that reached for the wrong one either shows a file that
 * cannot be turned back on, or pays twice for history a compaction already summarised.
 *
 * It exists for the NON-REPLAYING tier. Every other caller gets attachments inside `wireMessages()`,
 * which projects the whole window; the harness tier is exempt from replaying that window and so asks for
 * this one part of it by name.
 *
 * The regression under it is real and shipped: the harness tier first rode only NEWLY-attached files, so
 * an attachment reached the model exactly once and nothing could reach it afterwards — no pointer, no
 * handle, no way for the agent to find the file again. The case that catches it is "a file attached on
 * turn one still rides on turn two", which nothing covered.
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

/** What the harness tier actually sends — the same TWO-turn throwaway projection it composes with. The
 *  split matters: everything already attached goes on a prior turn ( pointers ), and only what is being
 *  injected right now goes on the live one ( bodies ). Flattening both onto one turn would make every
 *  past attachment claim to be an injection, which is the bug this shape exists to avoid. */
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

		// THE regression. Riding only what was newly attached made this empty, so a file the user attached
		// three turns ago became unreachable — the agent was never told it existed.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
	} );

	it( 'includes attachments still pending, so a file rides on the turn it was attached to', () => {
		const session = sessionWith( fileEntry( 'a.ts' ) );
		session.pendingAttachments.push( fileEntry( 'b.ts' ) );

		// Pending lives outside the transcript until a turn drains it. The harness drains BEFORE projecting,
		// so this asserts the pre-drain state is not silently counted twice — `projectedAttachments` reads
		// the transcript only.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts', 'b.ts' ] );
	} );

	it( 'returns REMOVED entries, which are still riding', () => {
		const session = sessionWith( fileEntry( 'a.ts', true ) );

		// Filtering here would be a second copy of a rule that lives at compaction. A removal is an intent
		// until the pass that executes it, and until then the file rides exactly as it rode before — so this
		// tier must keep carrying it, or the two tiers disagree about what the model can see.
		expect( session.projectedAttachments() ).toHaveLength( 1 );
		expect( projectedText( session ) ).toContain( 'a.ts' );
	} );

	it( 'drops a file whose turn fell out of the retention window', () => {
		const session = sessionWith( fileEntry( 'a.ts' ), fileEntry( 'b.ts' ) );
		session.setPolicy( 'retention', { kind: 'lastN', n: 1 } );

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
			mode:          'on',
			tokensIn:      0,
			tokensOut:     0
		} ] );
		session.transcript.compactThrough( 'turn-1' );

		// The summary stands in for that turn now. Re-sending its file would pay for the same history
		// twice — the exact double-count the single-home attachment model exists to make impossible.
		expect( session.projectedAttachments().map( ( a ) => a.name ) ).toEqual( [ 'b.ts' ] );
		// And here the two lists AGREE, unlike the retention case above: a compacted turn is one-way, so its
		// chip leaves the gutter too rather than advertising context the model no longer has.
		expect( session.attachments().map( ( a ) => a.name ) ).toEqual( [ 'b.ts' ] );
	} );

	it( 'agrees with what wireMessages actually sends on a replaying tier', () => {
		const session = sessionWith( fileEntry( 'a.ts' ), fileEntry( 'b.ts', true ) );
		const wire = JSON.stringify( session.wireMessages() );

		// The two tiers must not disagree about which files ride — including the removed one, whose intent
		// neither tier acts on. This is what keeps ONE definition of an attachment across the whole app.
		expect( session.projectedAttachments().some( ( a ) => a.name === 'a.ts' ) ).toBe( true );
		expect( wire ).toContain( 'C:/repo/a.ts' );
		expect( wire ).toContain( 'C:/repo/b.ts' );
		expect( projectedText( session ) ).toContain( 'C:/repo/b.ts' );
	} );
} );
