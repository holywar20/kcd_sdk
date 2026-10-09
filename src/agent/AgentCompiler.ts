import { LensObject } from '../primitives/framework/LensObject';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ToolMode } from '../primitives/ToolAccess';
import type { TaggedBlock } from '../primitives/types';

/**
 * AgentCompiler — an agent's context, built from its record: its personality, lenses, habits and tools, plus
 * the project's contracts, and nothing else. The personality rides `systemPrompt` and leads; no lens is primary.
 * Several philosophies in one stack are the point — the agent weighs them; nothing here reconciles them.
 * Lens habit and tool tables are not read, tools are described and never granted, and inheritance is never walked.
 * Runs alongside `Agent.compile` until the migration retires the lens-chain path.
 */

export type CompileHost = 'starmind' | 'claude-code';

/** One habit on the record. `habit` is the loaded document — required to ride in full, and absent when its
 *  file could not be read, in which case the habit falls back to its line. */
export interface CompileHabit {
	name:    string;
	path:    string;          // vault-relative — where the agent finds it
	why:     string;          // from the habit index
	loaded:  boolean;
	habit?:  KCDPrimitive | null;
}

/** One tool on the record. `mode` is how much of it rides — carried for the callers that report a record,
 *  never read by the compile itself, which describes every tool it is handed and grants none of them. */
export interface CompileTool {
	id:           string;
	description?: string;
	mode?:        ToolMode;
}

/** One of the PROJECT's contracts, not the agent's: every agent holds all of them, and the roster is
 *  derived from `contracts/`, so there is no second copy to keep in step. */
export interface CompileContract {
	name: string;
	path: string;          // vault-relative — where the agent fetches it
	when: string;
}

/** One attached skill: name and description alone, never truncated, since the description is what a model matches on.
 *  Resolving a slug is `SkillLibraryService`'s job; this compiler holds no library and no disk. */
export interface CompileSkill {
	name:        string;
	description: string;
}

export interface AgentCompileInput {
	/** The agent being compiled. Absent or empty is a real input — a bare lens stack has no agent, and the
	 *  lens header drops its "You are …" clause rather than naming nobody. */
	name?:   string;
	/** The agent's PERSONALITY — its own words, leading above every lens. Still spelled `systemPrompt`
	 *  because that is the field name on the record. */
	systemPrompt?: string | null;
	lenses:  LensObject[];
	habits:  CompileHabit[];
	tools:   CompileTool[];
	contracts?: CompileContract[];
	/** Skills attached to this agent, already resolved — an unresolvable slug is dropped upstream. Absent or
	 *  empty emits nothing, so an agent with no skills compiles byte-identical to before this field existed. */
	skills?: CompileSkill[];
	host?:   CompileHost;
}

export interface AgentCompiled {
	text:    string;
	tokens:  number;
	lenses:  string[];        // what compiled, in stack order. Order, not rank — none of them leads.
	habits:  { loaded: string[]; listed: string[] };
	tools:   string[];
	contracts: string[];
	skills:  string[];        // names of the skills that compiled, in attachment order
}

/** The one Care section a lens contributes. Every other Care section is the wearer's, authored on the agent
 *  (`systemPrompt`), not here. */
const PHILOSOPHY = 'philosophy';

const _norm = ( p: string ): string => p.replace( /\\/g, '/' );

/** Every reference a lens names in any mode, `off` included: the first lens to name one decides its mode.
 *  Forward-slashed and absolute where the root is known, so a block's path can be matched against it. */
function _namedRefs( lens: LensObject ): string[] {
	const root = lens.getProjectRoot();
	return lens.getPolicy()
		.filter( e => e.type === 'internal' && !!e.href )
		.map( e => _norm( root ? LensObject.resolveHref( e.href!, root ) : e.href! ) );
}

const _claimed = ( claimed: Set<string>, path: string ): boolean => {
	const p = _norm( path );
	for ( const c of claimed ) if ( p === c || p.endsWith( '/' + c ) || c.endsWith( '/' + p ) ) return true;
	return false;
};

/** A lens contributes its philosophy, its Know tables and its loaded references, the same from every lens.
 *  Position decides only a shared reference: an earlier lens's claim stands, mode included, never shipped twice. */
function _lensBlocks( lens: LensObject, claimed: Set<string> ): TaggedBlock[] {
	const own    = lens.getPath();
	const care   = lens.getOwnBlocks( 'care' ).filter( b => b.section === PHILOSOPHY );
	const loaded = lens.getContextBlocks().filter( b => b.path !== own && b.artifactType === 'reference' && !_claimed( claimed, b.path ) );
	return [ ...care, ...lens.getOwnBlocks( 'know' ), ...loaded ];
}

function _lensSection( lens: LensObject, claimed: Set<string> ): string {
	const name = lens.getName();
	const body = _lensBlocks( lens, claimed ).map( b => b.text.trim() ).filter( Boolean );
	return [ `## ${ name }`, ...body ].join( '\n\n' );
}

function _habitLine( h: CompileHabit ): string {
	return `- ${ h.name } — ${ h.why || 'no why recorded' } (${ h.path })`;
}

/** An artifact's loaded body — the one join for both the compile and the measurement projection below, since
 *  a second renderer would drift from the compile without anyone seeing it. */
function _artifactBody( artifact: KCDPrimitive ): string | null {
	const text = artifact.getContextBlocks().map( b => b.text.trim() ).filter( Boolean ).join( '\n\n' );
	return text || null;
}

function _habitBody( h: CompileHabit ): string | null {
	if ( !h.habit ) return null;
	return _artifactBody( h.habit );
}

function _toolLine( t: CompileTool ): string {
	return t.description ? `- ${ t.id } — ${ t.description }` : `- ${ t.id }`;
}

function _contractLine( c: CompileContract ): string {
	return c.when ? `- ${ c.name } — when ${ c.when }` : `- ${ c.name }`;
}

/** One attached skill, drawn exactly as a habit's unloaded row is — a name and why it might matter, never
 *  the body. `description` rides WHOLE; see `CompileSkill`. */
function _skillLine( s: CompileSkill ): string {
	return `- ${ s.name } — ${ s.description }`;
}

/** How to invoke one, said once here rather than in every contract document. The fetch-whole rule is the
 *  load-bearing half: a contract summarised on the way in has lost the steps that are the whole point of it. */
const CONTRACT_NOTE =
	'A contract is a procedure you follow. Invoke one explicitly as `#name`, or by describing it — "let\'s '
	+ 'make a plan" invokes plan exactly as `#plan` does. Match the request against the trigger below, then '
	+ 'fetch it whole with `sm_documentation__get_doc { path: "contracts/{name}.html" }` and read it before '
	+ 'starting: a contract is fetched, not compiled, and one summarised on the way in has lost its steps.';

/** The compile's own projections, so a size report measures what an agent receives; never a second renderer.
 *  Artifact types the compile has no opinion about have no projection, and that absence is the answer. */
export const AgentProjection = {
	/** An artifact's LOADED form — what an agent that carries it in full pays every turn. */
	body:         _artifactBody,
	/** A habit's LISTED form — the one line every agent that merely NAMES it pays every turn. */
	habitLine:    _habitLine,
	/** A contract's line. A contract has no loaded form here on purpose: the compile carries the line and
	 *  the agent fetches the document whole when it applies. */
	contractLine: _contractLine,
	/** One lens measured alone: an UPPER BOUND inside a stack, since references an earlier lens claims are dropped.
	 *  A caller reporting this figure has to say so. */
	lensSection:  ( lens: LensObject ): string => _lensSection( lens, new Set<string>() )
};

export const AgentCompiler = {

	compile( input: AgentCompileInput ): AgentCompiled {
		const host  = input.host ?? 'starmind';
		const parts: string[] = [];

		// A personality is voice guidance, so an empty one emits nothing — announcing the absence would spend
		// context telling a model something about itself that it is better off simply being.
		const prompt = input.systemPrompt?.trim();
		if ( prompt ) parts.push( prompt );

		const lenses = input.lenses.map( l => l.getName() );
		if ( input.lenses.length ) {
			// No lens overrules another: several prerogatives are weighed by the agent, not ranked here.
			// Without a name the "You are …" clause is dropped rather than filled with an empty string.
			const who   = input.name?.trim();
			const order = input.lenses.length > 1
				? ( who ? `You are ${ who }, wearing ${ input.lenses.length } lenses at once: ${ lenses.join( ', ' ) }. `
					: `This context wears ${ input.lenses.length } lenses at once: ${ lenses.join( ', ' ) }. ` )
					+ 'Each brings what it defends. Where two of them pull against each other, that tension is '
					+ 'deliberate — weigh them and say which you are trading away, rather than pretending they agree.'
				: who ? `You are ${ who }, wearing ${ lenses[ 0 ] }.` : `This context wears ${ lenses[ 0 ] }.`;
			const claimed  = new Set<string>();
			const sections: string[] = [];
			input.lenses.forEach( ( l ) => {
				sections.push( _lensSection( l, claimed ) );
				for ( const p of _namedRefs( l ) ) claimed.add( p );
				for ( const b of l.getContextBlocks() ) if ( b.artifactType === 'reference' ) claimed.add( _norm( b.path ) );
			} );
			parts.push( [ '# Lenses', order, ...sections ].join( '\n\n' ) );
		}

		const loaded: string[] = [];
		const listed: string[] = [];
		const bodies: string[] = [];
		const lines:  string[] = [];
		for ( const h of input.habits ) {
			const body = h.loaded ? _habitBody( h ) : null;
			if ( body ) { bodies.push( body ); loaded.push( h.name ); }
			else { lines.push( _habitLine( h ) ); listed.push( h.name ); }
		}
		if ( bodies.length || lines.length ) {
			const habit = [ '# Habits', ...bodies ];
			if ( lines.length ) habit.push( 'Also yours, read on demand when one applies:\n\n' + lines.join( '\n' ) );
			parts.push( habit.join( '\n\n' ) );
		}

		// Skills arrive already resolved, so nothing here decides absence — only whether a section prints.
		const skillRows = input.skills ?? [];
		if ( skillRows.length )
			parts.push( [ '# Skills', skillRows.map( _skillLine ).join( '\n' ) ].join( '\n\n' ) );

		// EVERY agent gets the project's contracts, whatever lenses it wears — that is what makes `#close`
		// dependable: a session wraps up the same way regardless of which agent was driving it.
		const contractRows = input.contracts ?? [];
		const contracts    = contractRows.map( c => c.name );
		if ( contractRows.length )
			parts.push( [ '# Contracts', CONTRACT_NOTE, contractRows.map( _contractLine ).join( '\n' ) ].join( '\n\n' ) );

		const tools = input.tools.map( t => t.id );
		if ( input.tools.length ) {
			const note = host === 'claude-code'
				? 'Described, not granted: Claude Code decides what you may call.'
				: 'What you may call is your passport\'s; these are the tools you hold.';
			parts.push( [ '# Tools', note, input.tools.map( _toolLine ).join( '\n' ) ].join( '\n\n' ) );
		}

		const text = parts.join( '\n\n---\n\n' );
		return { text, tokens: KCDPrimitive._estimateTokens( text ), lenses, habits: { loaded, listed }, tools, contracts, skills: skillRows.map( s => s.name ) };
	}
};
