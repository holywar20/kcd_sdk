/**
 * KcdShapes — the per-TYPE document shape, as data ( parser-family, protocol §2/§4 ).
 * One table says what SHAPE a body of each type takes: sections, their tiers, their order, and which carry slot rows.
 * Three consumers read it: synthesis and the validator's per-type arm ( write ), and `audit` ( read ).
 * READS REPORT, WRITES REFUSE: `audit` is pure and non-throwing, and only the write gate makes its findings fatal.
 * Tiers are the migration lever: `required` is an error, `expected` a warning, `optional` silent; an `open` type accepts undeclared sections.
 * The table does not know where a type lives on disk ( VaultLayout ) or which frontmatter it carries ( KcdValidate.FRONTMATTER ).
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
	/** Undeclared sections are legal. Set for types whose body is deliberately loose, such as a reference. */
	open?:     boolean;
	/** This type's own status vocabulary, replacing the global `KcdAddress.STATUSES` when present. */
	statuses?: readonly string[];
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
 * A type absent from this table is UNGOVERNED rather than malformed: `audit` reports `known: false`
 * and finds nothing, so a missing entry can never manufacture an error.
 */
export const SHAPES: Record<string, TypeShape> = {

	// OPEN by evidence: the required sections are the real invariant. Date-stamped names and a restated status are
	// contract checks, not shape checks, and do not belong here.
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
			{ name: 'references',  tier: 'optional', slot: 'reference', hint: 'What this habit leans on and what leans on it — reference rows.' },
		],
	},

	// THE ONE CLOSED TYPE: a lens is information, flat, and `KcdValidate.checkLens` refuses any other shape whole.
	// Personality is optional and read by no compiler; an agent authors its own on the AGENT ( `systemPrompt` ).
	lens: {
		purpose: 'Information for an agent: what it believes, and what it reads.',
		sections: [
			{ name: 'personality', tier: 'optional', hint: 'RETIRED as a lens concern — an agent authors its own personality. Kept legal for the lenses that still carry one; nothing reads it.' },
			{ name: 'philosophy',  tier: 'required', hint: 'Design stance, push-back style, prerogatives, flags, and what it does NOT do.' },
			{ name: 'references',  tier: 'expected', slot: 'reference', hint: 'Rows pointing at the documents and code this lens brings — each off, on or load.' },
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
		purpose: 'A read-anywhere, write-one-report SKILL — not an actor of its own.',
		open: true,
		sections: [
			{ name: 'know',         tier: 'expected', hint: 'What it is allowed to read.' },
			{ name: 'care',         tier: 'expected', hint: 'What it is looking for and what would make the report wrong.' },
			{ name: 'parameters',   tier: 'required', hint: 'The typed inputs it takes — param rows, four cells each.' },
			{ name: 'do',           tier: 'required', nests: 'phase-*', hint: 'The ordered steps it executes.' },
			{ name: 'report-shape', tier: 'expected', hint: 'The shape of the one report it writes.' },
		],
	},

	// A nav-index has no sections: `<h2>` status headings over `link` slot rows, not wrapped in `data-kcd-section`.
	// Its one invariant, a `link` row, is a slot axis, so it is not stated here as a section.
	'nav-index': {
		purpose: 'The navigable surface over a corpus — one row per artifact, grouped by status.',
		open: true,
		sections: [],
	},

	// Loose by construction: a reference is pointer prose with a wide section vocabulary, so nothing is required.
	// The one declared section is optional and exists for its slot rows.
	reference: {
		purpose: 'A pointer to a living artifact: where it lives, how to use it, and its current state.',
		open: true,
		sections: [
			{ name: 'references', tier: 'optional', slot: 'reference', hint: 'What this reference leans on and what leans on it — reference rows.' },
		],
	},

	framework:         { purpose: 'Orientation for the substrate itself.',            open: true, sections: [] },
	'prompt-partial':  { purpose: 'A reusable fragment composed into a prompt.',      open: true, sections: [] },
	// An absent entry is the correct state, not a gap: `audit` reports `known: false` for an ungoverned type and throws nothing.

	// The task board's vocabulary: `queued | working | rejected | verified` is `AgentState` verbatim. `needs-human` is the
	// escape path, which the board expresses as an ask rather than a state.
	'bug-report': {
		purpose: 'A filed defect and the proof of its repair — what broke, what moved, and the evidence that settles it.',
		open: true,
		statuses: [ 'queued', 'working', 'rejected', 'verified', 'needs-human' ],
		sections: [
			{ name: 'report',       tier: 'required', hint: 'The symptom, how to reproduce it, where it lives, and the recorded failure quoted. Carries raisedBy, priority, exitCondition.' },
			{ name: 'door',         tier: 'expected', hint: 'The trace areas this agent armed, then a closing line once disarmed — or none.' },
			{ name: 'repair',       tier: 'expected', hint: 'What moved: the files, the behaviour, and why. Carries assignee, startedAt.' },
			{ name: 'proof',        tier: 'expected', hint: 'The evidence before and after, or a plain statement that the fix could not be confirmed.' },
			{ name: 'verification', tier: 'expected', hint: 'Who signed it, or the question put to the human. Carries verifiedBy, approval, endedAt.' },
			{ name: 'notes',        tier: 'optional', hint: 'Anything else a later reader needs.' },
		],
	},
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

	/** The status words a type accepts — its own set when the shape declares one, else `undefined` and
	 *  the caller falls back to the global set. */
	statusesFor( type: string ): readonly string[] | undefined {
		return this.shapeFor( type )?.statuses;
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
	 * Compare a document's present section names against its shape. Pure and non-throwing: a read that throws cannot report.
	 * An ungoverned type returns `known: false` and no findings.
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

	/** The shape, addressed to an author who has never read a template, served on refusal. */
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
