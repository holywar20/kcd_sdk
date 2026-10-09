import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/**
 * A prompt-partial: reusable prompt wording a human fills in, stored where it can be read and edited,
 * not buried in a string literal.
 * Not context, and not composed into an agent: appended AFTER context compilation, as part of the user message.
 * It produces a blob of text; the structure exists so the wording is inspectable, not because anything parses it.
 * Deliberately no required sections or shape: the body IS the prompt. Slots or questions can come later.
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
