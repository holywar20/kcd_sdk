import { KCDPrimitive } from './KCDPrimitive';
import type { SerializedArtifact } from '../types';

/** One finding as it can be read WITHOUT knowing a report's shape — its stable id and its heading
 *  text. Deliberately not the finding record: severity, evidence and verdict live in a table whose
 *  columns are the analyzer's business, not this type's. */
export interface AuditEntry {
	id:    string;
	title: string;
	/** A parenthetical the heading carried after the id — `retired`, `re-confirmed`. Reports use it to
	 *  mark an entry's standing, and it is kept verbatim rather than interpreted here. */
	note:  string;
}

/** Every heading in the body, inner markup included — the pool `getEntries` filters. Matched whole
 *  rather than up to the first tag because a finding title routinely wraps a symbol in `<code>`, and
 *  a pattern that stopped there would silently truncate exactly the titles worth reading. */
const HEADING_RE = /<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/g;

/** `TRACK-NN` leading a heading — the one convention `audit-finding` fixes across every analyzer. */
const ENTRY_RE = /^([A-Z][A-Z0-9]*-\d+)\b\s*(?:\(([^)]*)\))?\s*[·—–-]*\s*([\s\S]*)$/;

/**
 * An audit: what a generator or analyzer emitted, kept as a record. Free-form by design — the
 * shape table declares no required sections, because the report a track needs is the track's
 * business and pinning it here would make the analyzer serve the type rather than the reader.
 *
 * It exists as its own class for one reason: so a report crosses the bridge as a report. Without a
 * registered hydrator every audit arrives as a bare `KCDPrimitive` carrying the right `type` string
 * and none of the behavior, which is the absence-wearing-the-clothes-of-a-working-thing failure
 * this project keeps re-finding.
 */
export class AuditObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'audit' );
	}

	static fromSerialized( json: SerializedArtifact ): AuditObject {
		const obj = new AuditObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	// getRole: inherits 'know' from KCDPrimitive — a record is read, never executed.

	/** Which analyzer or generator produced this run. `origin` is the declared answer; the filename
	 *  stem is the fallback, and it is right for every report in the vault today because a report is
	 *  named for the analyzer that owns it. */
	getAnalyzer(): string {
		const origin = this.frontmatter[ 'origin' ];
		if ( typeof origin === 'string' && origin ) return origin;
		return this.getName();
	}

	/**
	 * The findings this report carries, read off their headings.
	 *
	 * THIS READS A CONVENTION, NOT A SCHEMA, and the difference is the whole reason it is safe to put
	 * on a free-form type. `audit-finding` fixes one thing across every analyzer — a stable `TRACK-NN`
	 * id leading the finding's heading — and that is all this looks for. A report that groups its
	 * findings by document, by severity, or not at all reads identically here.
	 *
	 * An empty array means "no findings matched the convention", which covers a clean run and an
	 * unconventional report alike. That ambiguity is accepted rather than hidden: the alternative is
	 * throwing on a document the validator considers valid, and a record that refuses to be read is
	 * worse than one that reads thin.
	 */
	getEntries(): AuditEntry[] {
		const out: AuditEntry[] = [];
		const seen = new Set<string>();

		for ( const heading of this.body.matchAll( HEADING_RE ) ) {
			const text  = AuditObject.stripTags( heading[ 1 ] );
			const entry = ENTRY_RE.exec( text );
			if ( !entry ) continue;

			const id = entry[ 1 ];
			// First heading wins. A roll-up cites an id it does not own, and a report may restate one
			// in an index — neither is a second finding.
			if ( seen.has( id ) ) continue;
			seen.add( id );

			out.push( { id, note: entry[ 2 ]?.trim() ?? '', title: entry[ 3 ].trim() } );
		}

		return out;
	}

	/** Heading markup → its text. Inline only ( `<code>`, `<strong>`, `<em>` ), which is all a
	 *  heading carries — this is not a parser and does not want to become one. */
	private static stripTags( html: string ): string {
		return html.replace( /<[^>]*>/g, '' ).replace( /\s+/g, ' ' ).trim();
	}
}
