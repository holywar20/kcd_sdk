import { describe, it, expect } from 'vitest';
import { Transcript, frameFile, framePointer, frameFolder, frameTool, grantSubject, type Attachment, type Grant, type TurnEntry } from '../TurnEntry';

/**
 * Attachments — injection, and what an attachment reads as once it is history.
 *
 * The model, in one sentence: an attachment stores a PATH and never a body, and what rides is decided by
 * WHERE it sits rather than by a setting. The live turn carries the file; every prior turn carries a
 * pointer the agent can follow. Removal is the one thing position does NOT decide: it is an intent recorded
 * on the entry and executed by the next compaction, so a removed file keeps riding until then.
 *
 * That makes position the clock, which is why there is no mode here to test. The three-state this replaced
 * ( suggested · on · off ) needed a persisted setting, a control to change it, a write to persist the
 * change, and a rule for what happened when the write failed. All four went away when the body did.
 *
 * The case worth guarding hardest is the LIVE/PRIOR split: get it wrong in one direction and a file rides
 * whole on every turn forever, get it wrong in the other and the model is told about a file whose contents
 * it never saw and cannot reach.
 */

type FileEntry  = Extract<Attachment, { kind: 'injected-file' }>;
type ImageEntry = Extract<Attachment, { kind: 'image' }>;

function fileEntry( name: string, bytes = 400 ): FileEntry {
	return { at: 1, kind: 'injected-file', path: `C:/repo/${ name }`, name, mediaType: 'text/plain', bytes };
}

function imageEntry( name: string ): ImageEntry {
	return { at: 2, kind: 'image', path: `C:/repo/${ name }`, name, mediaType: 'image/png', width: 100, height: 75 };
}

/** A transcript with the given attachments on a PRIOR turn and an empty live turn after it — the ordinary
 *  case, where a file was injected earlier and the user is now saying something else. */
function afterInjection( ...entries: Grant[] ): Transcript {
	const t = new Transcript();
	const past = t.openTurn( 'turn-1', 0 );
	for ( const e of entries ) t.append( e, past );
	const live = t.openTurn( 'turn-2', 1 );
	t.append( { at: 2, kind: 'user', text: 'and now this' }, live );
	return t;
}

/** A transcript whose LIVE turn carries the injection — what the orchestrator builds at send time, with
 *  `contents` already hydrated by main. */
function injecting( entry: Attachment, contents = 'FILE BODY' ): Transcript {
	const t = new Transcript();
	const live = t.openTurn( 'turn-1', 0 );
	t.append( { ...entry, contents } as TurnEntry, live );
	t.append( { at: 1, kind: 'user', text: 'look at this' }, live );
	return t;
}

function wireText( t: Transcript ): string {
	return JSON.stringify( t.wireMessages() );
}

describe( 'injection — the live turn carries the file', () => {
	it( 'rides the file WHOLE when it is being injected', () => {
		expect( wireText( injecting( fileEntry( 'a.ts' ) ) ) ).toContain( 'FILE BODY' );
	} );

	it( 'rides an image as an IMAGE block, not as text', () => {
		const blocks = injecting( imageEntry( 'shot.png' ), 'BASE64BYTES' ).wireMessages()
			.flatMap( ( m ) => typeof m.content === 'string' ? [] : m.content.map( ( b ) => b.type ) );

		// The one place the two kinds genuinely diverge, and the reason they stay two kinds rather than one
		// discriminated on mediaType: this branch is a compile-time guarantee, not a string comparison.
		expect( blocks ).toContain( 'image' );
	} );

	it( 'degrades to the POINTER for a tier that cannot carry an image block', () => {
		const t = injecting( imageEntry( 'shot.png' ), 'BASE64BYTES' );
		const wire = JSON.stringify( t.wireMessages( { imagesAsText: true } ) );

		// The failure this exists to stop: a text-only model, or a CLI transport, receiving NOTHING because
		// each tier dropped the block it could not translate. A handle it can act on beats silence.
		expect( wire ).not.toContain( 'BASE64BYTES' );
		expect( wire ).toContain( 'C:/repo/shot.png' );
	} );

	it( 'TELLS THE MODEL when the file could not be read, rather than sending silence', () => {
		// `contents` absent on the live turn means main's read failed. A user who injects a file and gets nothing
		// reasonably assumes it arrived — and the agent then answers from thin air.
		const t = new Transcript();
		const live = t.openTurn( 'turn-1', 0 );
		t.append( fileEntry( 'gone.ts' ), live );

		const wire = wireText( t );
		expect( wire ).toContain( 'injection failed' );
		expect( wire ).toContain( 'C:/repo/gone.ts' );
	} );
} );

describe( 'after injection — every prior turn carries a pointer', () => {
	it( 'stops sending the body once the turn is history', () => {
		const wire = wireText( afterInjection( { ...fileEntry( 'a.ts' ), contents: 'FILE BODY' } as Attachment ) );

		// Even with stale `contents` still on the object, position decides. This is what makes injection
		// one-shot without a flag to clear, a write to persist it, or a failed send that burns it.
		expect( wire ).not.toContain( 'FILE BODY' );
		expect( wire ).toContain( 'C:/repo/a.ts' );
	} );

	it( 'carries the PATH, because a pointer the reader cannot follow is a dead link', () => {
		expect( wireText( afterInjection( fileEntry( 'a.ts' ) ) ) ).toContain( framePointer( 'a.ts', 'C:/repo/a.ts' ) );
	} );

	it( 'degrades an image to text — there is no cheap form of an image', () => {
		const blocks = afterInjection( imageEntry( 'shot.png' ) ).wireMessages()
			.flatMap( ( m ) => typeof m.content === 'string' ? [] : m.content.map( ( b ) => b.type ) );

		expect( blocks ).not.toContain( 'image' );
		expect( wireText( afterInjection( imageEntry( 'shot.png' ) ) ) ).toContain( 'C:/repo/shot.png' );
	} );

	it( 're-injecting is a NEW entry, and the account keeps both', () => {
		const t = afterInjection( fileEntry( 'a.ts' ) );
		const live = t.allTurns()[ 1 ];
		t.append( { ...fileEntry( 'a.ts' ), contents: 'FRESH BODY' } as TurnEntry, live );

		// The user pointed at it twice; the transcript says so. The old entry stays a pointer, the new one
		// rides whole — no mutation of history to express "they wanted it again".
		expect( t.attachments() ).toHaveLength( 2 );
		expect( wireText( t ) ).toContain( 'FRESH BODY' );
	} );
} );

describe( 'removal — an intent, executed at compaction', () => {
	it( 'keeps riding UNCHANGED until a compaction executes it', () => {
		const wire = wireText( afterInjection( { ...fileEntry( 'a.ts' ), removed: true } ) );

		// The case worth guarding: honouring removal on the wire rewrites a prior turn to save a pointer, and
		// re-prefills everything after it. That is the trade backwards, and it is the whole reason removal is
		// deferred rather than immediate. What changes right away is what the PERSON sees.
		expect( wire ).toContain( framePointer( 'a.ts', 'C:/repo/a.ts' ) );
	} );

	it( 'shows as removed to the person, on the same entry the wire reads plainly', () => {
		const t = afterInjection( { ...fileEntry( 'a.ts' ), removed: true } );

		// Two readers, one entry, and the divergence is the design: the itinerary is told at once, the model
		// is told by the file simply not being there after the next pass.
		expect( t.turnRows()[ 0 ].rows.some( ( r ) => r.text.includes( 'removed' ) ) ).toBe( true );
	} );

	it( 'STAYS in the account and stays visible to the gutter', () => {
		const t = afterInjection( { ...fileEntry( 'a.ts' ), removed: true } );

		// Removal is never an edit to what happened. The chip survives until compaction so the user can change
		// their mind and find the file again.
		expect( t.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts' ] );
	} );

	it( 'still costs a pointer, because it is still riding', () => {
		// Pricing it at zero the moment the user asked reports a saving that has not happened yet — and the
		// gauge answers "what will the next send cost", which is unchanged until the pass runs.
		expect( Transcript._entryTokens( { ...fileEntry( 'a.ts', 40_000 ), removed: true } ) ).toBeGreaterThan( 0 );
	} );
} );

describe( 'the gutter list — what is still IN CONTEXT', () => {
	/** Two turns, each carrying one attachment, with only the FIRST compacted. */
	function twoTurns( first: Attachment, second: Attachment ): Transcript {
		const t = new Transcript();
		t.append( first, t.openTurn( 'turn-1', 0 ) );
		t.append( second, t.openTurn( 'turn-2', 1 ) );
		t.compactThrough( 'turn-1' );
		return t;
	}

	it( 'drops a COMPACTED turn\'s attachments, removed or not', () => {
		const t = twoTurns( fileEntry( 'gone.ts' ), fileEntry( 'here.ts' ) );

		// A summary stands in for that turn, so its files stopped riding when it did. A chip still sitting
		// there would claim context the model no longer has, which is the whole reason this list is not just
		// "every attachment ever".
		expect( t.attachments().map( ( a ) => a.name ) ).toEqual( [ 'here.ts' ] );
	} );

	it( 'KEEPS a removed file whose turn no summary covers yet', () => {
		const t = twoTurns( fileEntry( 'old.ts' ), { ...fileEntry( 'marked.ts' ), removed: true } );

		// Removal alone does not drop the chip: the file is still riding as a pointer, so hiding it would
		// lie in the other direction. The tile wears the red tone until its turn is compacted.
		expect( t.attachments().map( ( a ) => a.name ) ).toEqual( [ 'marked.ts' ] );
	} );

	it( 'leaves the dropped entry IN THE TRANSCRIPT, so the file can be found again', () => {
		const t = twoTurns( fileEntry( 'gone.ts' ), fileEntry( 'here.ts' ) );

		// The half that makes this a projection rather than a deletion. Nothing was destroyed to clear the
		// gutter — the user scrolls back to where they injected it and injects it again.
		expect( t.allTurns()[ 0 ].entries ).toHaveLength( 1 );
		expect( t.turnRows()[ 0 ].rows.some( ( r ) => r.text.includes( 'gone.ts' ) ) ).toBe( true );
	} );

	it( 'does NOT hide a file the retention window merely narrowed past', () => {
		const t = new Transcript();
		t.append( fileEntry( 'a.ts' ), t.openTurn( 'turn-1', 0 ) );
		t.append( fileEntry( 'b.ts' ), t.openTurn( 'turn-2', 1 ) );

		// Compaction is the line, not the window. Retention is a policy the user can widen back, so hiding on
		// it would make chips flicker in and out as the window slides.
		expect( t.windowed( { kind: 'lastN', n: 1 } ).allTurns() ).toHaveLength( 1 );
		expect( t.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts', 'b.ts' ] );
	} );
} );

describe( 'pricing — from metadata, never from contents', () => {
	it( 'prices a prior attachment as a POINTER', () => {
		const priced = Transcript._entryTokens( fileEntry( 'a.ts', 40_000 ) );

		expect( priced ).toBeGreaterThan( 0 );
		expect( priced ).toBeLessThan( 100 );
	} );

	it( 'prices a LIVE injection off its byte count', () => {
		// bytes ÷ 4, from the stat taken at attach time — no file is opened to answer this.
		expect( Transcript._entryTokens( fileEntry( 'a.ts', 4000 ), true ) ).toBe( 1000 );
	} );

	it( 'prices a live image by PIXEL AREA, not by bytes', () => {
		const small = Transcript._entryTokens( { ...imageEntry( 's.png' ), width: 10, height: 10 }, true );
		const large = Transcript._entryTokens( { ...imageEntry( 'l.png' ), width: 1000, height: 1000 }, true );

		expect( large ).toBeGreaterThan( small );
	} );

	it( 'defaults to the PRIOR price, because the gauge answers "what will the next send cost"', () => {
		// On the next send every entry that already exists is history. Only a pending injection is live.
		expect( Transcript._entryTokens( fileEntry( 'a.ts', 40_000 ) ) )
			.toBeLessThan( Transcript._entryTokens( fileEntry( 'a.ts', 40_000 ), true ) );
	} );
} );

describe( 'the itinerary and the compactor see the handle', () => {
	it( 'shows the pointer on the row, never a body it does not have', () => {
		const row = afterInjection( fileEntry( 'a.ts' ) ).turnRows()[ 0 ].rows
			.find( ( r ) => r.kind === 'injected-file' )!;

		expect( row.text ).toContain( 'C:/repo/a.ts' );
	} );

	it( 'reads an IMAGE row as its pointer too — the itinerary ships no bytes', () => {
		const row = afterInjection( imageEntry( 'shot.png' ) ).turnRows()[ 0 ].rows
			.find( ( r ) => r.kind === 'image' )!;

		// Shipping the image across IPC to redraw a list is what this whole design exists to stop, and the
		// row carries no handle either — a surface that wants a thumbnail earns one when it exists.
		expect( row.text ).toContain( 'C:/repo/shot.png' );
	} );

	it( 'NEVER hands the compactor a body — structurally, not by rule', () => {
		// There is no stored body to digest, so a summary cannot assert knowledge the conversation never had.
		// The guard that used to enforce this, and the head-truncation that used to bound it, both went away.
		expect( Transcript.digestText( fileEntry( 'a.ts' ) ) ).toBe( framePointer( 'a.ts', 'C:/repo/a.ts' ) );
	} );

	it( 'hands the compactor NOTHING for a removed file, so the caller drops the row', () => {
		expect( Transcript.digestText( { ...fileEntry( 'a.ts' ), removed: true } ) ).toBe( '' );
	} );
} );

describe( 'frameFile / framePointer', () => {
	it( 'frames an injected body so the model reads it as pinned material, not as the user speaking', () => {
		expect( frameFile( 'a.ts', 'BODY' ) ).toContain( 'a.ts' );
		expect( frameFile( 'a.ts', 'BODY' ) ).toContain( 'BODY' );
	} );

	it( 'names the path in a pointer, and says the contents are NOT in context', () => {
		const pointer = framePointer( 'a.ts', 'C:/repo/a.ts' );

		expect( pointer ).toContain( 'C:/repo/a.ts' );
		expect( pointer ).toContain( 'not in context' );
	} );
} );

/**
 * Folders and tools are GRANTS on the same terms a file is — the point of giving them entry kinds rather
 * than a table of their own. What is guarded here is that they inherit the model rather than imitating it:
 * the same decay, the same list, the same removal, the same subject vocabulary.
 */
describe( 'folder and tool grants — the same rule, different payloads', () => {
	const folder: Grant = { at: 1, kind: 'injected-folder', path: 'C:/repo/src', name: 'src' };
	const tool:   Grant = { at: 1, kind: 'injected-tool',   server: 'starmind_files', name: 'read_file' };

	it( 'a folder rides its reference, naming the path and what to do about it', () => {
		const wire = wireText( afterInjection( folder ) );

		expect( wire ).toContain( 'C:/repo/src' );
		expect( wire ).toContain( 'list it' );
	} );

	it( 'a tool rides its QUALIFIED reference — two servers may ship one name', () => {
		expect( wireText( afterInjection( tool ) ) ).toContain( 'starmind_files.read_file' );
	} );

	it( 'both land in the deck beside files, because the deck is one list', () => {
		const t = afterInjection( fileEntry( 'a.ts' ), folder, tool );

		expect( t.attachments().map( ( a ) => a.name ) ).toEqual( [ 'a.ts', 'src', 'read_file' ] );
	} );

	it( 'a tool\'s subject is derived from its pair, never stored beside it', () => {
		// The stored fields are server + name; a subject column would be a second copy of what these two
		// already say, and the copy is what goes stale.
		expect( grantSubject( tool ) ).toBe( 'starmind_files.read_file' );
		expect( grantSubject( folder ) ).toBe( 'C:/repo/src' );
	} );

	it( 'removal reads the same for every kind — one intent, executed at compaction', () => {
		expect( Transcript.digestText( { ...folder, removed: true } ) ).toBe( '' );
		expect( Transcript.digestText( { ...tool,   removed: true } ) ).toBe( '' );
		expect( Transcript.digestText( folder ) ).toBe( frameFolder( 'C:/repo/src' ) );
		expect( Transcript.digestText( tool ) ).toBe( frameTool( 'starmind_files', 'read_file' ) );
	} );

	it( 'prices as its reference, since neither has a compiled payload yet', () => {
		// The listing and the schema are the backing tool's job and have not landed. Pricing them as
		// anything richer would be the gauge reporting a cost nobody pays.
		expect( Transcript._entryTokens( folder, true ) ).toBe( Transcript._entryTokens( folder, false ) );
	} );
} );
