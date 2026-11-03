import { describe, it, expect } from 'vitest';
import { KcdValidate } from '../KcdValidate';

/**
 * TASK-329 — the optional `subject` frontmatter field (protocol §4): well-formedness only, exactly like
 * `todo` / `completed`. Occupancy — whether the declared path or package id actually resolves — is never
 * this validator's concern; a vacant or unresolved subject is not a defect at this layer.
 */
function doc( subjectField: string ): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>fixture</title><link rel="stylesheet" href="kcd.css"></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">subject-fixture</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A fixture for the subject field.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
${ subjectField }
</dl>
<h1>Fixture</h1>
<p>A body, so the empty-body rule never muddies these cases.</p>
</article>
</body>
</html>
`;
}

describe( 'KcdValidate — the optional `subject` frontmatter field', () => {

	it( 'validates exactly as before when no subject is declared', () => {
		const report = KcdValidate.validate( doc( '' ), { docRoot: '_Claude' } );
		expect( report.ok ).toBe( true );
		expect( report.errors ).toEqual( [] );
	} );

	it( 'a well-formed project-root-relative path passes, whether or not it resolves on disk', () => {
		const field = '<dt>subject</dt><dd data-kcd-field="subject" data-kcd-type="address">starmind/src/main/patrol/Subject.ts</dd>';
		const report = KcdValidate.validate( doc( field ), { docRoot: '_Claude' } );
		expect( report.ok ).toBe( true );
		expect( report.errors ).toEqual( [] );
	} );

	it( 'a well-formed but nonexistent subject still passes — occupancy is never checked here', () => {
		const field = '<dt>subject</dt><dd data-kcd-field="subject" data-kcd-type="address">nowhere/ghost-package</dd>';
		const report = KcdValidate.validate( doc( field ), { docRoot: '_Claude' } );
		expect( report.ok ).toBe( true );
		expect( report.errors ).toEqual( [] );
	} );

	it( 'an absolute path is refused — not well-formed', () => {
		const field = '<dt>subject</dt><dd data-kcd-field="subject" data-kcd-type="address">/etc/passwd</dd>';
		const report = KcdValidate.validate( doc( field ), { docRoot: '_Claude' } );
		expect( report.ok ).toBe( false );
		expect( report.errors.map( e => e.code ) ).toContain( 'bad-value' );
	} );

	it( 'a "../" escape is refused — not well-formed', () => {
		const field = '<dt>subject</dt><dd data-kcd-field="subject" data-kcd-type="address">../../outside.ts</dd>';
		const report = KcdValidate.validate( doc( field ), { docRoot: '_Claude' } );
		expect( report.ok ).toBe( false );
		expect( report.errors.map( e => e.code ) ).toContain( 'bad-value' );
	} );
} );
