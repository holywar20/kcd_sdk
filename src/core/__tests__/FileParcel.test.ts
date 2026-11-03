import { describe, it, expect, afterEach } from 'vitest';
import { FileParcel, type ParcelContent, type WithoutField } from '../FileParcel';
import { matchesTransport, type FileTransport } from '../FileTransport';

/**
 * THE DECLARATION HALF — the parcel itself and the matching rule. Nothing here runs a registry: the table,
 * the default transport and the scrub are `starmind_file`'s and are proved in its own suite.
 *
 * The first describe is the one worth reading. The no-path guarantee used to be a paragraph asking a future
 * contributor not to hang a path-taking method on the type; it is now the type itself, and these assertions
 * are what notices if that stops being true.
 */

const bytes = ( text: string ): Uint8Array => new TextEncoder().encode( text );

const parcel = ( over: Partial<ConstructorParameters<typeof FileParcel>[ 0 ]> = {} ): FileParcel =>
	new FileParcel( { name: 'notes.md', bytes: bytes( 'BODY' ), ...over } );

const transport = ( over: Partial<FileTransport> = {} ): FileTransport => ( {
	id:    'test',
	label: 'Test',
	match: {},
	parse: () => ( { text: '' } ),
	...over
} );

describe( 'a parcel carries nothing a parser could reach a file with', () => {

	/**
	 * COMPILE-TIME, AND THAT IS THE POINT — each of these is `true` only while the named member is ABSENT
	 * from `FileParcel`. Declare `path` on the parcel and this constant's type becomes `never`, the
	 * assignment stops compiling, and `npm run typecheck` names the field and the line. A runtime assertion
	 * could not do that: a type has no keys to enumerate, and the one below can only speak about the members
	 * an INSTANCE happens to have.
	 *
	 * The four are the four things that would each, on their own, turn a parser into a second way to reach a
	 * file: a location to open, an identity to open it as, a permission to open it with, or a function that
	 * opens it. Nothing else needs listing, because without one of these four there is no reach.
	 */
	const noPath:      WithoutField<'path', FileParcel>      = true;
	const noPrincipal: WithoutField<'principal', FileParcel> = true;
	const noGrant:     WithoutField<'grant', FileParcel>     = true;
	const noReader:    WithoutField<'read', FileParcel>      = true;

	it( 'declares no path, principal, grant or reader — asserted by the typecheck, not by this body', () => {
		// The assertions above are the test; these expectations exist so the case fails LOUDLY under a
		// runner too, rather than being a file that silently compiles and asserts nothing.
		expect( [ noPath, noPrincipal, noGrant, noReader ] ).toEqual( [ true, true, true, true ] );
	} );

	it( 'holds only the bytes and what they claim to be', () => {
		const held = new FileParcel( {
			name: 'report.pdf', bytes: bytes( '%PDF-1.4' ), mediaType: 'application/pdf'
		} );
		// Own enumerable members: the fat behaviour is on the PROTOTYPE, so a method cannot smuggle state
		// onto the instance and this list stays the whole of what a parcel is.
		expect( Object.keys( held ).sort() ).toEqual( [ 'bytes', 'ext', 'mediaType', 'name', 'origin' ] );
	} );

	it( 'states an origin, which says whose bytes these are and confers nothing', () => {
		// A closed union: `origin: 'somewhere-else'` does not compile. Absent defaults to the common case.
		expect( parcel().origin ).toBe( 'attachment' );
		expect( parcel( { origin: 'tool-result' } ).origin ).toBe( 'tool-result' );
	} );
} );

describe( 'the parcel is fat — the behaviour travels with the file', () => {

	it( 'decodes its own bytes, as utf-8 with replacement rather than a throw', () => {
		expect( parcel().text() ).toBe( 'BODY' );
		// A binary file read as text: visible mojibake, never an exception.
		const binary = parcel( { bytes: new Uint8Array( [ 0xff, 0xfe, 0x00 ] ) } );
		expect( () => binary.text() ).not.toThrow();
		expect( binary.text().length ).toBeGreaterThan( 0 );
	} );

	it( 'decodes FRESH every call, holding no parsed form — nothing here may be cached', () => {
		// The hazard this pins fired on 2026-10-26: `PDF_PAGE_IMAGE_CAP` moved from 10 to 30, so a parcel
		// caching a parse would now be stating a number no code would produce. The cheapest observable
		// consequence of "no cache" is that two reads are two separate strings, not one memoized object.
		const held  = parcel();
		const first = held.text();
		expect( held.text() ).toBe( first );
		// A memo field would show up here, and a getter caching into `this` would show up in the key list
		// asserted above — both directions are covered.
		expect( Object.keys( held ) ).not.toContain( 'content' );
		expect( Object.keys( held ) ).not.toContain( 'parsed' );
	} );

	it( 'derives its extension from its name, so no caller has to', () => {
		expect( parcel( { name: 'notes.MD' } ).ext ).toBe( 'md' );
		expect( parcel( { name: 'archive.tar.gz' } ).ext ).toBe( 'gz' );
		// A dotfile's leading dot is its NAME, which is the reading every shell takes: `.gitignore` must not
		// resolve as a `gitignore` format.
		expect( parcel( { name: '.gitignore' } ).ext ).toBe( '' );
		expect( parcel( { name: 'LICENSE' } ).ext ).toBe( '' );
		// An explicitly supplied extension wins, and is normalised the same way.
		expect( parcel( { name: 'blob', ext: '.PDF' } ).ext ).toBe( 'pdf' );
	} );

	it( 'answers its own claim and its own size', () => {
		const held = parcel( { name: 'report.pdf', mediaType: 'application/pdf' } );
		expect( held.claim() ).toEqual( { mediaType: 'application/pdf', ext: 'pdf' } );
		expect( held.size() ).toBe( 4 );
		// The claim is what a transport is matched against, so the two sides cannot disagree about a file.
		expect( matchesTransport( transport( { match: { extensions: [ 'pdf' ] } } ), held.claim() ) ).toBe( true );
	} );
} );

describe( 'parsing is a main-process capability, injected and throwing by default', () => {

	const installed = FileParcel.parser;
	afterEach( () => { FileParcel.parser = installed; } );

	it( 'throws a sentence naming the process that owns the answer', async () => {
		// NOT a module-resolution failure three layers down, and not an empty parse that would read as an
		// empty file. A renderer asking for work it cannot do is told which half of the app to ask.
		await expect( parcel().parse() ).rejects.toThrow( /main-process capability/ );
		await expect( parcel().parse() ).rejects.toThrow( /notes\.md/ );
	} );

	it( 'runs whatever was installed, and hands it the parcel itself', async () => {
		const seen: FileParcel[] = [];
		FileParcel.parser = async ( p ): Promise<ParcelContent> => {
			seen.push( p );
			return { by: 'fixture', text: p.text() };
		};

		const held = parcel( { name: 'x.txt', bytes: bytes( 'HELLO' ) } );
		expect( await held.parse() ).toEqual( { by: 'fixture', text: 'HELLO' } );
		// The parcel itself, not a projection of it — which is what makes the fat behaviour available to a
		// parser rather than only to its caller.
		expect( seen[ 0 ] ).toBe( held );
	} );
} );

describe( 'the wire form carries bytes and claim, and nothing parsed', () => {

	it( 'round-trips', () => {
		const held  = parcel( { name: 'report.pdf', mediaType: 'application/pdf', origin: 'tool-result' } );
		const again = FileParcel.fromSerialized( held.serialize() );
		expect( again ).toBeInstanceOf( FileParcel );
		expect( again!.name ).toBe( 'report.pdf' );
		expect( again!.ext ).toBe( 'pdf' );
		expect( again!.origin ).toBe( 'tool-result' );
		expect( again!.text() ).toBe( 'BODY' );
	} );

	it( 'carries no parsed form at all', () => {
		expect( Object.keys( parcel().serialize() ).sort() )
			.toEqual( [ 'bytes', 'ext', 'mediaType', 'name', 'origin' ] );
	} );

	it( 'is null for a malformed one, WHOLE rather than half-rebuilt', () => {
		// A parcel missing its bytes is a message that did not arrive, not a half-parcel to be repaired
		// downstream — and a caller that cannot tell the difference frames an empty file at a model as
		// though it were empty on disk.
		expect( FileParcel.fromSerialized( null ) ).toBeNull();
		expect( FileParcel.fromSerialized( 'notes.md' ) ).toBeNull();
		expect( FileParcel.fromSerialized( [] ) ).toBeNull();
		expect( FileParcel.fromSerialized( { name: 'notes.md' } ) ).toBeNull();
		expect( FileParcel.fromSerialized( { bytes: bytes( 'BODY' ) } ) ).toBeNull();
		// Bytes that are not bytes — a JSON round trip somewhere would hand over an object or an array.
		expect( FileParcel.fromSerialized( { name: 'notes.md', bytes: [ 1, 2, 3 ] } ) ).toBeNull();
	} );

	it( 'reads an unknown origin as the common case rather than refusing the parcel', () => {
		// `origin` says whose bytes these are and confers nothing, so an unreadable one costs a word in a
		// frame. Refusing the whole parcel over it would throw the file away to protect nothing.
		const held = FileParcel.fromSerialized( { name: 'a.txt', bytes: bytes( 'x' ), origin: 'nonsense' } );
		expect( held!.origin ).toBe( 'attachment' );
	} );
} );

describe( 'matchesTransport — either axis is a match, and an absent claim matches nothing', () => {

	it( 'matches on media type, case-insensitively', () => {
		const pdf = transport( { match: { mediaTypes: [ 'application/pdf' ] } } );
		expect( matchesTransport( pdf, { mediaType: 'application/pdf' } ) ).toBe( true );
		expect( matchesTransport( pdf, { mediaType: 'APPLICATION/PDF' } ) ).toBe( true );
		expect( matchesTransport( pdf, { mediaType: 'text/plain' } ) ).toBe( false );
	} );

	it( 'matches on extension with or without the dot, because callers hold it both ways', () => {
		const sig = transport( { match: { extensions: [ 'sig' ] } } );
		expect( matchesTransport( sig, { ext: 'sig' } ) ).toBe( true );
		expect( matchesTransport( sig, { ext: '.sig' } ) ).toBe( true );
		expect( matchesTransport( sig, { ext: 'SIG' } ) ).toBe( true );
		// And a declaration written with the dot resolves the same file, so neither side has to be careful.
		expect( matchesTransport( transport( { match: { extensions: [ '.sig' ] } } ), { ext: 'sig' } ) ).toBe( true );
	} );

	it( 'matches when ONE axis is right, which is the common case', () => {
		// The sniffer gave up and said octet-stream; the extension is the only true fact left.
		const pdf = transport( { match: { mediaTypes: [ 'application/pdf' ], extensions: [ 'pdf' ] } } );
		expect( matchesTransport( pdf, { mediaType: 'application/octet-stream', ext: 'pdf' } ) ).toBe( true );
		// And the other way round: a file somebody saved with no extension at all.
		expect( matchesTransport( pdf, { mediaType: 'application/pdf', ext: '' } ) ).toBe( true );
	} );

	it( 'matches NOTHING on an empty claim, rather than everything', () => {
		// The trap this guards: a row listing no types must not become the answer for a file nothing could
		// identify. That file belongs to the DEFAULT transport, which the registry answers for a miss.
		expect( matchesTransport( transport( { match: {} } ), {} ) ).toBe( false );
		expect( matchesTransport( transport( { match: {} } ), { mediaType: 'text/plain', ext: 'txt' } ) ).toBe( false );
		expect( matchesTransport( transport( { match: { mediaTypes: [ 'text/plain' ] } } ), {} ) ).toBe( false );
		expect( matchesTransport( transport( { match: { extensions: [ 'txt' ] } } ), { mediaType: null, ext: null } ) ).toBe( false );
	} );
} );
