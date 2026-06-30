import { describe, it, expect } from 'vitest';
import { classifyRelPath, IndexObject, PlanObject } from '../index';
import type { SerializedArtifact } from '../types';

// ── B1: context/ → reference, for any parent ─────────────────────────────────

describe( 'classifyRelPath — context/ rule', () => {
	it( 'classifies a lens context file as reference', () => {
		expect( classifyRelPath( '_Claude/lenses/render/context/debug-design-layer.html' ) ).toBe( 'reference' );
	} );

	it( 'classifies a generator context file as reference (not generator)', () => {
		expect( classifyRelPath( '_Claude/generators/gen-x/context/idiom-source.html' ) ).toBe( 'reference' );
	} );

	it( 'does not sweep in a folder merely named context-notes', () => {
		expect( classifyRelPath( '_Claude/references/context-notes/foo.html' ) ).toBe( 'reference' );
	} );
} );

// ── B2: nav-index is a first-class type ──────────────────────────────────────

describe( 'classifyRelPath — nav-index rule', () => {
	it( 'classifies any nav-index.html as nav-index, regardless of folder', () => {
		expect( classifyRelPath( '_Claude/plans/nav-index.html' ) ).toBe( 'nav-index' );
		expect( classifyRelPath( '_Claude/references/nav-index.html' ) ).toBe( 'nav-index' );
	} );

	it( 'classifies a non-index file by its folder, not the nav rule', () => {
		expect( classifyRelPath( '_Claude/plans/some-plan.html' ) ).toBe( 'plan' );
	} );
} );

// ── Hydration dispatch — the wire seam rebuilds the right prototype ──────────
// Conformance ( required frontmatter / sections ) is now enforced at parse time by KcdValidate,
// not per-subclass; what these subclasses still own is their type + role, reached via the hydrator.

const wire = ( type: string ): SerializedArtifact => ( {
	path:        `_Claude/x/${ type }.html`,
	type:        type as SerializedArtifact['type'],
	frontmatter: { type },
	sections:    {},
	body:        '',
	links:       [],
} );

describe( 'IndexObject', () => {
	it( 'hydrates as a nav-index in the know role', () => {
		const obj = IndexObject.fromSerialized( wire( 'nav-index' ) );
		expect( obj.getType() ).toBe( 'nav-index' );
		expect( obj.getRole() ).toBe( 'know' );
	} );
} );

describe( 'PlanObject', () => {
	it( 'hydrates as a plan in the know role', () => {
		const obj = PlanObject.fromSerialized( wire( 'plan' ) );
		expect( obj.getType() ).toBe( 'plan' );
		expect( obj.getRole() ).toBe( 'know' );
	} );
} );
