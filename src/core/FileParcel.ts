/**
 * FileParcel — ONE FILE IN FLIGHT, as a fat object.
 *
 * ── A PARCEL CARRIES NO PATH, AND THAT IS THE FIRST THING TO KNOW ──
 *
 * No path. No reader. No principal, no grant, and nothing that could become one. A parcel holds BYTES and
 * what those bytes claim to be, so anything handed a parcel — a parser, a frame, a surface — cannot reach
 * a file, not because it is asked not to but because there is nothing in its hand to reach with. The rule
 * is STRUCTURAL rather than a request, which is why this paragraph is short: the type is what enforces it.
 *
 * Reaching a file is `FileGate`'s, through `Files`, and it stays there. WHOEVER CONSTRUCTS A PARCEL HAS
 * ALREADY MET THE GATE — that is the whole bargain, and everything downstream is handed the result rather
 * than the capability. The reasoning is already written down a layer out: `PdfText` says its extractor
 * "takes BYTES and knows nothing about paths, principals or grants — so it cannot accidentally become a
 * second way to reach a file", and "accidentally" is the load-bearing word. A parser holding a reader
 * would be a second route to disk that no gate audits and no reach list bounds, and it would arrive by
 * accident rather than by argument: somebody writing a parser for a format that references a sibling file
 * ( a stylesheet, an include, a linked sheet ), following the format faithfully, widening what a turn can
 * read without ever touching a permission. A parcel with no path makes that impossible to do by mistake
 * rather than merely forbidden. FAT MEANS IT HAS METHODS, NEVER THAT IT HAS A PATH.
 *
 * ── WHY FAT, AND WHY A CLASS ──
 *
 * Bryan, 2026-10-26: "I do favor packing the complex bits, as much as possible into the parcel itself. Fat
 * object — so the behavior is always available and we don't need to make hard assumptions about how it's
 * used. It's like agent, usable everywhere and we should be able to exploit that."
 *
 * So behaviour travels WITH the file rather than living in a table a caller has to go and find. `Agent` is
 * the precedent and the three disciplines below are copied from it deliberately, because each is a trap
 * this object would otherwise fall into exactly as `Agent` nearly did.
 *
 * ── A · THE DISK SEAM: PURE RUNS ANYWHERE, PLATFORM IS INJECTED AND THROWS BY DEFAULT ──
 *
 * `Agent` is usable on both sides of the bridge for one reason: it reads ZERO disk, and its disk-capable
 * member keeps disk behind an injected reader that throws until main attaches a real one ( see
 * `LensObject`'s `DISK_IS_MAIN_ONLY` ). A parcel needs the same seam and needs it harder, because the heavy
 * work is main-only and unimportable here: pdf.js and a rasteriser cannot be pulled into a renderer bundle
 * at all.
 *
 * So the split is explicit. `claim`, `text` and `size` are PURE and run in either process. `parse` is
 * PLATFORM and runs through `FileParcel.parser`, which throws a named error until something main-side
 * installs the registry's pipeline. A renderer calling `parse` gets a sentence telling it which process
 * owns the answer, rather than a module-resolution failure three layers down.
 *
 * ── B · NEVER PERSIST, NEVER CACHE, A PARSED FORM ──
 *
 * `Agent` refuses to persist a composed context because a lens is a file editable out of band and a stored
 * composition would quietly lie. The identical hazard is live here and it FIRED TODAY: `PDF_PAGE_IMAGE_CAP`
 * moved from 10 to 30 on 2026-10-26, so a parcel that had cached "I rendered 10 pages" would now be stating
 * a number no code would produce, with nothing anywhere to catch it. Parsing is therefore COMPUTED on every
 * call, flush and fill — no memo field, no lazy getter, nothing stored. `text()` is the same: a fresh decode
 * each time, which costs a decode and cannot be stale.
 *
 * ── C · THE WIRE FORM IS NOT THE OBJECT, AND NOTHING HERE IS PERSISTED ──
 *
 * `serialize` carries the bytes and the claim, and NOTHING PARSED — not the text, not an image, not a page
 * count. A parcel is a TRANSIENT: it exists while a file is in flight and is then gone.
 *
 * THE STANDING RULE IT MUST NOT BREAK is that no file byte reaches `turn_entries`. Today an entry stores a
 * PATH, and the two transients that carry bytes ( `contents`, `imageData` ) are stripped by name in
 * `Transcript.entryPayload`. That strip is a destructuring of three named fields, so it would NOT catch a
 * parcel hung on an entry under any other name — a fat object that serialized itself whole into a stored
 * row is precisely how those bytes would end up in the database. A parcel is not a field on a persisted
 * record, and a card that wants one there owes `entryPayload` an edit and a test, not a workaround.
 *
 * ── AN ENVELOPE'S DESTINATION IS NOT DECIDED HERE ──
 *
 * Nothing on this class names a turn, a model or a message. The parcel is for moving a file around inside
 * the application, and a RECEIVER decides what becomes of it: frame it for a model, draw it live on a
 * surface, or write it somewhere. Only the first exists today and this module builds no other, but a field
 * named for the wire would have quietly made the wire the only possible destination.
 */

/** WHAT A FILE CLAIMS TO BE — the identity half of a parcel, and all that resolution looks at.
 *
 *  CLAIMS, not facts, and the word is chosen: a media type is whatever `Files.describe` could determine and
 *  an extension is whatever somebody typed. Both are routinely absent and either can be a lie. Nothing here
 *  is evidence about the bytes. */
export type FileByteClaim = {
	mediaType?: string | null
	ext?:       string | null
}

/** WHERE A PARCEL'S BYTES CAME FROM — identity, never capability. It says whose bytes these are, which a
 *  frame and a surface each have to word differently; it confers nothing, and no reader consults it to
 *  decide what may be touched.
 *
 *  A CLOSED UNION over the two sources that exist today: `attachment` is a person handing a file over, and
 *  `tool-result` is bytes an agent's own gated read produced. A third source is an edit here, which is
 *  right — a new origin wants a decision about how it is worded, not a string passed through. */
export type FileParcelOrigin = 'attachment' | 'tool-result'

/** ONE IMAGE A PARSE PRODUCED — self-describing, its media type beside its own bytes.
 *
 *  NOT the index-parallel `imageData` transient an entry stores: that shape works because exactly one
 *  caller fills it and one reads it, and only because a pair of arms agree out of band about what a page
 *  is. A parser is written by somebody who knows neither convention, so the media type travels with the
 *  bytes it describes. `data` is base64, as the wire wants it. */
export type ParcelImage = {
	mediaType: string
	data:      string
}

/** WHAT A PARSE PRODUCED, and never stored on the parcel — see discipline B above.
 *
 *  `by` is the id of the parser that produced this, so a caller can say which one handled a file in a trace
 *  line or a frame without resolving a second time and hoping the two answers agree.
 *
 *  `text` is the interpreted content and is always present — a parser that could not make sense of its bytes
 *  says so IN the text, loudly, rather than returning nothing and leaving a reader to guess whether the file
 *  was empty or the parse failed. That is the `framePdf` rule: a failure is a frame that explains itself,
 *  never silence and never a fall back to raw bytes.
 *
 *  `images` ride BESIDE the text and never instead of it, because the text is what stops a model believing
 *  it holds the whole document. Absent means none; empty means none and is not an error. */
export type ParcelContent = {
	by:      string
	text:    string
	images?: readonly ParcelImage[]
	/**
	 * WHAT WENT WRONG, for the CALLER to report — not an error channel and never a substitute for saying it in
	 * the text. A parser that half-failed says so to the MODEL in `text` ( the `framePdf` rule ); these are the
	 * same facts for an OPERATOR reading the trace.
	 *
	 * WHY THE CALLER LOGS THEM RATHER THAN THE PARSER. A parcel carries no path, so a parser cannot write the
	 * one field a diagnostic about a file most needs. The caller holds the path, the turn id and the session —
	 * so the parser reports the reason and whoever drove it supplies the context. Absent means nothing went
	 * wrong; a fault beside a perfectly good `text` is the partial case and is normal.
	 */
	faults?: readonly string[]
}

/** WHAT THE RECEIVER CAN ACCEPT — the destination's capabilities, never the file's own facts, which is why
 *  this is an argument to `parse` and not a field on the parcel.
 *
 *  `images` IS "MAY IMAGES RIDE", and it is load-bearing rather than a hint: rendering a document's pages is
 *  the expensive half of parsing one, and an eyeless model would have every image block dropped at the
 *  projection while the frame claimed they rode. So a parser asks before it spends, and the frame it writes
 *  tells the truth about what the receiver is actually holding. Absent is false — never report a capability
 *  the caller did not claim. */
export type ParseOptions = {
	images?: boolean
}

/** THE WIRE FORM. Bytes stay a `Uint8Array` because the structured-clone lane carries one natively and
 *  base64 would inflate the payload by a third for nothing. Deliberately NOT a JSON-safe shape: a parcel is
 *  a transient and is never written to a store, so the one property a stored document's `serialize` owes —
 *  survive `JSON.stringify` — is not one this owes. See discipline C. */
export type SerializedFileParcel = {
	name:      string
	origin:    FileParcelOrigin
	mediaType: string | null
	ext:       string
	bytes:     Uint8Array
}

/** Parses a parcel into content. Injected: the registry that owns the parser table lives main-side, and the
 *  heavy decoders it reaches are unimportable from a renderer bundle. */
export type ParcelParseFn = ( parcel: FileParcel, opts?: ParseOptions ) => Promise<ParcelContent>

/** Core parses nothing itself: main installs the registry's pipeline. Reaching this default is either a
 *  renderer asking for work it cannot do, or a boot that never installed the seam — and the two want
 *  different fixes, so the sentence names both. */
const PARSING_IS_MAIN_ONLY: ParcelParseFn = ( parcel ) => {
	throw new Error(
		`FileParcel.parse: parsing is a main-process capability and no parser is installed ( file: ${ parcel.name } ). `
		+ 'Main installs it from the transport registry; a renderer asks main for the content instead.'
	)
}

/** What a parcel is built from. `ext` is derived from `name` when it is not given, so no caller has to. */
export type FileParcelInit = FileByteClaim & {
	name:    string
	origin?: FileParcelOrigin
	bytes:   Uint8Array
}

export class FileParcel {

	/**
	 * THE INJECTED PARSE CAPABILITY — static, because the parser TABLE is a property of the install and not
	 * of one file, and a per-instance hook would mean every construction site had to know about the registry.
	 * That is the opposite of what a fat object is for.
	 *
	 * Throws by default. Main replaces it once; the renderer leaves it alone.
	 */
	static parser: ParcelParseFn = PARSING_IS_MAIN_ONLY

	/** The file's own name, for framing and for a chip. NEVER a path — see the header. */
	readonly name:      string
	readonly origin:    FileParcelOrigin
	readonly mediaType: string | null
	/** Lowercased, no dot, '' for none — `FileEntry.ext`'s form, derived from `name` when not supplied. */
	readonly ext:       string
	readonly bytes:     Uint8Array

	constructor( init: FileParcelInit ) {
		this.name      = init.name
		this.origin    = init.origin ?? 'attachment'
		this.mediaType = init.mediaType ?? null
		this.ext       = init.ext ? claimExt( init.ext ) : extensionOf( init.name )
		this.bytes     = init.bytes
	}

	/** Rebuild from the wire. MALFORMED IS NULL, WHOLE — a parcel missing its bytes or its name is not a
	 *  half-parcel to be repaired downstream; it is a message that did not arrive, and a caller that cannot
	 *  tell the difference will frame an empty file at a model as though it were empty on disk. */
	static fromSerialized( raw: unknown ): FileParcel | null {
		if( !raw || typeof raw !== 'object' || Array.isArray( raw ) ) return null
		const r = raw as Record<string, unknown>

		const name  = typeof r[ 'name' ] === 'string' ? r[ 'name' ] : ''
		const bytes = r[ 'bytes' ]
		if( !name || !( bytes instanceof Uint8Array ) ) return null

		const origin = r[ 'origin' ] === 'tool-result' ? 'tool-result' : 'attachment'
		return new FileParcel( {
			name, bytes, origin,
			mediaType: typeof r[ 'mediaType' ] === 'string' ? r[ 'mediaType' ] : null,
			ext:       typeof r[ 'ext' ] === 'string' ? r[ 'ext' ] : undefined
		} )
	}

	/** PURE. What this file claims to be — the only thing resolution looks at. */
	claim(): FileByteClaim {
		return { mediaType: this.mediaType, ext: this.ext }
	}

	/** PURE. The bytes as text, decoded FRESH on every call — never memoized, see discipline B.
	 *
	 *  UTF-8 WITH REPLACEMENT, never a throw. A `TextDecoder` in its default non-fatal mode turns an invalid
	 *  sequence into U+FFFD, so a binary file read as text arrives as visible mojibake rather than as an
	 *  exception three layers from the call that caused it. Every text parser and every preview surface wants
	 *  exactly this, which is why it lives here once instead of in each of them. */
	text(): string {
		return new TextDecoder().decode( this.bytes )
	}

	/** PURE. How many bytes — what a chip shows and what a cap compares against. */
	size(): number {
		return this.bytes.byteLength
	}

	/** PLATFORM. Parse this file into content, through whatever main installed. Computed every call: there
	 *  is no cache here and there must not be one ( discipline B ). Throws a named error when nothing is
	 *  installed, rather than answering an empty parse that would read as an empty file.
	 *
	 *  `async`, SO A FAILURE IS ALWAYS A REJECTION. The default throws synchronously, and a bare `return
	 *  FileParcel.parser( this )` would let that throw escape past the caller's `.catch()` and out of a
	 *  handler that had done everything right. One shape for every failure, which is the same rule main's
	 *  services keep: always respond, never throw across a boundary. */
	async parse( opts?: ParseOptions ): Promise<ParcelContent> {
		return FileParcel.parser( this, opts )
	}

	/** The wire form — bytes and claim, nothing parsed, nothing persisted. See discipline C. */
	serialize(): SerializedFileParcel {
		return {
			name:      this.name,
			origin:    this.origin,
			mediaType: this.mediaType,
			ext:       this.ext,
			bytes:     this.bytes
		}
	}

}

/** An extension in the one form matching compares: lowercased, no leading dot, '' for nothing. Exported
 *  because the parser declaration's matcher has to normalise the same way, and two spellings of "is this a
 *  `.sig`" is how a file resolves one way on one side of the bridge and another way on the other. */
export function claimExt( raw: string | null | undefined ): string {
	const seen = ( raw ?? '' ).trim().toLowerCase()
	return seen.startsWith( '.' ) ? seen.slice( 1 ) : seen
}

/** The extension of a FILE NAME. A dotfile with no second dot ( `.env` ) has no extension rather than an
 *  extension of `env` — the leading dot is the name, which is the reading every shell and every editor
 *  takes, and the other one would resolve `.gitignore` as a `gitignore` format.
 *
 *  EXPORTED so a caller holding a name but not yet a parcel resolves on the SAME extension the parcel will
 *  carry. Two spellings of "what kind of file is this" is how one side of a hand-off routes a file to one
 *  parser and the other side parses it with a different one. */
export function extensionOf( name: string ): string {
	const at = name.lastIndexOf( '.' )
	return at > 0 ? claimExt( name.slice( at + 1 ) ) : ''
}

/**
 * THE STRUCTURAL RULE, ASSERTED AT COMPILE TIME — `true` only while `K` is absent from `T`.
 *
 * The no-path guarantee is worth exactly as much as the thing that notices when somebody breaks it, and a
 * doc comment notices nothing. Declaring `path` ( or a principal, a grant or a reader ) on `FileParcel`
 * turns the companion constants in this module's test suite into `never`, and the typecheck fails naming the
 * field and the line. That is the cheapest check on this type and the strongest.
 */
export type WithoutField<K extends string, T> = K extends keyof T ? never : true
