import { describe, expect, it } from 'vitest';

import { KcdEdit } from '../KcdEdit';
import { KcdContext } from '../KcdContext';

/** A habit's default why-text, rewritten in its document ( plan agents-own-behaviour, task 61 ). */

const BODY = '<dl data-kcd-frontmatter><dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">kept</dd></dl>'
	+ '<h1>kept</h1>'
	+ '<section data-kcd-section="why"><h3>Why</h3><p>when the old reason applied</p><p>and a second line</p></section>'
	+ '<section data-kcd-section="action"><h3>Action</h3><p>do the kept thing</p></section>';

describe( 'KcdEdit.setHabitWhy', () => {

	it( 'rewrites the Why section to one paragraph, keeping its heading and every other section', () => {
		const next = KcdEdit.setHabitWhy( BODY, '  when a new reason applies  ' )!;

		expect( KcdContext.habitSections( next )[ 'why' ]?.text ).toBe( 'when a new reason applies' );
		expect( next ).toContain( '<h3>Why</h3>' );
		expect( next ).not.toContain( 'a second line' );
		expect( KcdContext.habitSections( next )[ 'action' ]?.text ).toContain( 'do the kept thing' );
	} );

	it( 'escapes what it writes', () => {
		const next = KcdEdit.setHabitWhy( BODY, 'when <b>markup</b> & friends arrive' )!;

		expect( next ).not.toContain( '<b>' );
		expect( KcdContext.habitSections( next )[ 'why' ]?.text ).toBe( 'when <b>markup</b> & friends arrive' );
	} );

	it( 'refuses a blank why, and a habit with no Why section', () => {
		expect( KcdEdit.setHabitWhy( BODY, '   ' ) ).toBeNull();
		expect( KcdEdit.setHabitWhy( '<h1>bare</h1><section data-kcd-section="action"><p>x</p></section>', 'when' ) ).toBeNull();
	} );
} );
