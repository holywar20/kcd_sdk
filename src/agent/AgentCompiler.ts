import type { LensObject } from '../primitives/framework/LensObject';
import { KCDPrimitive } from '../primitives/framework/KCDPrimitive';
import type { Policy, Surface } from '../primitives/ToolAccess';
import type { TaggedBlock } from '../primitives/types';

/**
 * AgentCompiler — an agent's context, built from its record ( plan agents-own-behaviour, task 55 ).
 *
 * An agent is its lenses, its habits and its tools, and that is all this reads. The lenses come in stack
 * order: the first is the persona and overrules the rest where they conflict, and every lens adds its Care and
 * its references. A lens's own habit and tool tables are NOT read — behaviour belongs to the agent now, and a
 * lens is documentation. Habits the agent loads ride in full; the rest ride as one line of why, so the agent
 * knows they exist and where to find them. The tools are described, never granted here: what an agent may call
 * is its passport's business, or Claude Code's.
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

export interface CompileTool {
	id:           string;
	description?: string;
	policy?:      Policy;
	surface?:     Surface;
}

export interface AgentCompileInput {
	name:    string;
	lenses:  LensObject[];
	habits:  CompileHabit[];
	tools:   CompileTool[];
	host?:   CompileHost;
}

export interface AgentCompiled {
	text:    string;
	tokens:  number;
	lenses:  string[];        // what compiled, in order — the first is primary
	habits:  { loaded: string[]; listed: string[] };
	tools:   string[];
}

/** What a lens contributes: its Care, its own Know tables, then the bodies of the references it loads. */
function _lensBlocks( lens: LensObject ): TaggedBlock[] {
	const own = lens.getPath();
	const loaded = lens.getContextBlocks().filter( b => b.path !== own && b.artifactType === 'reference' );
	return [ ...lens.getOwnBlocks( 'care' ), ...lens.getOwnBlocks( 'know' ), ...loaded ];
}

function _lensSection( lens: LensObject, primary: boolean ): string {
	const name  = lens.getName();
	const head  = primary ? `## ${ name } — primary` : `## ${ name }`;
	const body  = _lensBlocks( lens ).map( b => b.text.trim() ).filter( Boolean );
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

export const AgentCompiler = {

	compile( input: AgentCompileInput ): AgentCompiled {
		const host  = input.host ?? 'starmind';
		const parts: string[] = [];

		const lenses = input.lenses.map( l => l.getName() );
		if ( input.lenses.length ) {
			const order = input.lenses.length > 1
				? `You are ${ input.name }, wearing ${ input.lenses.length } lenses in this order. The first, ${ lenses[ 0 ] }, is your persona and overrules the others where they conflict.`
				: `You are ${ input.name }, wearing ${ lenses[ 0 ] }.`;
			parts.push( [ '# Lenses', order, ...input.lenses.map( ( l, i ) => _lensSection( l, i === 0 ) ) ].join( '\n\n' ) );
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

		const tools = input.tools.map( t => t.id );
		if ( input.tools.length ) {
			const note = host === 'claude-code'
				? 'Described, not granted: Claude Code decides what you may call.'
				: 'What you may call is your passport\'s; these are the tools you hold.';
			parts.push( [ '# Tools', note, input.tools.map( _toolLine ).join( '\n' ) ].join( '\n\n' ) );
		}

		const text = parts.join( '\n\n---\n\n' );
		return { text, tokens: KCDPrimitive._estimateTokens( text ), lenses, habits: { loaded, listed }, tools };
	}
};
