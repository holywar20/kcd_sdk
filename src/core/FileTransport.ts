import { claimExt, type FileByteClaim, type FileParcel, type ParcelContent, type ParseOptions } from './FileParcel'

/**
 * FileTransport — ONE KIND OF FILE, declared whole. The PARSER half of the pair `FileParcel` opens.
 *
 * A parcel is one file IN FLIGHT and carries its own behaviour; a transport is one file KIND and says what
 * that kind MEANS. One is per file, the other is per format, and the registry holds the second.
 *
 * ── A PARSER'S ONLY ARGUMENT IS A PARCEL ──
 *
 * Which carries no path, no reader, no principal and no grant — so a parser cannot reach disk, structurally,
 * because there is nothing in its hand to reach with. The reasoning is `FileParcel`'s own header and is not
 * restated here; what matters at this type is that `parse` takes exactly one argument and that argument is
 * the parcel.
 *
 * ── WHAT A TRANSPORT DECLARES ──
 *
 * Four things and nothing else: what it MATCHES ( IANA media type and/or extension ), how a person's UI
 * should LABEL it, how a parcel's bytes PARSE into content, and any CAPS it owns. Bryan, 2026-10-26: "How
 * it's handled in the orchestrator, in the UI, etc — is fully unified by a single thing that defines it."
 * The instinct is `Agent`'s — one object defining a convention, rather than the convention scattered across
 * four files that drift — and the failure it prevents is the one this codebase keeps paying for: a format
 * handled in the orchestrator, labelled somewhere else, capped in a third place, and only three of the four
 * updated when it changes.
 *
 * ── WHAT A TRANSPORT DOES *NOT* DECLARE: THE SCRUB ──
 *
 * `defang` is applied by the PIPELINE, around `parse`, and a transport cannot opt out of it by omission.
 * That is deliberate and it is not a convenience. A per-transport scrub makes every future transport a
 * chance to forget, and forgetting is invisible — the output looks fine, and the one case it matters is a
 * file somebody wrote to be read by a model. The same argument this codebase already makes for
 * `PDF_PAGE_IMAGE_CAP` living in exactly one place.
 *
 * ── WHY THE DECLARATION IS HERE AND THE REGISTRY IS NOT ──
 *
 * This module is pure data and one pure function, Node-free, importable from BOTH sides of the bridge: the
 * renderer has to read a transport's labelling to draw a chip, and a round trip to main for a string that
 * never changes is a round trip nobody should pay. So the DECLARATION lives in core and the REGISTRY — the
 * table of shipped transports and the pipeline that runs one — is `starmind_file`'s, beside the gate and the
 * extractor it already owns ( placement ruled by Bryan, 2026-10-26 ). `matchesTransport` is here rather than
 * with the table for the same reason: knowing what a match IS belongs to the declaration, and knowing what
 * the table HOLDS belongs to the owner.
 */

/** WHAT A TRANSPORT CLAIMS. Either axis may be omitted; a transport claiming NEITHER matches nothing, which
 *  is honest for a declaration somebody has not finished and never resolves by accident.
 *
 *  BOTH AXES EXIST BECAUSE NEITHER IS RELIABLE ALONE. A media type is the better fact and is frequently
 *  absent or wrong — `application/octet-stream` for anything the sniffer did not know, `text/plain` for half
 *  the formats that are not — and an extension is always present and trivially misleading. Matching on
 *  either means a file resolves when ONE of the two is right, which is the common case. */
export type TransportMatch = {
	/** IANA media types, matched case-insensitively and exactly — no wildcards, so `image/*` is spelled out
	 *  as the types a transport has actually been written against rather than claimed wholesale. */
	mediaTypes?: readonly string[]
	/** Extensions, lowercased, with or without the leading dot. */
	extensions?: readonly string[]
}

export type FileTransport = {
	/** Stable id — the one name this transport is known by in a trace line, a test, or a `ParcelContent.by`
	 *  saying which parser handled a file. Never shown to a person; `label` is for that. */
	id:    string
	/** How a person's UI names this KIND of file — a chip's word, read in the renderer with no round trip. */
	label: string
	/** One line a surface may show about what this transport does to a file, when it has room. Optional
	 *  because most kinds need no explaining; one that drops or transforms something owes one. */
	hint?: string
	match: TransportMatch
	/** CAPS THIS TRANSPORT OWNS, by name — a page ceiling, a pixel budget, whatever it enforces. Declared
	 *  here so the number has ONE home: a parser that obeys a cap and a frame that states one to the model
	 *  must read the same value, and two copies are two numbers free to disagree about what was said.
	 *  `PDF_PAGE_IMAGE_CAP` is the worked example and lives in core for exactly this reason. */
	caps?: Readonly<Record<string, number>>
	/** A PARCEL IN, CONTENT OUT — the parcel carries no way to reach a file, and `opts` says what the RECEIVER
	 *  can accept rather than anything about the file. May be async: a parser is allowed to dynamically import
	 *  a heavy library, as `extractPdfText` does, rather than putting it in boot cost for every session that
	 *  never opens one.
	 *
	 *  `by` ON THE RESULT IS THE PIPELINE'S TO SET, not a parser's, so it cannot disagree with the transport
	 *  that actually ran — which is why this returns the content WITHOUT it. */
	parse( file: FileParcel, opts?: ParseOptions ): Omit<ParcelContent, 'by'> | Promise<Omit<ParcelContent, 'by'>>
	/**
	 * HOW THIS KIND WORDS A FILE IT WAS NEVER HANDED — a path refused, a file deleted between the moment a
	 * person attached it and the moment the turn opened.
	 *
	 * IT TAKES NO PARCEL, because there is no parcel: the read did not happen, which is the whole of what
	 * went wrong. It gets the display name and the reason whoever tried to read it was given.
	 *
	 * WHY A SECOND METHOD RATHER THAN THE CALLER FRAMING IT. Some kinds have to be LOUD about this. A PDF
	 * that could not be read must say so in its own frame — a model handed silence treats the attachment as
	 * absent, and a model handed the raw bytes gets mojibake that reads like content. A plain text file
	 * wants none of that and is better served by the ordinary failed-injection projection. That is a fact
	 * about the KIND, so it belongs on the kind's declaration rather than in a caller branching on media
	 * types, which is the thing this whole registry exists to delete.
	 *
	 * OPTIONAL, and absent means "nothing special to say" — the caller then does whatever it does for a file
	 * that would not read, which for an attachment is a WARNINGS line and no contents.
	 */
	unreadable?( name: string, reason: string ): Omit<ParcelContent, 'by'>
}

/**
 * DOES THIS TRANSPORT CLAIM THIS FILE — the pure predicate, so the renderer and the registry apply one rule.
 *
 * EITHER AXIS MATCHING IS A MATCH, never both: see `TransportMatch` on why neither fact is reliable alone.
 * An absent or empty claim matches nothing rather than everything — a file whose media type nothing could
 * determine must fall to the DEFAULT transport, not to whichever row happened to list no types.
 */
export function matchesTransport( transport: FileTransport, claim: FileByteClaim ): boolean {
	const media = ( claim.mediaType ?? '' ).trim().toLowerCase()
	const ext   = claimExt( claim.ext )

	if( media && ( transport.match.mediaTypes ?? [] ).some( ( m ) => m.trim().toLowerCase() === media ) ) return true
	if( ext   && ( transport.match.extensions ?? [] ).some( ( e ) => claimExt( e ) === ext ) ) return true
	return false
}
