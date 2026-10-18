import { describe, expect, it } from 'vitest';

import { KcdEdit } from '../KcdEdit';

/**
 * `sectionProse` / `setSection` — the read-write pair behind every prose editor in the app.
 *
 * THE LOAD-BEARING PROPERTY IS THE ROUND TRIP. `sectionProse` hands out a section's inner markup and
 * `setSection` takes it back, so read-then-write with no change must be an identity. The buffer is markup
 * rather than flattened text, so a table or an anchor survives being read and written back.
 */

const BODY =
	'<dl data-kcd-frontmatter><dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">alpha</dd></dl>'
	+ '<h1>alpha</h1>'
	+ '<section data-kcd-section="personality"><h3 data-kcd-heading>Personality</h3><p>Who alpha is.</p></section>'
	+ '<section data-kcd-section="philosophy"><h3 data-kcd-heading>Philosophy</h3><p>What alpha defends.</p><p>And a second line.</p></section>'
	+ '<section data-kcd-section="references"><h3 data-kcd-heading>References</h3><div data-kcd-table></div></section>';

/** The same document with no `philosophy` — the shape a lens written before that section existed has. */
const NO_PHILOSOPHY =
	'<dl data-kcd-frontmatter><dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">alpha</dd></dl>'
	+ '<h1>alpha</h1>'
	+ '<section data-kcd-section="personality"><h3 data-kcd-heading>Personality</h3><p>Who alpha is.</p></section>'
	+ '<section data-kcd-section="references"><h3 data-kcd-heading>References</h3><div data-kcd-table></div></section>';

const order = ( html: string ): string[] =>
	[ ...html.matchAll( /data-kcd-section="([^"]+)"/g ) ].map( m => m[ 1 ]! );

describe( 'KcdEdit.sectionProse', () => {

	it( 'hands back a section\'s inner markup without its heading', () => {
		const got = KcdEdit.sectionProse( BODY, 'philosophy' )!;

		expect( got ).toContain( 'What alpha defends.' );
		expect( got ).toContain( 'And a second line.' );
		// The heading is the section's NAME rendered, not its content. An editor that showed it would
		// invite somebody to rename a section by retyping a word, which is not what that would do.
		expect( got ).not.toContain( '<h3' );
	} );

	/** NULL AND '' ARE DIFFERENT ANSWERS, and the whole editor branches on which one it got. */
	it( 'tells a section that is absent from one that is present and empty', () => {
		expect( KcdEdit.sectionProse( BODY, 'nowhere' ) ).toBeNull();
		expect( KcdEdit.sectionProse(
			'<section data-kcd-section="philosophy"><h3>Philosophy</h3></section>', 'philosophy'
		) ).toBe( '' );
	} );
} );

describe( 'KcdEdit.setSection — rewriting a section that exists', () => {

	it( 'replaces the prose, keeps the heading, and leaves every other section alone', () => {
		const next = KcdEdit.setSection( BODY, 'philosophy', 'One new sentence.' )!;

		expect( next ).toContain( 'One new sentence.' );
		expect( next ).not.toContain( 'And a second line.' );
		expect( next ).toContain( '<h3 data-kcd-heading>Philosophy</h3>' );
		expect( next ).toContain( 'Who alpha is.' );
		expect( order( next ) ).toEqual( [ 'personality', 'philosophy', 'references' ] );
	} );

	it( 'takes plain text and authored block HTML by the same door', () => {
		const typed  = KcdEdit.setSection( BODY, 'philosophy', 'A plain line.' )!;
		const authored = KcdEdit.setSection( BODY, 'philosophy', '<p>A plain line.</p>' )!;

		expect( typed ).toBe( authored );
	} );

	/** Opening a buffer and closing it without typing must not be an edit. */
	it( 'is a no-op when the prose read back out is written back in', () => {
		const held = KcdEdit.sectionProse( BODY, 'philosophy' )!;
		const next = KcdEdit.setSection( BODY, 'philosophy', held )!;

		expect( KcdEdit.sectionProse( next, 'philosophy' ) ).toBe( held );
	} );

	/** Blank is a refusal, not a clear: an empty section trips the validator's `empty-section` rule. Removing a section is a different act. */
	it( 'refuses a blank buffer rather than emptying the section', () => {
		expect( KcdEdit.setSection( BODY, 'philosophy', '   ' ) ).toBeNull();
	} );
} );

describe( 'KcdEdit.setSection — creating a section the document does not carry', () => {

	/** Creation costs a `title`, so a machine caller editing an existing section cannot start authoring new ones by accident. */
	it( 'still refuses a missing section when no title is given', () => {
		expect( KcdEdit.setSection( NO_PHILOSOPHY, 'philosophy', 'Some stance.' ) ).toBeNull();
	} );

	it( 'creates it when a title is given, with that heading and the prose inside', () => {
		const next = KcdEdit.setSection( NO_PHILOSOPHY, 'philosophy', 'Some stance.', 'Philosophy' )!;

		expect( next ).toContain( 'data-kcd-section="philosophy"' );
		expect( next ).toContain( 'Philosophy' );
		expect( KcdEdit.sectionProse( next, 'philosophy' ) ).toContain( 'Some stance.' );
	} );

	/** PROSE BEFORE TABLES, the shape every artifact type here keeps. Appending blindly would file a
	 *  philosophy underneath the reference list of every lens that has one. */
	it( 'lands it BEFORE references when the document has a references section', () => {
		const next = KcdEdit.setSection( NO_PHILOSOPHY, 'philosophy', 'Some stance.', 'Philosophy' )!;

		expect( order( next ) ).toEqual( [ 'personality', 'philosophy', 'references' ] );
	} );

	it( 'appends at the end when there is no references section to sit above', () => {
		const bare = '<h1>alpha</h1>'
			+ '<section data-kcd-section="personality"><h3>Personality</h3><p>Who alpha is.</p></section>';
		const next = KcdEdit.setSection( bare, 'philosophy', 'Some stance.', 'Philosophy' )!;

		expect( order( next ) ).toEqual( [ 'personality', 'philosophy' ] );
	} );

	/** Refused before anything is built, so a stray change event on an empty editor cannot mint an empty section. */
	it( 'creates nothing for a blank buffer, even with a title', () => {
		expect( KcdEdit.setSection( NO_PHILOSOPHY, 'philosophy', '  ', 'Philosophy' ) ).toBeNull();
	} );

	it( 'does not create a second section on the next write', () => {
		const made = KcdEdit.setSection( NO_PHILOSOPHY, 'philosophy', 'First.', 'Philosophy' )!;
		const next = KcdEdit.setSection( made, 'philosophy', 'Second.', 'Philosophy' )!;

		expect( order( next ) ).toEqual( [ 'personality', 'philosophy', 'references' ] );
		expect( next ).toContain( 'Second.' );
		expect( next ).not.toContain( 'First.' );
	} );
} );
