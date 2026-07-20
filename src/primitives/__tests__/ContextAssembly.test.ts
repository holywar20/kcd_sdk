import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import '../index';   // registers every type's fromSerialized hydrator ( fromHtml/load need the real subclass, not the base fallback )
import { LensObject } from '../framework/LensObject';
import { ContextAssembler } from '../framework/ContextAssembler';
import { SlotResolver } from '../framework/SlotResolver';
import { KCDPrimitive } from '../framework/KCDPrimitive';
import { Agent } from '../../agent/Agent';
import type { ReaderFn, TaggedBlock } from '../types';

const ROOT = 'C:/fixtures/root';

const LENS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture for ContextAssembler integration tests.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<h1>Fixture Lens</h1>
<p>Its identity lede.</p>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-slot="reference" data-kcd-mode="suggested"><span data-kcd-field="what" data-kcd-type="text">Reference A</span><a data-kcd-field="where" data-kcd-type="path" href="ref-a.html">a</a><span data-kcd-field="why" data-kcd-type="text">reason A</span></div>
<div data-kcd-slot="reference" data-kcd-mode="suggested"><span data-kcd-field="what" data-kcd-type="text">Reference B</span><a data-kcd-field="where" data-kcd-type="path" href="ref-b.html">b</a><span data-kcd-field="why" data-kcd-type="text">reason B</span></div>
</section>
</section>
<section data-kcd-region="care">
<section data-kcd-section="purpose">
<p>Care identity prose.</p>
</section>
</section>
</article>
</body></html>
`;

// Two references the lens slots at `suggested`. Under LINKS-ONLY dredge their bodies ( "From Reference
// A/B." ) never ride — they surface only as routing rows in the lens's own References table. The bodies
// stay in the fixture so a regression that re-introduced full-text dredge would surface them.
const refHtml = ( slug: string, label: string ) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Reference</title></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">${ slug }</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A reference fixture.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-section="shared" data-kcd-merge-key="shared-key">
<p>From ${ label }.</p>
</section>
</article>
</body></html>
`;

const INJECTED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Injected</title></head>
<body>
<article data-kcd="reference">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">injected-note</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A session-injected reference.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">reference</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-section="body">
<p>Dropped-in-context content.</p>
</section>
</article>
</body></html>
`;

const FILES: Record<string, string> = {
	'lens.html':  LENS_HTML,
	'ref-a.html': refHtml( 'ref-a', 'Reference A' ),
	'ref-b.html': refHtml( 'ref-b', 'Reference B' ),
};

const read: ReaderFn = ( absPath ) => {
	const rel = absPath.replace( /\\/g, '/' ).split( '/' ).pop()!;
	const content = FILES[ rel ];
	if ( content === undefined ) throw new Error( `fixture missing: ${ absPath }` );
	return content;
};

function loadFixtureLens(): LensObject {
	return LensObject.load( `${ ROOT }/lens.html`, { projectRoot: ROOT, read, depth: 2 } );
}

describe( 'LensObject.getContextBlocks + ContextAssembler — Phase 2 integration', () => {
	it( 'sorts Care ahead of Know, regardless of document order', () => {
		const lens = loadFixtureLens();
		const out = lens.serializeForContext();
		expect( out.indexOf( 'Care identity prose.' ) ).toBeLessThan( out.indexOf( 'reason A' ) );
	} );

	it( 'dredge is links-only — the referenced bodies never ride, only their routing rows do', () => {
		const lens = loadFixtureLens();
		const out = lens.serializeForContext();
		expect( out ).not.toContain( 'From Reference A.' );
		expect( out ).not.toContain( 'From Reference B.' );
		expect( out ).toContain( '- Reference A — reason A (ref-a.html)' );
	} );

	it( 'the lens\'s own References section merges into ONE routing table too — the implicit section merge key, not just explicit data-kcd-merge-key groups', () => {
		const lens = loadFixtureLens();
		const out = lens.serializeForContext();
		// both rows land in the SAME block, joined tight — proves the implicit `routing:references` key
		expect( out ).toContain( '- Reference A — reason A (ref-a.html)\n- Reference B — reason B (ref-b.html)' );
	} );

	it( 'sinks an injected node\'s blocks after every non-injected block, even though Care is elsewhere in load order', () => {
		const lens = loadFixtureLens();
		// Built through fromHtml so it carries real projected content, not a hand-rolled stub —
		// exactly what `addInjected` receives from the "drop context onto the agent" GUI hook.
		const realInjected = KCDPrimitive.fromHtml( INJECTED_HTML, `${ ROOT }/injected.html` );
		lens.addInjected( realInjected );
		const out = lens.serializeForContext();

		const injectedIdx = out.indexOf( 'Dropped-in-context content.' );
		const careIdx     = out.indexOf( 'Care identity prose.' );
		const knowIdx     = out.indexOf( '- Reference A — reason A' );   // the routing row, links-only
		expect( injectedIdx ).toBeGreaterThan( careIdx );
		expect( injectedIdx ).toBeGreaterThan( knowIdx );
	} );

	it( 'the References routing table sinks below the lens identity, but still above injected', () => {
		const lens = loadFixtureLens();
		const realInjected = KCDPrimitive.fromHtml( INJECTED_HTML, `${ ROOT }/injected.html` );
		lens.addInjected( realInjected );
		const out = lens.serializeForContext();

		const careIdx     = out.indexOf( 'Care identity prose.' );
		const routingIdx  = out.indexOf( '- Reference A — reason A' );
		const injectedIdx = out.indexOf( 'Dropped-in-context content.' );
		expect( routingIdx ).toBeGreaterThan( careIdx );
		expect( injectedIdx ).toBeGreaterThan( routingIdx );
	} );

	it( 'never throws on an unloaded lens\'s stubBlock — silently omitted, unlike the throwing serializeForContext guard', () => {
		const bare = KCDPrimitive.fromHtml( LENS_HTML, `${ ROOT }/lens.html` ) as LensObject;
		expect( bare.stubBlock() ).toBeNull();
	} );

	it( 'off mode is excluded from the synthetic stub block, and never dredged — on mode gets both a stub row and a dredge skip', () => {
		// Links only in POLICY, deliberately with no authored routing-table text of their own (a bare
		// <a> with no data-kcd-slot never reaches KcdParse.policy — every policy entry comes from an
		// authored slot, and that slot's own text always renders via the artifact's own content
		// regardless of mode). stubBlock() is the generic net for policy entries; this proves `off`
		// is excluded from it while `on` (the default) still shows up there.
		const offHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Off Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">off-fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">Proves off-mode exclusion.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-slot="reference" data-kcd-mode="off"><span data-kcd-field="what" data-kcd-type="text">Disabled Reference</span><a data-kcd-field="where" data-kcd-type="path" href="ref-off.html">off</a><span data-kcd-field="why" data-kcd-type="text">turned off</span></div>
<div data-kcd-slot="reference"><span data-kcd-field="what" data-kcd-type="text">Default Reference</span><a data-kcd-field="where" data-kcd-type="path" href="ref-on.html">on</a><span data-kcd-field="why" data-kcd-type="text">default on-mode</span></div>
</section>
</section>
</article>
</body></html>
`;
		const readOff: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'off-lens.html' ) ) return offHtml;
			throw new Error( `unexpected read: ${ absPath }` );
		};
		const lens = LensObject.load( path.join( ROOT, 'off-lens.html' ), { projectRoot: ROOT, read: readOff, depth: 2 } );

		// Neither mode ever dredges (fetches) its target in normal, non-eager assembly.
		expect( lens.getNodes().length ).toBe( 0 );

		const stub = lens.stubBlock();
		expect( stub?.text ).toContain( 'ref-on.html' );
		expect( stub?.text ).not.toContain( 'ref-off.html' );
	} );
} );

// ── TRANSITIONAL ( Bryan, 2026-07-12, ruling corrected ): the INTENT is that `on` = deck pointer
// ( routing row ) while `suggested` = an implicit injection whose body rides ( a "this matters" highlight
// the user operates ) — see LensObject.getContextBlocks' corrected model. The current `dredgeFrom` does
// NOT yet realize that for `suggested`; dredge is being reworked and is not canonical for habits. The
// assertions below pin the CURRENT ( transitional ) behavior so a change is visible, NOT the end-state.
// The one path that already rides a full body today is a session INJECT ( `addInjected` — a deliberate
// paste of context ), which projects through the same dense form as any other injected habit.

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' );   // kcd_sdk/src/primitives/__tests__ → repo root
const HABITS_DIR   = path.join( PROJECT_ROOT, '_Claude/habits' );

// NOTE: the link below sits in the KNOW region, not Do, even though a habit is a Do-role artifact.
// `KcdParse.policy()` no longer cares which region carried the link (mode alone gates dredging), but
// the fixture keeps a Know-region placement anyway — SlotResolver only cares about a block's
// `habitClass`/`sourceLayer`, not which region carried the link, so this exercises the identical path.
const slotLensHtml = ( mode: 'on' | 'suggested' ) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Slot Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">slot-fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture proving SlotResolver against the real logging habits.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-slot="reference"${ mode === 'suggested' ? ' data-kcd-mode="suggested"' : '' } data-kcd-habit-class="session-logging"><span data-kcd-field="what" data-kcd-type="text">session-log-aggressive</span><a data-kcd-field="where" data-kcd-type="path" href="_Claude/habits/session-logging/session-log-aggressive.html">session-log-aggressive</a><span data-kcd-field="why" data-kcd-type="text">default</span></div>
</section>
</section>
</article>
</body></html>
`;

describe( 'habit slot dredge is links-only — no mode rides full text; only a session inject does', () => {
	it( 'default mode (on): neither session-log-aggressive (dredged) nor session-log-never (injected) contributes full text to the wire', () => {
		const readReal: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'slot-lens.html' ) ) return slotLensHtml( 'on' );
			return fs.readFileSync( absPath, 'utf-8' );
		};

		const lens = LensObject.load( path.join( PROJECT_ROOT, 'slot-lens.html' ), {
			projectRoot: PROJECT_ROOT, read: readReal, depth: 2
		} );

		// Dredged alone: `on` mode never fetches the target at all — its full text never appears.
		const beforeInject = lens.serializeForContext();
		expect( beforeInject ).not.toMatch( /breadcrumb a future session reads/ );

		// Inject the "never" pole too — same habit-class, higher specificity (injected > lens) — makes
		// no difference to the LENS's own on-mode slot; injection is a separate, deliberate act.
		const neverHabitPath = path.join( HABITS_DIR, 'session-logging/session-log-never.html' );
		const neverHabit = fs.readFileSync( neverHabitPath, 'utf-8' );
		lens.addInjected( KCDPrimitive.fromHtml( neverHabit, neverHabitPath ) );

		// addInjected is itself always a "suggested" act (the GUI "drop context" gesture) — the
		// injected habit's OWN body now rides as its DENSE four-field form ( KcdContext.projectHabit ),
		// not a raw dump, same as any other injected habit. What's proven here is that the LENS's
		// `on`-mode dredge stays silent while the injected habit's directive rides.
		const afterInject = lens.serializeForContext();
		expect( afterInject ).toContain( 'do nothing; write no line to' );
		expect( afterInject ).not.toMatch( /breadcrumb a future session reads/ );

		const slots = SlotResolver.describe( lens.getContextBlocks() );
		const resolution = slots.find( s => s.habitClass === 'session-logging' );
		expect( resolution?.winner.sourceLayer ).toBe( 'injected' );
	} );

	it( 'TRANSITIONAL: suggested habit is still links-only today ( intent is it rides — pending the dredge rework )', () => {
		const readReal: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'slot-lens.html' ) ) return slotLensHtml( 'suggested' );
			return fs.readFileSync( absPath, 'utf-8' );
		};

		const lens = LensObject.load( path.join( PROJECT_ROOT, 'slot-lens.html' ), {
			projectRoot: PROJECT_ROOT, read: readReal, depth: 2
		} );

		// Nothing dredged: the habit's full body never rides, but its what/where/why row survives.
		expect( lens.getNodes().length ).toBe( 0 );
		const ctx = lens.serializeForContext();
		expect( ctx ).not.toMatch( /breadcrumb a future session reads/ );
		expect( ctx ).toContain( 'session-log-aggressive' );
		expect( ctx ).toContain( '_Claude/habits/session-logging/session-log-aggressive.html' );
	} );
} );

// A lens with ONE `suggested` slot pointing at a plan. Same shape as slotLensHtml, but the target is a
// plan path — the point being that `suggested` ( which DOES ride full text for a habit or reference ) must
// still NOT ride full text for a plan: plans are link-only in assembled context ( Bryan, 2026-07-12 ).
const planSlotLensHtml = ( planHref: string ) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Plan Slot Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">plan-slot-fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture proving a suggested plan slot stays a routing link.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
<section data-kcd-region="know">
<section data-kcd-section="references">
<div data-kcd-slot="reference" data-kcd-mode="suggested"><span data-kcd-field="what" data-kcd-type="text">context-optimization plan</span><a data-kcd-field="where" data-kcd-type="path" href="${ planHref }">context-optimization</a><span data-kcd-field="why" data-kcd-type="text">the plan this lens tracks</span></div>
</section>
</section>
</article>
</body></html>
`;

describe( 'Agent.compile — the context-compiler surface: merged body first, then the manifest at the bottom', () => {
	const loadBase = (): Agent => {
		const lens = LensObject.load( path.join( PROJECT_ROOT, '_Claude/lenses/_lens_base.html' ), {
			projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ), depth: 2
		} );
		return Agent.create( { lenses: [ lens ] } );
	};

	it( 'trails with the manifest: the body leads, then a Files table and the References/Habits tables, each exactly once', () => {
		const out = loadBase().compile();
		// The manifest sinks to the bottom ( Bryan, 2026-07-12 ): the body prose leads, the affordance
		// surface trails. The Files table is the manifest head, so no body text follows it.
		expect( out.startsWith( '## Files' ) ).toBe( false );
		const filesIdx = out.indexOf( '## Files' );
		expect( filesIdx ).toBeGreaterThan( 0 );
		expect( out.indexOf( 'Philosophy' ) ).toBeLessThan( filesIdx );   // lens prose precedes the manifest
		for ( const header of [ '## Files', '## References', '## Habits' ] )
			expect( out.split( header ).length - 1 ).toBe( 1 );   // exactly one occurrence
		// The Files row is the lens's own vault-relative path ( the file ID ), not an absolute OS path.
		expect( out ).toContain( '(_Claude/lenses/_lens_base.html)' );
		expect( out ).not.toContain( 'C:/Code' );
	} );

	it( 'carries no per-artifact header, no Available-on-request stub, and no Know/Care/Do label', () => {
		const out = loadBase().compile();
		expect( out ).not.toContain( '# [lens]' );
		expect( out ).not.toContain( '# [habit]' );
		expect( out ).not.toContain( 'Available on request' );
		for ( const label of [ 'Know', 'Care', 'Do' ] )
			expect( out ).not.toMatch( new RegExp( `^#+\\s+${ label }\\s*$`, 'm' ) );
	} );
} );

describe( 'Agent.compiledBlocks — the no-drift lock (compiled-context plan, Phase 1)', () => {
	const loadBase = (): Agent => {
		const lens = LensObject.load( path.join( PROJECT_ROOT, '_Claude/lenses/_lens_base.html' ), {
			projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ), depth: 2
		} );
		return Agent.create( { lenses: [ lens ] } );
	};

	it( 'the joined block list is compile() — no separate logic tree, byte for byte', () => {
		const agent = loadBase();
		const joined = agent.compiledBlocks().map( b => b.text ).join( '\n\n' );
		expect( joined ).toBe( agent.compile() );
	} );

	it( '`after` extras trail the manifest, `before` extras lead the body — each behind its own divider', () => {
		const agent = loadBase();
		const lead  = { region: 'know', section: null, mergeKey: null, text: 'ROOT CONTEXT', sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null } as const;
		const trail = { region: 'know', section: null, mergeKey: null, text: 'TOOL MANIFEST', sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null } as const;
		const withExtras = agent.compiledBlocks( { before: [ lead ], after: [ trail ] } );
		expect( withExtras.map( b => b.text ).join( '\n\n' ) )
			.toBe( 'ROOT CONTEXT' + '\n\n---\n\n' + agent.compile() + '\n\n---\n\n' + 'TOOL MANIFEST' );
		expect( withExtras[ 0 ] ).toBe( lead );
		expect( withExtras[ withExtras.length - 1 ] ).toBe( trail );
	} );

	it( 'an empty extras segment contributes no stray divider', () => {
		const agent = loadBase();
		const trail = { region: 'know', section: null, mergeKey: null, text: 'TOOL MANIFEST', sourceLayer: 'agent', path: '', artifactType: 'unknown', habitClass: null } as const;
		const withExtras = agent.compiledBlocks( { after: [ trail ] } );
		expect( withExtras.map( b => b.text ).join( '\n\n' ) ).toBe( agent.compile() + '\n\n---\n\n' + 'TOOL MANIFEST' );
	} );

	it( 'the `memory` extra lands under its own # Memory band, above the Manifest (band model re-ratified 2026-07-13)', () => {
		const agent = loadBase();
		const out = agent.compiledBlocks( { memory: [ Agent.memoryBlock( '- claim — because reason' ) ] } ).map( b => b.text ).join( '\n\n' );
		const memHeadIdx  = out.indexOf( '# Memory' );
		const proseIdx    = out.indexOf( '- claim — because reason' );
		// NOTE: no `# Knowledge` band to index here — a base-only agent has no core content ( its
		// references/habits/contracts all hoist into the Manifest ), so there is no core tier to order
		// against. Asserting one existed is exactly what this test used to get wrong. The full
		// care→memory→core→manifest order is locked by the ContextAssembler.sort unit test above.
		const manifestIdx  = out.indexOf( '# Manifest' );   // the manifest band — base lens always has one
		expect( memHeadIdx ).toBeGreaterThan( -1 );
		expect( proseIdx ).toBeGreaterThan( memHeadIdx );      // prose rides under its heading
		expect( manifestIdx ).toBeGreaterThan( proseIdx );     // memory precedes the Manifest
	} );

	it( 'care groups by KIND — top-level "# Purpose" / "# Philosophy" bands, lenses as "## {lens}" sub-sections', () => {
		const agent = loadBase();
		const out = agent.compiledBlocks().map( b => b.text ).join( '\n\n' );
		expect( out ).not.toContain( '## Lenses' );          // no container band
		expect( out ).not.toMatch( / - Lens$/m );            // the per-lens band heading is gone
		expect( out ).toMatch( /^# Philosophy$/m );          // the KIND is the top-level band now
	} );

	it( 'per-block weight sums to the whole-string weight, for ANY consistent length function — the identity that makes a real tokenizer sum agree with the wire estimate', () => {
		const agent = loadBase();
		const blocks = agent.compiledBlocks();
		const sep = '\n\n';
		// Stand-in for the renderer's real `estimateTokens` — the SDK carries no tokenizer (plan Notes:
		// "compiledBlocks does not pull a tokenizer into @kcd/core"). Any consistent length function obeys
		// the same additive identity, which is the actual property being locked here.
		const weight = ( s: string ): number => s.length;
		const summed = blocks.reduce( ( a, b ) => a + weight( b.text ), 0 ) + Math.max( 0, blocks.length - 1 ) * weight( sep );
		expect( summed ).toBe( weight( blocks.map( b => b.text ).join( sep ) ) );
	} );
} );

describe( 'Know/Care/Do labels are stripped from compiled context — real deployed base lens', () => {
	it( 'the base lens compiles with no K/C/D region headings, but its sections and slot rows survive', () => {
		const p = path.join( PROJECT_ROOT, '_Claude/lenses/_lens_base.html' );
		const lens = KCDPrimitive.fromHtml( fs.readFileSync( p, 'utf-8' ), p );
		const joined = lens.getContextBlocks().map( b => b.text ).join( '\n\n' );

		for ( const label of [ 'Know', 'Care', 'Do' ] )
			expect( joined ).not.toMatch( new RegExp( `^#+\\s+${ label }\\s*$`, 'm' ) );

		// The region intros + placeholder sections are annotated `data-kcd-audience="human"` — kept in the
		// source for a human reader, dropped from compiled context ( Bryan, 2026-07-12 ).
		expect( joined ).not.toContain( 'Project-wide stance' );        // Care region intro
		expect( joined ).not.toContain( 'Universal execution layer' );  // Do region intro
		expect( joined ).not.toContain( 'No domains at base level' );   // Domains placeholder section
		expect( joined ).not.toContain( 'no working space of its own' );// Working Space placeholder section

		// Substance is untouched: section headings and the real slot rows still ride.
		expect( joined ).toMatch( /Philosophy/ );
		expect( joined ).toContain( 'write-approval-docs' );
	} );
} );

describe( 'plan slots are link-only — a plan never rides full text, even at `suggested`', () => {
	it( 'a suggested plan slot is not dredged into `nodes`; the plan survives as a routing row, and the plan file is never even read', () => {
		const planHref = '_Claude/plans/context-optimization.html';
		const planAbs  = path.join( PROJECT_ROOT, planHref ).replace( /\\/g, '/' );
		let planWasRead = false;

		const read: ReaderFn = ( absPath ) => {
			const norm = absPath.replace( /\\/g, '/' );
			if ( norm.endsWith( 'plan-slot-lens.html' ) ) return planSlotLensHtml( planHref );
			if ( norm === planAbs ) { planWasRead = true; throw new Error( 'plan must never be read: ' + norm ); }
			return fs.readFileSync( absPath, 'utf-8' );
		};

		const lens = LensObject.load( path.join( PROJECT_ROOT, 'plan-slot-lens.html' ), {
			projectRoot: PROJECT_ROOT, read, depth: 2
		} );

		// The plan was never fetched — no `plan` node in the graph, and the reader was never asked for it.
		expect( lens.getNodes().some( n => n.getType() === 'plan' ) ).toBe( false );
		expect( planWasRead ).toBe( false );

		// It survives as a routing link, not full text — the "Available on request" stub carries the href.
		const ctx = lens.serializeForContext();
		expect( ctx ).toContain( planHref );
	} );
} );

describe( 'ContextAssembler — unit', () => {
	const block = ( over: Partial<TaggedBlock> ): TaggedBlock => ( {
		region: 'know', section: null, mergeKey: null, text: 'x', sourceLayer: 'lens', path: 'p', artifactType: 'reference', habitClass: null, ...over
	} );

	it( 'preserves load order within a tier via a stable index tiebreak', () => {
		const blocks = [ block( { text: 'first', region: 'know' } ), block( { text: 'second', region: 'know' } ) ];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'first', 'second' ] );
	} );

	it( 'hoists care above know/do above injected', () => {
		const blocks = [
			block( { text: 'injected', sourceLayer: 'injected', region: 'know' } ),
			block( { text: 'know', region: 'know' } ),
			block( { text: 'care', region: 'care' } ),
		];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'care', 'know', 'injected' ] );
	} );

	it( 'merge keeps the first block\'s metadata and only grows its text', () => {
		const blocks = [
			block( { text: 'one', mergeKey: 'k', region: 'do' } ),
			block( { text: 'two', mergeKey: 'k', region: 'know' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged ).toHaveLength( 1 );
		expect( merged[ 0 ].region ).toBe( 'do' );
		expect( merged[ 0 ].text ).toBe( 'one\n\ntwo' );
	} );

	it( 'a lens\'s own content leads within a merge group, even if it loaded second', () => {
		const blocks = [
			block( { text: 'reference contribution', mergeKey: 'k', artifactType: 'reference' } ),
			block( { text: 'lens contribution', mergeKey: 'k', artifactType: 'lens' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged ).toHaveLength( 1 );
		expect( merged[ 0 ].text ).toBe( 'lens contribution\n\nreference contribution' );
	} );

	it( 'two non-lens members of a merge group keep their relative load order (stable tie)', () => {
		const blocks = [
			block( { text: 'first ref', mergeKey: 'k', artifactType: 'reference' } ),
			block( { text: 'second ref', mergeKey: 'k', artifactType: 'habit' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged[ 0 ].text ).toBe( 'first ref\n\nsecond ref' );
	} );

	// ── routing tier ( Bryan, 2026-07-11 ): References/Habits sections sink below core content,
	// above injected — and fuse across sources even with no authored data-kcd-merge-key. ──

	it( 'a references-section block sorts BELOW normal know/do content, but ABOVE injected', () => {
		const blocks = [
			block( { text: 'injected', sourceLayer: 'injected', region: 'know' } ),
			block( { text: 'routing', region: 'know', section: 'references' } ),
			block( { text: 'core', region: 'know' } ),
			block( { text: 'care', region: 'care' } ),
		];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'care', 'core', 'routing', 'injected' ] );
	} );

	it( 'a habits-section block sorts into the SAME routing tier as a references-section block', () => {
		const blocks = [
			block( { text: 'habits-routing', region: 'do', section: 'habits' } ),
			block( { text: 'refs-routing', region: 'know', section: 'references' } ),
			block( { text: 'core', region: 'do' } ),
		];
		const sorted = ContextAssembler.sort( blocks ).map( b => b.text );
		expect( sorted.indexOf( 'core' ) ).toBeLessThan( sorted.indexOf( 'habits-routing' ) );
		expect( sorted.indexOf( 'core' ) ).toBeLessThan( sorted.indexOf( 'refs-routing' ) );
	} );

	// ── memory tier ( band model re-ratified 2026-07-13 ): the system-fired preload now sits BETWEEN the
	// Lenses band ( care ) and Knowledge ( core ) — "after the lenses but before knowledge" ( Bryan ). ──

	it( 'a memory-section block sorts ABOVE core and BELOW care ( still above manifest and injected )', () => {
		const blocks = [
			block( { text: 'injected', sourceLayer: 'injected', region: 'know' } ),
			block( { text: 'manifest', region: 'know', section: 'references' } ),
			block( { text: 'memory', region: 'know', section: 'memory' } ),
			block( { text: 'core', region: 'know' } ),
			block( { text: 'care', region: 'care' } ),
		];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'care', 'memory', 'core', 'manifest', 'injected' ] );
	} );

	it( 'the band headings track the re-ratified names: care→(no wrapper), memory→Memory, core→Knowledge, manifest→Manifest', () => {
		// The care tier gets NO wrapper heading — care groups by KIND into top-level `# Purpose` / `# Philosophy`
		// bands ( built by `Agent.buildCareBands` ), not a "## Lenses" parent.
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.care ) ).toBeNull();
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.memory ) ).toBe( '# Memory' );
		// Knowledge / Manifest carry a directive line beneath the heading ( forced-read vs read-on-demand ).
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.core )!.split( '\n' )[ 0 ] ).toBe( '# Knowledge' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.core )! ).toContain( 'Required reading' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )!.split( '\n' )[ 0 ] ).toBe( '# Manifest' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )! ).toContain( 'Lookup surface' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.injected ) ).toBeNull();
	} );

	it( 'withBandHeadings splices "# Memory" ABOVE the Knowledge band ( memory now precedes core )', () => {
		const sorted = ContextAssembler.assembleBlocks( [
			block( { text: 'core', region: 'know' } ),
			block( { text: 'MEM', region: 'know', section: 'memory' } ),
		] );
		// Heading blocks can now carry a directive line; compare on the first line of each block.
		const firstLines = ContextAssembler.withBandHeadings( sorted ).map( b => b.text.split( '\n' )[ 0 ] );
		expect( firstLines ).toEqual( [ '# Memory', 'MEM', '# Knowledge', 'core' ] );
	} );

	it( 'two references-section blocks from different sources fuse into ONE routing table via their STRUCTURED rows — one heading, both rows, no repeated boilerplate', () => {
		const blocks = [
			block( {
				text: '### References\n\nSpecific named files. Load explicitly by path.\n\n- primary lens ref (a.html)',
				rows: [ { what: 'primary lens ref', where: 'a.html', why: '' } ],
				region: 'know', section: 'references', path: 'primary.html'
			} ),
			block( {
				text: '## References\n\n- secondary lens ref (b.html)',
				rows: [ { what: 'secondary lens ref', where: 'b.html', why: '' } ],
				region: 'know', section: 'references', path: 'secondary.html'
			} ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged ).toHaveLength( 1 );
		// ONE canonical heading, not each member's own ( ### vs ## ) — and the boilerplate intro line
		// ( it lives only in `text`, never in `rows` — the merge reads `rows`, not `text` ) is gone,
		// not just deduped: it was never structured data to begin with.
		expect( merged[ 0 ].text ).toBe( '## References\n- primary lens ref (a.html)\n- secondary lens ref (b.html)' );
	} );

	it( 'a routing merge dedupes rows by their real `where` IDENTITY — not a text pattern-match — keeping the first-seen framing', () => {
		const blocks = [
			block( {
				text: 'irrelevant — the merge reads rows, not text',
				rows: [ { what: 'Gates & connectors', where: 'gates-and-connectors.html', why: 'the boundary the orchestrator crosses' } ],
				region: 'know', section: 'references', path: 'primary.html'
			} ),
			block( {
				text: 'irrelevant — the merge reads rows, not text',
				rows: [ { what: 'gates-and-connectors', where: 'gates-and-connectors.html', why: 'the Gate/Truck model this pipeline crosses' } ],
				region: 'know', section: 'references', path: 'secondary.html'
			} ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged[ 0 ].text ).toBe( '## References\n- Gates & connectors — the boundary the orchestrator crosses (gates-and-connectors.html)' );
	} );

	it( 'a routing merge never mistakes a habits row for a references row — dedup is per merge GROUP, not global', () => {
		const row = { what: 'same-name', where: 'shared.html', why: '' };
		const blocks = [
			block( { text: 'x', rows: [ row ], region: 'know', section: 'references', path: 'r.html' } ),
			block( { text: 'x', rows: [ row ], region: 'do', section: 'habits', path: 'h.html' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged ).toHaveLength( 2 );
		expect( merged.every( b => b.text.includes( 'same-name' ) ) ).toBe( true );
	} );

	it( 'a routing row with no `where` dedupes on its what+why instead — has no other identity to key on', () => {
		const blocks = [
			block( { text: 'x', rows: [ { what: 'no link', where: '', why: 'still routed' } ], region: 'know', section: 'references', path: 'a.html' } ),
			block( { text: 'x', rows: [ { what: 'no link', where: '', why: 'still routed' } ], region: 'know', section: 'references', path: 'b.html' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged[ 0 ].text ).toBe( '## References\n- no link — still routed' );
	} );

	it( 'a references-section block and a habits-section block do NOT fuse with each other — different implicit keys', () => {
		const blocks = [
			block( { text: 'refs', region: 'know', section: 'references' } ),
			block( { text: 'habits', region: 'do', section: 'habits' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		expect( merged ).toHaveLength( 2 );
	} );

	it( 'an explicit data-kcd-merge-key still wins over the implicit routing key when both are set', () => {
		// ( a synthetic edge case — a real References section never carries a mergeKey today — proving
		// effectiveKey() prefers the authored key rather than silently overriding it. )
		const blocks = [
			block( { text: 'one', region: 'know', section: 'references', mergeKey: 'explicit' } ),
			block( { text: 'two', region: 'know', section: 'references', mergeKey: 'explicit' } ),
			block( { text: 'three', region: 'know', section: 'references' } ),
		];
		const merged = ContextAssembler.merge( blocks );
		// 'one'+'two' fuse on the explicit key; 'three' fuses separately via the implicit routing key —
		// two groups, not one, since 'three' never shares the explicit key.
		expect( merged ).toHaveLength( 2 );
		expect( merged.find( b => b.text.includes( 'one' ) )!.text ).toBe( 'one\n\ntwo' );
	} );
} );
