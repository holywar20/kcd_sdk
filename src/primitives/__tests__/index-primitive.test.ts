import { describe, it, expect } from 'vitest';
import { classifyRelPath, IndexObject, PlanObject } from '../index';

// ── B1: context/ → reference, for any parent ─────────────────────────────────

describe( 'classifyRelPath — context/ rule', () => {
	it( 'classifies a lens context file as reference', () => {
		expect( classifyRelPath( '_Claude/lenses/render/context/debug-design-layer.md' ) ).toBe( 'reference' );
	} );

	it( 'classifies a generator context file as reference (not generator)', () => {
		expect( classifyRelPath( '_Claude/generators/gen-x/context/idiom-source.md' ) ).toBe( 'reference' );
	} );

	it( 'does not sweep in a folder merely named context-notes', () => {
		expect( classifyRelPath( '_Claude/references/context-notes/foo.md' ) ).toBe( 'reference' );
	} );
} );

// ── B2: index is a first-class type ──────────────────────────────────────────

describe( 'classifyRelPath — index rule', () => {
	it( 'classifies any index.md as index, regardless of folder', () => {
		expect( classifyRelPath( '_Claude/plans/index.md' ) ).toBe( 'index' );
		expect( classifyRelPath( '_Claude/references/index.md' ) ).toBe( 'index' );
	} );
} );

describe( 'IndexObject', () => {
	const INDEX_MD = `---\ntype: index\n---\n\n# Plans Index\n\n| Plan | Lens |\n|---|---|\n`;

	it( 'parses with no required sections', () => {
		const obj = IndexObject.parse( INDEX_MD, '_Claude/plans/index.md' );
		expect( obj.getType() ).toBe( 'index' );
		expect( obj.getRole() ).toBe( 'know' );
	} );

	it( 'rejects a wrong frontmatter type', () => {
		const wrong = `---\ntype: plan\n---\n\n# Not an index\n`;
		expect( () => IndexObject.parse( wrong, '_Claude/plans/index.md' ) ).toThrow();
	} );
} );

// ── B3: plan validator relax (status-aware Phases) ───────────────────────────

describe( 'PlanObject — status-aware structure', () => {
	it( 'accepts a completed plan with only ## Goal', () => {
		const md = `---\ntype: plan\nstatus: complete\n---\n\n## Goal\nshipped\n`;
		expect( () => PlanObject.parse( md, '_Claude/plans/plans_complete/x.md' ) ).not.toThrow();
	} );

	it( 'still requires ## Phases on a live (active) plan', () => {
		const md = `---\ntype: plan\nstatus: active\n---\n\n## Goal\nin flight\n`;
		expect( () => PlanObject.parse( md, '_Claude/plans/x.md' ) ).toThrow();
	} );

	it( 'no longer requires ## Approach', () => {
		const md = `---\ntype: plan\nstatus: active\n---\n\n## Goal\nin flight\n\n## Phases\n1. go\n`;
		expect( () => PlanObject.parse( md, '_Claude/plans/x.md' ) ).not.toThrow();
	} );
} );
