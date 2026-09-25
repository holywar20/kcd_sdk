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
import type { SlotRow } from '../../core/html/KcdContext';

const ROOT = 'C:/fixtures/root';

/** A flat lens body: its references first ( to prove the sort does not follow document order ), then who it is. */
const LENS_BODY = ( rows: string, personality = 'A fixture personality.' ) =>
	`<section data-kcd-section="references">\n${ rows }\n</section>\n`
	+ `<section data-kcd-section="personality">\n<p>${ personality }</p>\n</section>\n`
	+ '<section data-kcd-section="philosophy">\n<p>A fixture philosophy.</p>\n</section>';

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
${ LENS_BODY( '<div data-kcd-slot="reference" data-kcd-mode="load"><span data-kcd-field="what" data-kcd-type="text">Reference A</span><a data-kcd-field="where" data-kcd-type="path" href="ref-a.html">a</a><span data-kcd-field="why" data-kcd-type="text">reason A</span></div>\n'
	+ '<div data-kcd-slot="reference" data-kcd-mode="load"><span data-kcd-field="what" data-kcd-type="text">Reference B</span><a data-kcd-field="where" data-kcd-type="path" href="ref-b.html">b</a><span data-kcd-field="why" data-kcd-type="text">reason B</span></div>', 'Care identity prose.' ) }
</article>
</body></html>
`;

// Two references the lens slots at `load`. Under LINKS-ONLY dredge their bodies ( "From Reference
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
		const realInjected = KCDPrimitive.fromHtml( INJECTED_HTML, `${ ROOT }/injected.html` , '_Claude');
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
		const realInjected = KCDPrimitive.fromHtml( INJECTED_HTML, `${ ROOT }/injected.html` , '_Claude');
		lens.addInjected( realInjected );
		const out = lens.serializeForContext();

		const careIdx     = out.indexOf( 'Care identity prose.' );
		const routingIdx  = out.indexOf( '- Reference A — reason A' );
		const injectedIdx = out.indexOf( 'Dropped-in-context content.' );
		expect( routingIdx ).toBeGreaterThan( careIdx );
		expect( injectedIdx ).toBeGreaterThan( routingIdx );
	} );

	it( 'never throws on an unloaded lens\'s stubBlock — silently omitted, unlike the throwing serializeForContext guard', () => {
		const bare = KCDPrimitive.fromHtml( LENS_HTML, `${ ROOT }/lens.html` , '_Claude') as LensObject;
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
${ LENS_BODY( '<div data-kcd-slot="reference" data-kcd-mode="off"><span data-kcd-field="what" data-kcd-type="text">Disabled Reference</span><a data-kcd-field="where" data-kcd-type="path" href="ref-off.html">off</a><span data-kcd-field="why" data-kcd-type="text">turned off</span></div>\n'
	+ '<div data-kcd-slot="reference"><span data-kcd-field="what" data-kcd-type="text">Default Reference</span><a data-kcd-field="where" data-kcd-type="path" href="ref-on.html">on</a><span data-kcd-field="why" data-kcd-type="text">default on-mode</span></div>' ) }
</article>
</body></html>
`;
		const readOff: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'off-lens.html' ) ) return offHtml;
			throw new Error( `unexpected read: ${ absPath }` );
		};
		const lens = LensObject.load( path.join( ROOT, 'off-lens.html' ), { projectRoot: ROOT, read: readOff, depth: 2 } );

		// This fixture is loaded non-eager, which gates the dredge off entirely — so neither mode fetches
		// its target here. That is the LOADER, not the mode; see the settled-mode note further down.
		expect( lens.getNodes().length ).toBe( 0 );

		const stub = lens.stubBlock();
		expect( stub?.text ).toContain( 'ref-on.html' );
		expect( stub?.text ).not.toContain( 'ref-off.html' );
	} );
} );

// ── SLOT MODE, SETTLED ( ruled 2026-07-12, corrected the same day; the transitional note this replaces
// retired 2026-09-17 ). `on` = a deck pointer, where the routing row is the slot's whole contribution;
// `load` = an implicit injection whose body rides — the "this matters" highlight the user operates.
// `dredgeFrom` realizes both, so the assertions below pin the END STATE, not a way-station.
//
// WHAT THE MODE RULE RIDES ON IS THE LOADER, and reading one for the other is what kept the old note
// alive past its subject. A non-eager lens dredges NOTHING, so `on` and `load` are indistinguishable
// there — a routing row each and no body between them. Everything that COMPILES loads eager ( see
// `LensLoadOptions.eager` ), and that is where the two modes part company. Both halves are asserted
// below: a test that only ever loaded lazily reports the loader's silence as the mode's meaning, which
// is how `Vault.buildAgent.test.ts` came to compare an eager compile against a lazy one for six weeks.
//
// A session INJECT ( `addInjected` — a deliberate paste of context ) rides a full body under either
// loader, and projects through the same dense form as any other injected habit.

const PROJECT_ROOT = path.resolve( __dirname, '../../../..' );   // kcd_sdk/src/primitives/__tests__ → repo root
const HABITS_DIR   = path.join( PROJECT_ROOT, '_Claude/habits' );

// THE REAL LENS THESE SUITES LOAD IS THE DEPLOYED ONE, and it was `documentation` until 2026-09-25, when
// the package realignment renamed every superseded lens to `retire-*` and took this file down as a block.
// It is `sm-documentation` now — the package lens that succeeded it.
//
// DO NOT "FIX" THIS BY EDITING `InstallManifest`. That table's `lenses/documentation` row names the
// CANONICAL lens in the shipped substrate ( starmind/resources/substrate/lenses/documentation ), which is
// a different artifact that has not moved and must not. Canonical and deployed diverge by design; this
// vault's rename says nothing about what a fresh vault is given.

// NOTE: the link below sits in the KNOW region, not Do, even though a habit is a Do-role artifact.
// `KcdParse.policy()` no longer cares which region carried the link (mode alone gates dredging), but
// the fixture keeps a Know-region placement anyway — SlotResolver only cares about a block's
// `habitClass`/`sourceLayer`, not which region carried the link, so this exercises the identical path.
const slotLensHtml = ( mode: 'on' | 'load' ) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Slot Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">slot-fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture proving SlotResolver against the real logging habits.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
${ LENS_BODY( `<div data-kcd-slot="reference"${ mode === 'load' ? ' data-kcd-mode="load"' : '' } data-kcd-habit-class="log-action"><span data-kcd-field="what" data-kcd-type="text">log-action</span><a data-kcd-field="where" data-kcd-type="path" href="_Claude/habits/log-action/log-action-often.html">log-action-often</a><span data-kcd-field="why" data-kcd-type="text">default</span></div>` ) }
</article>
</body></html>
`;

describe( 'habit slot dredge follows MODE once the lens is loaded the way a compile loads it', () => {
	it( 'on mode, eagerly loaded: the habit IS fetched and its body still never rides — the inject is what carries one', () => {
		const readReal: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'slot-lens.html' ) ) return slotLensHtml( 'on' );
			return fs.readFileSync( absPath, 'utf-8' );
		};

		const lens = LensObject.load( path.join( PROJECT_ROOT, 'slot-lens.html' ), {
			projectRoot: PROJECT_ROOT, read: readReal, depth: 2, eager: true
		} );

		// EAGER, so the target IS fetched and the object exists — `on` needs it for the Atlas graph and the
		// reader drawer. What `on` withholds is inclusion: the fetched habit is marked not-included, so the
		// routing row is its whole contribution and its full text never appears.
		expect( lens.getNodes().length ).toBe( 1 );
		const beforeInject = lens.serializeForContext();
		expect( beforeInject ).not.toMatch( /WRITE THE FINDING, NOT THE ACTIVITY/ );

		// Inject the "ask" setting too — same habit-class, higher specificity (injected > lens) — makes
		// no difference to the LENS's own on-mode slot; injection is a separate, deliberate act.
		const askHabitPath = path.join( HABITS_DIR, 'log-action/log-action-ask.html' );
		const askHabit = fs.readFileSync( askHabitPath, 'utf-8' );
		lens.addInjected( KCDPrimitive.fromHtml( askHabit, askHabitPath , '_Claude') );

		// addInjected is itself always a "load" act (the GUI "drop context" gesture) — the
		// injected habit's OWN body now rides as its DENSE four-field form ( KcdContext.projectHabit ),
		// not a raw dump, same as any other injected habit. What's proven here is that the LENS's
		// `on`-mode dredge stays silent while the injected habit's directive rides.
		const afterInject = lens.serializeForContext();
		expect( afterInject ).toContain( 'nobody asked, write nothing' );
		expect( afterInject ).not.toMatch( /WRITE THE FINDING, NOT THE ACTIVITY/ );

		const slots = SlotResolver.describe( lens.getContextBlocks() );
		const resolution = slots.find( s => s.habitClass === 'log-action' );
		expect( resolution?.winner.sourceLayer ).toBe( 'injected' );
	} );

	it( 'load mode, eagerly loaded: the habit body RIDES — and stays links-only under a non-eager load', () => {
		const readReal: ReaderFn = ( absPath ) => {
			if ( absPath.replace( /\\/g, '/' ).endsWith( 'slot-lens.html' ) ) return slotLensHtml( 'load' );
			return fs.readFileSync( absPath, 'utf-8' );
		};

		const load = ( eager: boolean ) => LensObject.load( path.join( PROJECT_ROOT, 'slot-lens.html' ), {
			projectRoot: PROJECT_ROOT, read: readReal, depth: 2, eager
		} );

		// EAGER — the loader every compile uses. This is the one case where a slot's body actually rides:
		// the habit is dredged AND marked included, so its full directive joins the context.
		const eager = load( true );
		expect( eager.getNodes().length ).toBe( 1 );
		const eagerCtx = eager.serializeForContext();
		expect( eagerCtx ).toMatch( /WRITE THE FINDING, NOT THE ACTIVITY/ );

		// NON-EAGER — links-only, and NOT because the mode says so: the whole dredge is gated off, so there
		// is no fetched object for any mode to include. Asserted beside its pair, because on its own this
		// reads as `load` meaning nothing — which is exactly the reading that outlived the dredge rework.
		const lazy = load( false );
		expect( lazy.getNodes().length ).toBe( 0 );
		const lazyCtx = lazy.serializeForContext();
		expect( lazyCtx ).not.toMatch( /WRITE THE FINDING, NOT THE ACTIVITY/ );

		// The routing row survives under both — that is what a mode never takes away.
		for ( const ctx of [ eagerCtx, lazyCtx ] ) {
			expect( ctx ).toContain( 'log-action' );
			expect( ctx ).toContain( '_Claude/habits/log-action/log-action-often.html' );
		}
	} );
} );

// A lens with ONE `load` slot pointing at a plan. Same shape as slotLensHtml, but the target is a
// plan path — the point being that `load` ( which DOES ride full text for a habit or reference ) must
// still NOT ride full text for a plan: plans are link-only in assembled context ( Bryan, 2026-07-12 ).
const planSlotLensHtml = ( planHref: string ) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Plan Slot Fixture Lens</title></head>
<body>
<article data-kcd="lens">
<dl data-kcd-frontmatter>
<dt>name</dt><dd data-kcd-field="name" data-kcd-type="slug">plan-slot-fixture-lens</dd>
<dt>description</dt><dd data-kcd-field="description" data-kcd-type="text">A lens fixture proving a load-mode plan slot stays a routing link.</dd>
<dt>type</dt><dd data-kcd-field="type" data-kcd-type="enum">lens</dd>
<dt>status</dt><dd data-kcd-field="status" data-kcd-type="enum">active</dd>
</dl>
${ LENS_BODY( `<div data-kcd-slot="reference" data-kcd-mode="load"><span data-kcd-field="what" data-kcd-type="text">context-optimization plan</span><a data-kcd-field="where" data-kcd-type="path" href="${ planHref }">context-optimization</a><span data-kcd-field="why" data-kcd-type="text">the plan this lens tracks</span></div>` ) }
</article>
</body></html>
`;

describe( 'Agent.compile — the context-compiler surface: merged body first, then the manifest at the bottom', () => {
	const loadBase = (): Agent => {
		const lens = LensObject.load( path.join( PROJECT_ROOT, '_Claude/lenses/sm-documentation/sm-documentation.html' ), {
			projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ), depth: 2
		} );
		return Agent.create( { lenses: [ lens ] } );
	};

	it( 'trails with the manifest: the body leads, then a Files table and the References table, each exactly once', () => {
		const out = loadBase().compile();
		// The manifest sinks to the bottom ( Bryan, 2026-07-12 ): the body prose leads, the affordance
		// surface trails. The Files table is the manifest head, so no body text follows it.
		expect( out.startsWith( '## Files' ) ).toBe( false );
		const filesIdx = out.indexOf( '## Files' );
		expect( filesIdx ).toBeGreaterThan( 0 );
		expect( out.indexOf( 'Philosophy' ) ).toBeLessThan( filesIdx );   // lens prose precedes the manifest
		for ( const header of [ '## Files', '## References' ] )
			expect( out.split( header ).length - 1 ).toBe( 1 );   // exactly one occurrence
		// A lens carries no habits any more — behaviour is the agent's.
		expect( out ).not.toContain( '## Habits' );
		// The Files row is the lens's own vault-relative path ( the file ID ), not an absolute OS path.
		expect( out ).toContain( '(_Claude/lenses/sm-documentation/sm-documentation.html)' );
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
		const lens = LensObject.load( path.join( PROJECT_ROOT, '_Claude/lenses/sm-documentation/sm-documentation.html' ), {
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

	it( 'an injection lands in the injected band, under its own package heading', () => {
		const agent = loadBase();
		const out = agent.compiledBlocks( {
			contributed: [ Agent.contributionBlock( { id: 'semantic_memory', heading: 'Memory', text: '- claim — because reason' } ) ]
		} ).map( b => b.text ).join( '\n\n' );
		const headIdx     = out.indexOf( '## Memory' );
		const proseIdx    = out.indexOf( '- claim — because reason' );
		const manifestIdx = out.indexOf( '# Manifest' );
		expect( headIdx ).toBeGreaterThan( -1 );
		expect( proseIdx ).toBeGreaterThan( headIdx );        // prose rides under its own heading
		// LAST IN THE BODY, not last on the wire: the manifest tables are lifted out of the body and
		// appended after it regardless of tier, so an injection precedes them.
		expect( headIdx ).toBeLessThan( manifestIdx );
	} );

	it( 'two packages injecting keep their own headings rather than collapsing into one band', () => {
		// The reason a contribution carries its heading in the TEXT instead of letting `withBandHeadings`
		// splice one: that splices ONE heading per tier, and every injection shares a tier. Collapsing two
		// packages under a single heading would leave a reader unable to tell which package said what.
		const agent = loadBase();
		const out = agent.compiledBlocks( { contributed: [
			Agent.contributionBlock( { id: 'a_pkg', heading: 'Memory',  text: 'FROM A' } ),
			Agent.contributionBlock( { id: 'b_pkg', heading: 'Nudges',  text: 'FROM B' } )
		] } ).map( b => b.text ).join( '\n\n' );
		expect( out ).toContain( '## Memory' );
		expect( out ).toContain( '## Nudges' );
		expect( out.indexOf( 'FROM A' ) ).toBeLessThan( out.indexOf( '## Nudges' ) );
	} );

	it( 'an injection keeps its own identity in the breakdown', () => {
		// THE DEFECT THIS PINS: `segmentKey` reads a section-less block as STRUCTURAL — a divider or heading
		// with no identity — and folds its text into a neighbour. Injections sort LAST, so there is no
		// neighbour after them and the text landed on the previous segment instead. On the wire and
		// misattributed in the breakdown is worse than absent, because the round drawer reads as correct.
		const agent = loadBase();
		agent.bindEnv( { contributions: [ { id: 'semantic_memory', heading: 'Memory', text: 'INJECTED TEXT' } ] } );
		const seg = agent.contextSegments().find( ( x ) => x.text.includes( 'INJECTED TEXT' ) );
		expect( seg ).toBeDefined();
		expect( seg!.source ).toBe( 'injection' );
		expect( seg!.label ).toBe( 'semantic_memory' );
	} );

	it( 'a package that injected nothing leaves no heading behind', () => {
		const agent = loadBase();
		const out = agent.compiledBlocks( { contributed: [] } ).map( b => b.text ).join( '\n\n' );
		expect( out ).not.toContain( '## Memory' );
	} );

	it( 'bindEnv carries injections onto the agent', () => {
		const agent = loadBase();
		agent.bindEnv( { contributions: [ { id: 'semantic_memory', heading: 'Memory', text: '- a claim' } ] } );
		expect( agent.contributions ).toHaveLength( 1 );
		expect( agent.compiledContext().map( b => b.text ).join( '\n\n' ) ).toContain( '- a claim' );
	} );

	it( 'the per-package toggle withholds one injection and leaves the others alone', () => {
		const agent = loadBase();
		agent.system[ 'contributions' ] = { b_pkg: { enabled: false } };
		agent.bindEnv( { contributions: [
			{ id: 'a_pkg', heading: 'Kept',    text: 'KEPT TEXT' },
			{ id: 'b_pkg', heading: 'Dropped', text: 'DROPPED TEXT' }
		] } );
		const out = agent.compiledContext().map( b => b.text ).join( '\n\n' );
		expect( out ).toContain( 'KEPT TEXT' );
		expect( out ).not.toContain( 'DROPPED TEXT' );
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

describe( 'a real deployed lens, flat', () => {
	it( 'compiles with no Know / Care / Do label, and its sections and reference rows survive', () => {
		const p = path.join( PROJECT_ROOT, '_Claude/lenses/sm-documentation/sm-documentation.html' );
		const lens = KCDPrimitive.fromHtml( fs.readFileSync( p, 'utf-8' ), p , '_Claude');
		const joined = lens.getContextBlocks().map( b => b.text ).join( '\n\n' );

		for ( const label of [ 'Know', 'Care', 'Do' ] )
			expect( joined ).not.toMatch( new RegExp( `^#+\\s+${ label }\\s*$`, 'm' ) );

		expect( joined ).toMatch( /Philosophy/ );
		expect( joined ).toContain( 'kcd_framework' );
		expect( joined ).not.toContain( 'write-files-scoped' );   // its habits moved to the agents
	} );
} );

describe( 'plan slots are link-only — a plan never rides full text, even at `load`', () => {
	it( 'a load-mode plan slot is not dredged into `nodes`; the plan survives as a routing row, and the plan file is never even read', () => {
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

	// ── the injected tier: where every package's contribution lands ( 2026-09-07 ) ──
	// The `memory` TIER IS NOW UNREACHED. It was where the one named contributor's band sorted, between
	// care and core — "after the lenses but before knowledge". Contributions are injections now, identified
	// by package and landing last, so nothing routes to tier 1 any more. The entry survives so that
	// restoring a high band is a routing decision rather than a renumbering.

	it( 'an injected block sorts LAST, below care, core and the manifest', () => {
		const blocks = [
			block( { text: 'injected', sourceLayer: 'injected', region: 'know' } ),
			block( { text: 'manifest', region: 'know', section: 'references' } ),
			block( { text: 'core', region: 'know' } ),
			block( { text: 'care', region: 'care' } ),
		];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'care', 'core', 'manifest', 'injected' ] );
	} );

	it( 'a bare `memory` section is ordinary core content — the name routes nothing', () => {
		// The point of the contributor seam: `section` carries no ranking authority. A block called 'memory'
		// is core content, exactly like a block called anything else.
		const blocks = [
			block( { text: 'memory', region: 'know', section: 'memory' } ),
			block( { text: 'care', region: 'care' } ),
		];
		expect( ContextAssembler.sort( blocks ).map( b => b.text ) ).toEqual( [ 'care', 'memory' ] );
		expect( ContextAssembler.tierOf( block( { text: 'm', region: 'know', section: 'memory' } ) ) ).toBe( ContextAssembler.TIER.core );
	} );

	it( 'the band headings track the re-ratified names: care→(no wrapper), core→Knowledge, manifest→Manifest', () => {
		// The care tier gets NO wrapper heading — care groups by KIND into top-level `# Purpose` / `# Philosophy`
		// bands ( built by `Agent.buildCareBands` ), not a "## Lenses" parent.
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.care ) ).toBeNull();
		// Knowledge / Manifest carry a directive line beneath the heading ( forced-read vs read-on-demand ).
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.core )!.split( '\n' )[ 0 ] ).toBe( '# Knowledge' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.core )! ).toContain( 'Required reading' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )!.split( '\n' )[ 0 ] ).toBe( '# Manifest' );
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.manifest )! ).toContain( 'Lookup surface' );
		// NO tier heading for injected: each injection carries its OWN heading, because they share a tier.
		expect( ContextAssembler.bandHeading( ContextAssembler.TIER.injected ) ).toBeNull();
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

describe( 'the Grants section reaches the wire, or does not ride at all', () => {

	// A MANIFEST SECTION IS MERGED, and the merge re-renders from each block's structured `rows` rather
	// than parsing rendered text back apart. Grants were bound as a composed STRING — which looked right,
	// read right, and contributed no rows — so every canonized grant was dropped between the session and
	// the wire and the heading arrived alone. The empty `## Grants` an agent reported was the whole
	// section failing, not an empty session drawing a spare heading.

	// `loadBase` is a per-describe local by convention in this file rather than a file-level helper, so
	// this block declares its own instead of reaching into a sibling's scope.
	const loadBase = (): Agent => {
		const lens = LensObject.load( path.join( PROJECT_ROOT, '_Claude/lenses/sm-documentation/sm-documentation.html' ), {
			projectRoot: PROJECT_ROOT, read: ( abs ) => fs.readFileSync( abs, 'utf-8' ), depth: 2
		} );
		return Agent.create( { lenses: [ lens ] } );
	};

	// POSIX-shaped on purpose. These are merge IDENTITIES, never touched on disk, and a Windows literal
	// here buys nothing while costing an escaping hazard in a file that is mostly prose assertions.
	const SUBJECT = '/vault/proj/notes.md';
	const ROWS: SlotRow[] = [
		{ what: 'file',   where: SUBJECT,           why: 'granted by the user for this session' },
		{ what: 'folder', where: '/vault/proj/src', why: 'granted by the user for this session' }
	];

	it( 'carries the ROWS, not just the heading — the assertion that would have caught it', () => {
		const agent = loadBase();
		agent.bindEnv( { grants: ROWS } );
		const out = agent.compiledContext().map( b => b.text ).join( '\n\n' );

		expect( out ).toContain( '## Grants' );
		expect( out ).toContain( SUBJECT );
		expect( out ).toContain( '/vault/proj/src' );
		expect( out ).toContain( 'granted by the user for this session' );
	} );

	it( 'does NOT ride at all when nothing has been canonized — most sessions', () => {
		const agent = loadBase();
		agent.bindEnv( { grants: [] } );
		expect( agent.compiledContext().map( b => b.text ).join( '\n\n' ) ).not.toContain( '## Grants' );
	} );

	it( 'never emits a heading with nothing under it, which is what a dropped table looks like', () => {
		// The shape of the bug, asserted directly: if a Grants heading is present, a row is present too.
		// Stated as an invariant rather than as a case, because the failure was invisible precisely by
		// looking like a legitimately empty section.
		for( const rows of [ [] as SlotRow[], ROWS ] ) {
			const agent = loadBase();
			agent.bindEnv( { grants: rows } );
			const out = agent.compiledContext().map( b => b.text ).join( '\n\n' );
			if( out.includes( '## Grants' ) ) expect( out.split( '## Grants' )[ 1 ]?.trimStart() ).toMatch( /^- \S/ );
		}
	} );

	it( 'dedupes two grants on one subject, which is what being a manifest section BUYS', () => {
		// The reason grants are a merged section rather than a passthrough block. The claim was already in
		// the code comment ( "the compressive merge dedupes them for free" ) and was not true of a string.
		const agent = loadBase();
		agent.bindEnv( { grants: [ ROWS[ 0 ], { ...ROWS[ 0 ], what: 'file again' } ] } );
		const out = agent.compiledContext().map( b => b.text ).join( '\n\n' );

		expect( out.split( SUBJECT ).length - 1 ).toBe( 1 );
	} );
} );
