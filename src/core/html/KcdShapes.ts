/**
 * KcdShapes — the per-TYPE document shape, as data ( parser-family, protocol §2/§4 ).
 *
 * THE PROBLEM THIS SOLVES. A KCD document's shape has been written down three times and never once
 * in a form code can read: the eight scaffolds in `daedalus/templates/` ( prose, for a human to copy,
 * and `data-kcd="template"` is EXEMPT from validation ), the contracts' body-section prose, and the
 * primitives' doc-comments. `KcdValidate` enforces the GRAMMAR ( a section must be named and
 * non-empty, a slot must carry a kind ) but not the SHAPE ( a plan has a Goal ) — its one type-aware
 * pass is `checkHabit`, hand-written for a single type. So a plan with no Goal, no Phases and no
 * Current State validates clean today, and structural drift is not prevented, merely undetected.
 *
 * THE POINT IS TO REMOVE JUDGMENT FROM THE AGENT. An author should be able to say "this is a
 * reference, here is what it says" and never learn the substrate. Every question this table answers
 * — which sections exist, which are mandatory, what order they take, which carry slot ROWS rather
 * than prose — is a question an agent currently answers by reading a template and guessing. Declared
 * once here, three consumers read it and no one guesses:
 *
 *   SYNTHESIZE  ( write ) — text in, conforming HTML out; the author supplies content, not markup.
 *   VALIDATE    ( write ) — the general per-type arm `checkHabit` is the hand-written first row of.
 *   PROJECT     ( read )  — a read REPORTS its gaps rather than refusing; see `audit`.
 *
 * READS REPORT, WRITES REFUSE. A read must never be blocked from telling you what is wrong — a tool
 * that refuses to open a malformed document is the tool that cannot diagnose it, which is the
 * absence-shaped failure this project keeps re-finding. `audit` is therefore pure and non-throwing;
 * the write gate is what turns its findings fatal.
 *
 * TIERS ARE THE MIGRATION LEVER. `required` is an error, `expected` a warning, `optional` silent, and
 * an `open` type accepts sections outside its list entirely. The corpus already conforms ( lenses
 * 13/13; plans 31/36 on goal+phases+current-state ), so these knobs exist to land the check without
 * lighting up documents that were authored correctly under a looser rule — not to soften it forever.
 *
 * WHAT THIS TABLE IS NOT. It does not know where a type lives on disk ( `VaultLayout` owns that ),
 * nor which frontmatter fields a document carries ( `KcdValidate.FRONTMATTER` owns that ). One table,
 * one question: what SHAPE does a body of this type take.
 */

/** How hard a section's absence is. `required` → error, `expected` → warning, `optional` → silent. */
export type SectionTier = 'required' | 'expected' | 'optional';

/** One section in a type's shape. */
export interface SectionSpec {
	name:   string;
	tier:   SectionTier;
	/** This section holds slot ROWS of the named kind, not prose — synthesis emits a faux-table.
	 *  Absent ⇒ prose. */
	slot?:  string;
	/** A glob for the repeating CHILD sections this one nests ( a plan's `phases` nests `phase-*` ).
	 *  Children are authored, not enumerated, so they are matched rather than listed. */
	nests?: string;
	/** One line, addressed to the author, describing what belongs here. This is what `describe()`
	 *  serves and what a refusal quotes — the whole reason an agent need not read a template. */
	hint:   string;
}

/** A lens's Know/Care/Do region and the sections inside it. Regions are lens-only ( protocol §4 ). */
export interface RegionSpec {
	name:     string;
	sections: SectionSpec[];
	hint:     string;
}

/** One artifact type's body shape. A type declares sections, or regions containing them, never both. */
export interface TypeShape {
	/** Prose for the author: what this type is FOR. Served by `describe()` ahead of the section list. */
	purpose:   string;
	sections?: SectionSpec[];
	regions?:  RegionSpec[];
	/** Sections outside the declared list are legal. True for types whose body is deliberately loose
	 *  ( a reference is pointer prose; its section vocabulary is wide by design and policing it would
	 *  invent a rule the corpus never had ). */
	open?:     boolean;
}

/** The gap report for one document — what `audit` returns and what both gates consume. */
export interface ShapeAudit {
	type:       string;
	known:      boolean;
	/** Declared `required` and absent — fatal on write. */
	missing:    string[];
	/** Declared `expected` and absent — advisory on write, never fatal. */
	thin:       string[];
	/** Present but outside the declared list. Always empty for an `open` type. */
	unexpected: string[];
	/** The declared sections in canonical order — what synthesis emits and what a fix follows. */
	order:      string[];
}

const SCAFFOLD_NOTE = 'scaffold-note';

/**
 * The table. Every entry is derived from the type's own template in `daedalus/templates/` plus the
 * corpus as authored — not invented here. A type absent from this table is UNGOVERNED rather than
 * malformed: `audit` reports `known: false` and finds nothing, so adding a type is additive and a
 * missing entry can never manufacture an error.
 */
export const SHAPES: Record<string, TypeShape> = {

	// OPEN by evidence. The required three ( goal / phases / current-state ) are the real invariant and
	// hold across the corpus; the rest of a plan's body is the author's to organize, and 18 documents
	// use bespoke sections — `decisions`, `findings-transport`, `spec-currency`, `out-of-scope`,
	// `inventory` — to do exactly that. Closing the vocabulary would flag content that is correctly
	// authored. ( Two real defects live in that same population — date-stamped section names, and a
	// `status` restated in the body — but both are CONTRACT violations rather than shape ones, and
	// catching them here would conflate two different checks. )
	plan: {
		purpose: 'A durable design artifact: what is being built, in what order, and where it stands now.',
		open: true,
		sections: [
			{ name: 'goal',           tier: 'required', hint: 'One paragraph. What is true when this is done.' },
			{ name: 'approach',       tier: 'expected', hint: 'The strategy, and why this sequence rather than another.' },
			{ name: 'phases',         tier: 'required', nests: 'phase-*', hint: 'The spine. Each phase carries a Purpose, an End state, and number-letter checkbox tasks.' },
			{ name: 'files-affected', tier: 'optional', hint: 'Optional table of the files or domains this touches.' },
			{ name: 'open-questions', tier: 'optional', hint: 'Unknowns that block a named phase. A settled question belongs nowhere.' },
			{ name: 'notes',          tier: 'optional', hint: 'Decisions already paid for. Not a changelog of the plan\'s own authoring.' },
			{ name: 'current-state',  tier: 'required', hint: 'One sentence while active; a completion record once retired.' },
		],
	},

	habit: {
		purpose: 'One atomic behaviour: the trigger it fires on, what to do, and why.',
		open: true,
		sections: [
			{ name: 'why',         tier: 'required', hint: 'The TRIGGER this fires on. A habit with no why cannot fire.' },
			{ name: 'action',      tier: 'expected', hint: 'What to do when it fires. A rules-only habit may omit this.' },
			{ name: 'explanation', tier: 'expected', hint: 'The rationale the dense projection carries.' },
			{ name: 'rules',       tier: 'optional', hint: 'Hard constraints, when the behaviour is a prohibition rather than an act.' },
		],
	},

	// THE ONE CLOSED TYPE, and closed by evidence rather than preference: thirteen lenses share one
	// section vocabulary, and the single deviation the check found ( `tools` ) turned out to be a real
	// gap in this table rather than a drifting document. A lens is the substrate's own composition
	// surface — an undeclared section here means the compiler silently drops content — so closure buys
	// something real. Every other type is open.
	lens: {
		purpose: 'A Know + Care pair — a personality. What it loads, what it defends, and how it behaves.',
		regions: [
			{
				name: 'know',
				hint: 'Read-only inputs: what this lens loads from the knowledge store.',
				sections: [
					{ name: 'references', tier: 'expected', slot: 'reference', hint: 'Rows pointing at the references this lens always brings.' },
					{ name: 'domains',    tier: 'optional', slot: 'reference', hint: 'Rows pointing at code areas this lens owns.' },
				],
			},
			{
				name: 'care',
				hint: 'The personality: who this lens is and what it defends.',
				sections: [
					{ name: 'purpose',        tier: 'required', hint: 'What this lens governs, and the bet behind it.' },
					{ name: 'philosophy',     tier: 'required', hint: 'Design stance, push-back style, prerogatives, flags, and what it does NOT do.' },
					{ name: 'open-questions', tier: 'optional', hint: 'Live unknowns this lens is carrying.' },
				],
			},
			{
				name: 'do',
				hint: 'Execution layer: how this lens operates and where its work goes.',
				sections: [
					{ name: 'habits',    tier: 'expected', slot: 'habit',    hint: 'Rows naming the habits this lens carries.' },
					{ name: 'contracts', tier: 'optional', slot: 'contract', hint: 'Rows naming the contracts that bind it.' },
					{ name: 'tools',     tier: 'optional', slot: 'tool',     hint: 'Rows setting this lens\'s tool exposure; an agent-level override wins over it.' },
				],
			},
		],
	},

	contract: {
		purpose: 'A behavioural agreement: when it activates, the lifecycle it governs, and the standard it holds.',
		open: true,
		sections: [
			{ name: 'when',            tier: 'required', hint: 'The situations that activate this contract.' },
			{ name: 'artifact-format', tier: 'optional', hint: 'The shape of whatever the contract governs.' },
			{ name: 'lifecycle',       tier: 'expected', nests: 'phase-*', hint: 'The staged process, each stage with its trigger and standard.' },
			{ name: 'standards',       tier: 'expected', hint: 'What good looks like, and the gates that enforce it.' },
			{ name: 'edge-cases',      tier: 'optional', hint: 'Named exceptions and how each resolves.' },
			{ name: 'scope-values',    tier: 'optional', hint: 'The declared scope vocabulary, if the contract has one.' },
		],
	},

	generator: {
		purpose: 'A manifest-driven write agent: no judgment, broad write authority, executed from a spec.',
		open: true,
		sections: [
			{ name: 'care',          tier: 'expected', hint: 'What this generator is for and what it must never do.' },
			{ name: 'parameters',    tier: 'required', hint: 'The typed inputs it takes — param rows, four cells each.' },
			{ name: 'requirements',  tier: 'expected', hint: 'What must be true before it runs.' },
			{ name: 'do',            tier: 'required', nests: 'phase-*', hint: 'The ordered steps it executes.' },
			{ name: 'deployed-copy', tier: 'optional', hint: 'Where the generated output lands.' },
		],
	},

	analyzer: {
		purpose: 'A read-anywhere, write-one-report agent.',
		open: true,
		sections: [
			{ name: 'know',         tier: 'expected', hint: 'What it is allowed to read.' },
			{ name: 'care',         tier: 'expected', hint: 'What it is looking for and what would make the report wrong.' },
			{ name: 'parameters',   tier: 'required', hint: 'The typed inputs it takes — param rows, four cells each.' },
			{ name: 'do',           tier: 'required', nests: 'phase-*', hint: 'The ordered steps it executes.' },
			{ name: 'report-shape', tier: 'expected', hint: 'The shape of the one report it writes.' },
		],
	},

	// A nav-index carries NO sections at all — its body is `<h2>` status headings over faux-tables of
	// `link` slot rows, and not one of the eleven in the corpus wraps them in a `data-kcd-section`.
	// An earlier draft of this table required an `entries` section, copying the template rather than
	// the corpus, and failed all eleven. The real invariant here — carries at least one `link` row —
	// is a SLOT axis, not a section one, so it is left unstated rather than faked as a section.
	'nav-index': {
		purpose: 'The navigable surface over a corpus — one row per artifact, grouped by status.',
		open: true,
		sections: [],
	},

	// Loose by construction. A reference is pointer prose — where a thing lives, how to use it, what
	// state it is in — and its section vocabulary is deliberately wide ( 58 of 60 in the corpus carry
	// sections, under no shared vocabulary ). Declaring a required set here would invent a rule the
	// type never had and light up the largest population in the vault.
	reference: {
		purpose: 'A pointer to a living artifact: where it lives, how to use it, and its current state.',
		open: true,
		sections: [],
	},

	framework:         { purpose: 'Orientation for the substrate itself.',            open: true, sections: [] },
	'prompt-partial':  { purpose: 'A reusable fragment composed into a prompt.',      open: true, sections: [] },
	audit:             { purpose: 'Raw generator output, kept as a record.',          open: true, sections: [] },
};

export const KcdShapes = new class KcdShapes {

	/** The shape for a type, or `undefined` when the type is ungoverned. Never throws — an unknown
	 *  type is a gap in this table, not a defect in the document. */
	shapeFor( type: string ): TypeShape | undefined {
		return SHAPES[ type ];
	}

	/** Every section a type declares, regions flattened, in canonical order. A lens's regions
	 *  contribute their sections in region order, which is the order a lens is authored in. */
	sectionsFor( type: string ): SectionSpec[] {
		const shape = this.shapeFor( type );
		if ( !shape ) return [];
		if ( shape.regions ) return shape.regions.flatMap( r => r.sections );
		return shape.sections ?? [];
	}

	/** Just the names, canonical order — what synthesis emits and what a fix follows. */
	orderFor( type: string ): string[] {
		return this.sectionsFor( type ).map( s => s.name );
	}

	/** The sections of a given tier. `requiredFor` is the write gate's input. */
	atTier( type: string, tier: SectionTier ): string[] {
		return this.sectionsFor( type ).filter( s => s.tier === tier ).map( s => s.name );
	}

	requiredFor( type: string ): string[] { return this.atTier( type, 'required' ); }
	expectedFor( type: string ): string[] { return this.atTier( type, 'expected' ); }

	/** One section's spec by name, across regions. */
	sectionSpec( type: string, name: string ): SectionSpec | undefined {
		return this.sectionsFor( type ).find( s => s.name === name );
	}

	/** Does this section hold slot ROWS rather than prose, and of which kind? */
	slotKindOf( type: string, name: string ): string | undefined {
		return this.sectionSpec( type, name )?.slot;
	}

	/** A section that is a nested CHILD of a declared parent ( `phase-1` under `phases` ). Matched by
	 *  the parent's `nests` glob, because children are authored rather than enumerated. */
	isNestedChild( type: string, name: string ): boolean {
		return this.sectionsFor( type ).some( s => !!s.nests && this.globMatches( s.nests, name ) );
	}

	/** The one glob form this table uses: a literal prefix and a trailing `*`. Deliberately not a
	 *  general matcher — a shape that needs one has outgrown being a table. */
	globMatches( glob: string, value: string ): boolean {
		if ( !glob.endsWith( '*' ) ) return glob === value;
		return value.startsWith( glob.slice( 0, -1 ) );
	}

	/**
	 * Compare a document's PRESENT section names against its type's shape. Pure, total, and
	 * non-throwing — this is the read gate, and a read that throws cannot report.
	 *
	 * An ungoverned type returns `known: false` and no findings, so a type this table does not yet
	 * carry is silent rather than wrong.
	 */
	audit( type: string, present: string[] ): ShapeAudit {
		const shape = this.shapeFor( type );
		const order = this.orderFor( type );

		if ( !shape ) return { type, known: false, missing: [], thin: [], unexpected: [], order: [] };

		const have = new Set( present );
		const declared = new Set( order );

		const missing = this.atTier( type, 'required' ).filter( n => !have.has( n ) );
		const thin    = this.atTier( type, 'expected' ).filter( n => !have.has( n ) );

		// The scaffold note is a template artifact that survives into copies; it is never part of a
		// shape and flagging it would punish every document authored the intended way.
		const unexpected = shape.open ? [] : present.filter( n =>
			n !== SCAFFOLD_NOTE && !declared.has( n ) && !this.isNestedChild( type, n )
		);

		return { type, known: true, missing, thin, unexpected, order };
	}

	/** True when the document satisfies every `required` section of its type. */
	conforms( type: string, present: string[] ): boolean {
		return this.audit( type, present ).missing.length === 0;
	}

	/**
	 * The shape, addressed to an author who has never read a template — served on refusal and by any
	 * future discovery tool. This is what lets an agent create a conforming artifact knowing only
	 * that it wants a reference: the tool tells it the rest at the moment it needs it.
	 */
	describe( type: string ): string {
		const shape = this.shapeFor( type );
		if ( !shape ) return `"${ type }" has no declared shape — its body is ungoverned.`;

		const line = ( s: SectionSpec, indent: string ) => {
			const tier = s.tier === 'required' ? 'REQUIRED' : s.tier === 'expected' ? 'expected' : 'optional';
			const kind = s.slot ? ` [rows of kind "${ s.slot }", not prose]` : '';
			const nest = s.nests ? ` [nests "${ s.nests }"]` : '';
			return `${ indent }${ s.name } ( ${ tier } )${ kind }${ nest } — ${ s.hint }`;
		};

		const body = shape.regions
			? shape.regions.map( r =>
				`  region "${ r.name }" — ${ r.hint }\n${ r.sections.map( s => line( s, '    ' ) ).join( '\n' ) }`
			).join( '\n' )
			: ( shape.sections ?? [] ).map( s => line( s, '  ' ) ).join( '\n' );

		const openNote = shape.open
			? '\nSections outside this list are allowed.'
			: '\nOnly these sections ( plus any nested children ) are allowed.';

		return `${ type } — ${ shape.purpose }\n${ body || '  ( no declared sections )' }${ openNote }`;
	}
}();
