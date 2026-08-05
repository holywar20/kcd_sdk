import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A prompt-partial: reusable prompt wording a human fills in, stored where it can be read and edited
 * instead of buried in a string literal.
 *
 * It is not context and it is not composed into an agent. A partial is appended AFTER context
 * compilation, as part of the user message — the wording a task sends, plus wherever the human's own
 * text goes. What it produces is a blob of text and nothing more; the structure exists so the wording
 * is inspectable, not because anything parses it.
 *
 * Deliberately no required sections and no shape of its own. The body IS the prompt. Slots, questions,
 * and anything more elaborate can arrive later without changing what a partial fundamentally is.
 */
export class PromptPartialObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'prompt-partial' );
	}

	static fromSerialized( json: SerializedArtifact ): PromptPartialObject {
		const obj = new PromptPartialObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}
}
