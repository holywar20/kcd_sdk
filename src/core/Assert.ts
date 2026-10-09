/**
 * Compile-time-backed runtime guards. `never()` is the exhaustiveness guard: drop it in a switch's
 * `default` and the argument only types as `never` once every case is handled. A new variant stops the
 * switch compiling right there, and one that slips through at runtime throws rather than falling through.
 * Shared by @kcd/core and the renderer, so a projection missing a kind is a build error, never a quiet drop.
 */
export const Assert = {

	never( x: never ): never {
		throw new Error( `unhandled variant: ${ String( x ) }` );
	}

};
