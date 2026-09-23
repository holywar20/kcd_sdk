import { LensObject } from '../primitives/framework/LensObject';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { ToolMode } from '../primitives/ToolAccess';
import type { TaggedBlock } from '../primitives/types';

/**
 * AgentCompiler — an agent's context, built from its record ( plan agents-own-behaviour, task 55 ).
 *
 * An agent is its system prompt, its lenses, its habits and its tools, plus the contracts its PROJECT
 * holds, and that is all this reads. The lenses come in stack
 * order, and THE FIRST LOADED WINS: it alone supplies the personality, every later lens adds only its philosophy
 * and its references, and a reference two lenses share stands as the first has it ( see `_lensBlocks` ). A lens's own habit and tool tables are NOT read — behaviour belongs to the agent now, and a
 * lens is documentation. Habits the agent loads ride in full; the rest ride as one line of why, so the agent
 * knows they exist and where to find them. The tools are described, never granted here: what an agent may call
 * is its passport's business, or Claude Code's. The contracts are the project's rather than the agent's —
 * every agent holds all of them, derived from `contracts/` so the roster has one home and nothing to
 * synchronise.
 *
 * IT NEVER WALKS LENS INHERITANCE. No base lens is appended and nothing a lens points at is followed except the
 * references it loads. What the agent is, is what its record names.
 *
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

/** One of the PROJECT's contracts. Not the agent's — every agent in a project holds all of them, which is
 *  why there is no mode here and nothing to author per agent. `when` is the trigger, read from the
 *  document; the roster is derived from `contracts/`, so there is no second copy to keep in step. */
export interface CompileContract {
	name: string;
	path: string;          // vault-relative — where the agent fetches it
	when: string;
}

export interface AgentCompileInput {
	name:    string;
	systemPrompt?: string | null;   // the agent's own words — they lead, above every lens
	lenses:  LensObject[];
	habits:  CompileHabit[];
	tools:   CompileTool[];
	contracts?: CompileContract[];
	host?:   CompileHost;
}

export interface AgentCompiled {
	text:    string;
	tokens:  number;
	lenses:  string[];        // what compiled, in order — the first is primary
	habits:  { loaded: string[]; listed: string[] };
	tools:   string[];
	contracts: string[];
}

/** The Care section a stacked lens still contributes when it is not first. Everything else in its Care is who
 *  it is, and there is one of those per agent. */
const PHILOSOPHY = 'philosophy';

const _norm = ( p: string ): string => p.replace( /\\/g, '/' );

/** Every reference path a lens names, in any mode — `off` included, because a mode is a claim on the
 *  reference, and the first lens to make one decides it. Forward-slashed and absolute where the lens knows its
 *  root, so a block's path can be matched against it. */
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

/**
 * What a lens contributes. THE FIRST LENS LOADED WINS: the primary brings its whole Care — its personality —
 * and each lens after it brings only its philosophy. Every lens brings its own Know tables and the bodies of the
 * references it loads, EXCEPT a reference an earlier lens already names: that one stands as the earlier lens
 * has it, mode included, so a later lens can neither load what the first kept on the shelf nor load it twice.
 */
function _lensBlocks( lens: LensObject, primary: boolean, claimed: Set<string> ): TaggedBlock[] {
	const own    = lens.getPath();
	const care   = lens.getOwnBlocks( 'care' ).filter( b => primary || b.section === PHILOSOPHY );
	const loaded = lens.getContextBlocks().filter( b => b.path !== own && b.artifactType === 'reference' && !_claimed( claimed, b.path ) );
	return [ ...care, ...lens.getOwnBlocks( 'know' ), ...loaded ];
}

function _lensSection( lens: LensObject, primary: boolean, claimed: Set<string> ): string {
	const name  = lens.getName();
	const head  = primary ? `## ${ name } — primary` : `## ${ name }`;
	const body  = _lensBlocks( lens, primary, claimed ).map( b => b.text.trim() ).filter( Boolean );
	return [ head, ...body ].join( '\n\n' );
}

function _habitLine( h: CompileHabit ): string {
	return `- ${ h.name } — ${ h.why || 'no why recorded' } (${ h.path })`;
}

function _habitBody( h: CompileHabit ): string | null {
	if ( !h.habit ) return null;
	const text = h.habit.getContextBlocks().map( b => b.text.trim() ).filter( Boolean ).join( '\n\n' );
	return text || null;
}

function _toolLine( t: CompileTool ): string {
	return t.description ? `- ${ t.id } — ${ t.description }` : `- ${ t.id }`;
}

function _contractLine( c: CompileContract ): string {
	return c.when ? `- ${ c.name } — when ${ c.when }` : `- ${ c.name }`;
}

/** How to invoke one, said once here rather than in every contract document. The fetch-whole rule is the
 *  load-bearing half: a contract summarised on the way in has lost the steps that are the whole point of it. */
const CONTRACT_NOTE =
	'A contract is a procedure you follow. Invoke one explicitly as `#name`, or by describing it — "let\'s '
	+ 'make a plan" invokes plan exactly as `#plan` does. Match the request against the trigger below, then '
	+ 'fetch it whole with `sm_documentation__get_doc { path: "contracts/{name}.html" }` and read it before '
	+ 'starting: a contract is fetched, not compiled, and one summarised on the way in has lost its steps.';

export const AgentCompiler = {

	compile( input: AgentCompileInput ): AgentCompiled {
		const host  = input.host ?? 'starmind';
		const parts: string[] = [];

		const prompt = input.systemPrompt?.trim();
		if ( prompt ) parts.push( prompt );

		const lenses = input.lenses.map( l => l.getName() );
		if ( input.lenses.length ) {
			const order = input.lenses.length > 1
				? `You are ${ input.name }, wearing ${ input.lenses.length } lenses in this order. The first, ${ lenses[ 0 ] }, is your persona and overrules the others where they conflict.`
				: `You are ${ input.name }, wearing ${ lenses[ 0 ] }.`;
			const claimed  = new Set<string>();
			const sections: string[] = [];
			input.lenses.forEach( ( l, i ) => {
				sections.push( _lensSection( l, i === 0, claimed ) );
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
		return { text, tokens: KCDPrimitive._estimateTokens( text ), lenses, habits: { loaded, listed }, tools, contracts };
	}
};
