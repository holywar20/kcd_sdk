import { KCDPrimitive } from './KCDPrimitive';
import { HtmlTree } from '../../core/html/HtmlTree';
import type { HtmlEl } from '../../core/html/HtmlTree';
import { KcdAddress } from '../../core/html/KcdAddress';
import type { SerializedArtifact } from '../types';

/**
 * The task board's fields, keyed by Task property name, as plain strings: the SDK cannot import the board's types.
 * Three gaps are carried for the rationalizing pass: `verifiedBy` has no Task twin, `approval` has no word for a
 * verifier other than the repairer, and `needs-human` is a state here but an ask there.
 */
export interface BugReportTaskFields {
	name:          string;
	title:         string;
	body:          string;
	category:      'bugfix';
	state:         string;
	createdAt:     string;
	updatedAt:     string;
	raisedBy:      string;
	priority:      string;
	exitCondition: string;
	assignee:      string;
	startedAt:     string;
	approval:      string;
	verifiedBy:    string;
	endedAt:       string;
}

/** The body fields a report annotates, in the section each belongs to. The field name IS the Task
 *  property; the frontmatter supplies the rest. */
export const BUG_REPORT_BODY_FIELDS = [
	'raisedBy', 'priority', 'exitCondition',   // report
	'assignee', 'startedAt',                   // repair
	'verifiedBy', 'approval', 'endedAt',       // verification
] as const;

/**
 * A filed defect and the proof of its repair: a record, read not executed. `taskFields()` reads by field name and
 * never interprets prose, which is what keeps a board import mechanical.
 */
export class BugReportObject extends KCDPrimitive {

	protected constructor( filePath: string ) {
		super( filePath, 'bug-report' );
	}

	static fromSerialized( json: SerializedArtifact ): BugReportObject {
		const obj = new BugReportObject( json.path );
		obj.hydrateFrom( json );
		return obj;
	}

	/** The report's fields keyed by Task property. An absent field reads `''` — not filed yet, not a
	 *  defect: a queued report has no assignee and that is its correct state. */
	taskFields(): BugReportTaskFields {
		const tree   = HtmlTree.parse( this.body );
		const fields = this.bodyFields( tree );

		return {
			name:          this.getName(),
			title:         this.frontmatterText( 'description' ),
			body:          this.sectionText( tree, 'report' ),
			category:      'bugfix',
			state:         this.frontmatterText( 'status' ),
			createdAt:     this.frontmatterText( 'created' ),
			updatedAt:     this.frontmatterText( 'updated' ),
			raisedBy:      fields[ 'raisedBy' ] ?? '',
			priority:      fields[ 'priority' ] ?? '',
			exitCondition: fields[ 'exitCondition' ] ?? '',
			assignee:      fields[ 'assignee' ] ?? '',
			startedAt:     fields[ 'startedAt' ] ?? '',
			approval:      fields[ 'approval' ] ?? '',
			verifiedBy:    fields[ 'verifiedBy' ] ?? '',
			endedAt:       fields[ 'endedAt' ] ?? '',
		};
	}

	/** Every annotated body field this type reads, first occurrence wins. */
	private bodyFields( tree: HtmlEl ): Record<string, string> {
		const out: Record<string, string> = {};

		for ( const el of HtmlTree.collect( tree, d => KcdAddress.isField( d ) ) ) {
			const key = HtmlTree.get( el, 'data-kcd-field' ) ?? '';
			if ( !( BUG_REPORT_BODY_FIELDS as readonly string[] ).includes( key ) ) continue;
			if ( key in out ) continue;
			out[ key ] = KcdAddress.fieldValue( el, HtmlTree.get( el, 'data-kcd-type' ) ).value;
		}

		return out;
	}

	private sectionText( tree: HtmlEl, name: string ): string {
		const section = HtmlTree.first( tree, d => HtmlTree.get( d, 'data-kcd-section' ) === name );
		if ( !section ) return '';
		return HtmlTree.textOf( section ).replace( /\s+/g, ' ' ).trim();
	}

	private frontmatterText( key: string ): string {
		const value = this.frontmatter[ key ];
		return typeof value === 'string' ? value : '';
	}
}
