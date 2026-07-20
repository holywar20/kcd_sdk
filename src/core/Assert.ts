/**
 * Assert — compile-time-backed runtime guards.
 *
 * `never()` is the exhaustiveness guard: drop it in a switch's `default` and the argument only types
 * as `never` once every case above is handled. Add a new variant and the switch STOPS COMPILING right
 * there ( "type X is not assignable to never" ), pointing at the exact place that forgot the case — and
 * if one ever slips through at runtime, it throws loud rather than falling through silently.
 *
 * Shared by @kcd/core and the renderer ( imported from @kcd/core ) so the whole TurnEntry surface grows
 * safely: as kinds pile up, every projection missing one is a build error, never a quiet drop.
 */
export const Assert = {

	/** Exhaustiveness guard for a discriminated union — see the module note. */
	never( x: never ): never {
		throw new Error( `unhandled variant: ${ String( x ) }` );
	}

};
