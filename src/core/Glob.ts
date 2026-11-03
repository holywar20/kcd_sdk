/**
 * Glob — the shared matcher, so every reader (vault, disk walk, blacklist, renderer) matches identically.
 * Paths must be '/'-normalized and relative to the search base. Pure, Node-free.
 *
 * Supported: `*` within a segment, `**` across segments, `**\/` for zero-or-more directories, `?` for exactly
 * one non-separator character, `{a,b}` alternation (nested), and `[0-9]` / `[abc]` / `[!abc]` classes.
 *
 * `**\/` means ZERO OR MORE segments, so `**\/*.ts` matches a root-level file. It once compiled to `.*\/`, which
 * silently dropped root-level files while the list still called itself complete. Zero-or-more is the standard in
 * shell, gitignore and minimatch. It only ever matches more, so Blacklist deny patterns stay safe.
 *
 * ── WHY A SCANNER RATHER THAN A CHAIN OF `replace` CALLS (DEFECT-035) ──
 * This file used to escape every regex metacharacter and then translate the stars. That is correct for `.` and
 * `()`, and wrong for the three metacharacters that are ALSO glob syntax: `{}` and `[]` were escaped into literal
 * text, so `**\/*.{conf,ini}` hunted for a filename ending in the eleven characters `.{conf,ini}` and matched
 * nothing, ever, while reporting "no match" rather than "I cannot do that". `?` was worse — absent from the escape
 * class, it reached the regex as a QUANTIFIER, so `note?.md` compiled to `^note?\.md$`: it matched `not.md` and
 * missed `notes.md`, a false positive and a false negative from one character.
 *
 * ORDER IS STILL LOAD-BEARING, but it is now a reading order rather than a replace order, which is what removes
 * the whole class of mistake. A left-to-right scan cannot escape syntax it is about to introduce, cannot translate
 * a `*` that came out of a brace, and cannot translate anything INSIDE a character class, where `*` and `?` are
 * ordinary characters. Within the scan two precedences are explicit and both matter: `**\/` is claimed before the
 * bare `**` (or the slash is left behind as a mandatory separator and the zero-directory case is lost again), and a
 * `[` is claimed before anything else on the line (or the class body is translated as if it were pattern text).
 *
 * WHAT A FAILED COMPILE DOES. It returns null, `matches` answers false, and `unsupported()` names the construct.
 * A pattern this matcher cannot honour must never read as an empty directory: a denied file is already dropped
 * silently and correctly, so an empty result already means "not there, or not yours", and a silently-voided
 * pattern made it mean a third thing with no way to tell the three apart.
 *
 * THE SECURITY LAYER WAS CHECKED BEFORE THIS WIDENED. Braces and classes can only ever match MORE, which is the
 * safe direction for a deny pattern. `?` is the one change that can match LESS, and no pattern in `Blacklist`'s
 * defaults or `TestGate`'s allow-list contains `?`, `{` or `[` — all of them are `**\/`, `*` and literals. Check
 * that again before adding one.
 */

/**
 * THE BOUND ON BRACE ALTERNATION, and the reason there is one. Nested alternation beside `*` is the single
 * construct here that can backtrack badly: `{*,*}{*,*}{*,*}…` compiles to a chain of two-way choices over
 * `[^/]*`, and a long non-matching path makes the engine try the combinations. `Files.ts` refuses to accept a
 * raw regex from a caller at all, citing ReDoS, so this matcher must not become the back door to the same risk.
 * Two bounds, because they fail differently: DEPTH bounds one pattern's nesting, GROUPS bounds a flat pattern
 * that never nests but repeats. Subjects are filesystem paths, so the string being matched is bounded too
 * (260 characters on win32, 4096 elsewhere), and the two bounds together keep the work far inside that.
 * Over either bound the pattern is REFUSED rather than quietly voided — see `unsupported`.
 */
const MAX_BRACE_DEPTH  = 5
const MAX_BRACE_GROUPS = 10

/** Compiled patterns, memoised. NOT a micro-optimisation: `SdkFileAccess.glob` calls `matches` once per visited
 *  directory entry under a 50,000-entry walk cap, so one glob compiled the same pattern up to 50,000 times even
 *  when it was a single `replace` chain — and the scanner above is dearer than that chain was. Bounded so a
 *  long-lived process cannot accumulate patterns forever; the eviction is oldest-first, which for a walk (one
 *  pattern, 50,000 lookups) never evicts anything that matters. */
const CACHE_CAP = 128
const _cache    = new Map<string, RegExp | null>()

/** One parsed character class: the regex it became, and where the scan resumes. */
interface ClassRead {
	regex: string
	next:  number
}

export class Glob {

	static matches( relativePath: string, pattern: string ): boolean {
		const compiled = Glob._compile( pattern )
		if( !compiled ) return false
		return compiled.test( relativePath )
	}

	/**
	 * WHY THIS PATTERN MIGHT HAVE MATCHED NOTHING — zero or more notes, in the caller's own words, for a reply to
	 * append when a glob comes back empty (DEFECT-035).
	 *
	 * The precedent is twenty lines from `SdkFileAccess.glob`: `grepText` counts `nearMisses` so "the refusal can
	 * name the fix". An empty glob got no such courtesy, and it is the one that needed it most, because a glob has
	 * three ways to be empty and they look identical — the files are not there, the files are denied and dropped
	 * in silence, or the pattern was voided before it was ever matched against anything.
	 *
	 * It reports CONSTRUCTS, never a guess about the disk: each note is read off the pattern string alone, so this
	 * discloses nothing about what exists and is safe to print beside a result that deliberately discloses nothing.
	 * An empty array means the pattern is fully honoured and the emptiness is about the tree, not the syntax.
	 */
	static unsupported( pattern: string ): string[] {
		const notes: string[] = []

		if( Glob._compile( pattern ) === null ) {
			notes.push( `this matcher could not compile "${ pattern }", so it matched nothing without ever being `
				+ `tried: either its brace alternation nests deeper than ${ MAX_BRACE_DEPTH } levels or repeats `
				+ `more than ${ MAX_BRACE_GROUPS } times — both bounded on purpose — or a character class in it `
				+ 'holds a reversed range such as "[z-a]". Simplify it and call again.' )
		}

		// A brace group with no comma at its own depth is matched LITERALLY, which is a defensible reading of
		// `{a}` and almost never what the author meant — so it is named rather than left to be discovered.
		for( let i = 0; i < pattern.length; i += 1 ) {
			if( pattern[ i ] !== '{' || Glob._alternates( pattern, i ) ) continue
			notes.push( 'it contains `{` that this matcher reads as a literal brace, because the group holds no '
				+ 'comma at its own level or is never closed. `{a,b}` is alternation; `{a}` is two characters and '
				+ 'a letter. Add the comma, or drop the braces.' )
			break
		}

		for( let i = 0; i < pattern.length; i += 1 ) {
			if( pattern[ i ] !== '[' || Glob._class( pattern, i ) ) continue
			notes.push( 'it contains `[` that is never closed, so the bracket is matched literally. A class is '
				+ '`[abc]`, `[0-9]` or `[!abc]` to negate.' )
			break
		}

		// Extended glob is a real syntax that a model reaches for, and every one of these heads begins with a
		// character this matcher DOES honour — so `!(a|b)` silently becomes "the two characters `!(`, then a
		// literal a, then…" rather than anything useful. Named, because the failure is invisible otherwise.
		if( /[?*+@!]\(/.test( pattern ) ) {
			notes.push( 'it looks like extended glob ( `!(…)`, `+(…)`, `@(…)`, `*(…)`, `?(…)` ), which this '
				+ 'matcher does not implement — the leading character is honoured and the parenthesis is matched '
				+ 'literally, so the pattern means something other than it reads. Use `{a,b}` for a choice.' )
		}

		if( pattern.includes( '\\' ) ) {
			notes.push( 'it contains a backslash, which this matcher treats as a literal character rather than as '
				+ 'an escape or a separator. Patterns are matched against `/`-separated paths relative to the '
				+ 'search root, on every platform.' )
		}

		return notes
	}

	/* ── compilation ─────────────────────────────────────────────────────────────────────────────── */

	private static _compile( pattern: string ): RegExp | null {
		const hit = _cache.get( pattern )
		if( hit !== undefined ) return hit

		const compiled = Glob._build( pattern )
		if( _cache.size >= CACHE_CAP ) {
			const oldest = _cache.keys().next()
			if( !oldest.done ) _cache.delete( oldest.value )
		}
		_cache.set( pattern, compiled )
		return compiled
	}

	private static _build( pattern: string ): RegExp | null {
		const body = Glob._translate( pattern )
		if( body === null ) return null
		try {
			return new RegExp( `^${ body }$` )
		} catch {
			// A class the user wrote is the only way to reach here — a reversed range, say. Null rather than a
			// throw: every caller of `matches` is a filter inside a walk, and one bad pattern must not take the
			// walk down. `unsupported` is what makes the null legible.
			return null
		}
	}

	/**
	 * The scan. One pass, left to right, emitting regex as it reads glob — so nothing is ever escaped after it
	 * has become syntax, and nothing inside a character class is read as syntax at all.
	 * Returns null when the pattern is refused; the two reasons are the brace bounds above.
	 */
	private static _translate( pattern: string ): string | null {
		let out    = ''
		let depth  = 0   // how deep we are in STRUCTURAL braces — a literal `{` never increments this
		let groups = 0
		let i      = 0

		while( i < pattern.length ) {
			const ch = pattern[ i ] as string

			// A CLASS IS CLAIMED FIRST, before any wildcard on the line: inside `[…]` a `*` is an asterisk and a
			// `?` is a question mark, so the body must never reach the wildcard branches below.
			if( ch === '[' ) {
				const cls = Glob._class( pattern, i )
				if( cls ) { out += cls.regex; i = cls.next; continue }
				out += '\\['                                   // never closed → a literal bracket
				i   += 1
				continue
			}

			// Braces become alternation IN PLACE rather than being expanded into a product of patterns. Nesting
			// then costs nothing — `{a,{b,c}}` is `(?:a|(?:b|c))` — where expansion would multiply out and is the
			// shape that would have needed a real complexity budget rather than a bound.
			if( ch === '{' && Glob._alternates( pattern, i ) ) {
				if( depth >= MAX_BRACE_DEPTH || groups >= MAX_BRACE_GROUPS ) return null
				depth  += 1
				groups += 1
				out    += '(?:'
				i      += 1
				continue
			}
			if( ch === ',' && depth > 0 ) { out += '|'; i += 1; continue }
			if( ch === '}' && depth > 0 ) { depth -= 1; out += ')'; i += 1; continue }

			// `**/` BEFORE the bare `**` BEFORE `*`, which is the one precedence the old chain also had and the
			// one it documented: claim `**` first and the slash is left behind as a mandatory separator, which is
			// exactly how root-level files were lost before.
			if( pattern.startsWith( '**/', i ) ) { out += '(?:.*/)?'; i += 3; continue }
			if( pattern.startsWith( '**',  i ) ) { out += '.*';       i += 2; continue }
			if( ch === '*' )                     { out += '[^/]*';    i += 1; continue }
			// `?` is `*`'s single-character sibling and obeys the same boundary: exactly one character, never the
			// separator. As a regex quantifier this was the only wildcard that returned WRONG files.
			if( ch === '?' )                     { out += '[^/]';     i += 1; continue }

			out += Glob._escape( ch )
			i   += 1
		}

		// Unreachable by construction: `_alternates` opens a group only once it has seen that group CLOSE. Kept
		// anyway, and it earned its keep — the first draft returned true on the comma alone, and this guard is
		// what turned `{a,b.ts` into a refusal that `unsupported` could name rather than a `(?:` with no `)`
		// and a regex that throws from inside somebody's directory walk.
		if( depth !== 0 ) return null
		return out
	}

	/**
	 * Does the `{` at `open` begin a STRUCTURAL group — one with a comma at its own level and a closing brace?
	 * If not it is a literal brace, which is the ruling for `{a}`: a group with nothing to choose between is not
	 * alternation, and treating it as such would make `{a}` and `a` the same pattern.
	 * It skips over character classes, so a comma or a brace inside `[…]` cannot be mistaken for syntax.
	 */
	private static _alternates( pattern: string, open: number ): boolean {
		let depth = 0
		let comma = false
		for( let i = open; i < pattern.length; i += 1 ) {
			const ch = pattern[ i ]
			if( ch === '[' ) {
				const cls = Glob._class( pattern, i )
				if( cls ) { i = cls.next - 1; continue }
			}
			if( ch === '{' ) { depth += 1; continue }
			if( ch === '}' ) {
				depth -= 1
				// BOTH CONDITIONS, AND THE CLOSE IS THE ONE EASILY FORGOTTEN. Returning true the moment a comma
				// appears at depth 1 reads `{a,b.ts` as a group, so the scan opens `(?:`, meets the end of the
				// pattern and has to refuse a pattern whose only honest reading is seven literal characters.
				if( depth === 0 ) return comma
				continue
			}
			if( ch === ',' && depth === 1 ) comma = true
		}
		return false                               // never closed → literal
	}

	/**
	 * One character class, or null when the bracket is never closed. `!` and `^` both negate, because shell writes
	 * the first and regex the second and a pattern should not have to know which this is.
	 *
	 * A NEGATED CLASS IS WRAPPED RATHER THAN EXTENDED. `[!abc]` must not match the separator — a class is `?`'s
	 * relative and obeys the same boundary — and the obvious spelling, appending `/` inside the brackets, breaks
	 * on a trailing dash: `[!a-]` would become `[^a-/]`, where `a-/` reads as a reversed range and throws. The
	 * lookahead says the same thing without touching the body.
	 */
	private static _class( pattern: string, start: number ): ClassRead | null {
		let i = start + 1
		let negate = false
		if( pattern[ i ] === '!' || pattern[ i ] === '^' ) { negate = true; i += 1 }
		// A `]` in the first body position is a literal `]`, which is how every other glob reads it.
		let body = ''
		if( pattern[ i ] === ']' ) { body += '\\]'; i += 1 }

		for( ; i < pattern.length; i += 1 ) {
			const ch = pattern[ i ] as string
			if( ch === ']' ) {
				if( body === '' ) return null                  // `[]` is nothing to match — read it literally
				const regex = negate ? `(?:(?![/])[^${ body }])` : `[${ body }]`
				return { regex, next: i + 1 }
			}
			// Only the two characters that can break OUT of a class body are escaped. `-` is left alone because
			// ranges are the whole point of a class, which is also why a reversed one reaches `new RegExp` and is
			// caught there rather than being silently repaired into something the author did not write.
			body += ch === '\\' || ch === ']' ? `\\${ ch }` : ch
		}
		return null
	}

	/**
	 * Regex specials, escaped. `*` and `?` are absent on purpose — the scan has already claimed both, and
	 * escaping them is precisely the defect this file was opened for.
	 *
	 * `{}` AND `[]` ARE STILL HERE, which looks like that same defect and is the opposite of it. A brace or
	 * bracket only reaches this function once the scan has decided it is NOT syntax: a structural `{`/`}` emits
	 * `(?:`/`)` and never arrives, a class body is consumed whole by `_class`, and an unterminated `[` is escaped
	 * at its own branch. So what is left is a brace or bracket the author meant literally, and a literal one must
	 * be escaped or the engine reads `{2,3}` as a quantifier and `[a-z]` as a class we declined to honour.
	 */
	private static _escape( ch: string ): string {
		return /[.+^$()|\\{}[\]]/.test( ch ) ? `\\${ ch }` : ch
	}
}
