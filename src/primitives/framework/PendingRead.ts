/**
 * What a reader throws for a document it does not have YET — a fetch still in flight, not a missing file.
 *
 * A lens that reads on access records the path, carries on without it, and asks again on its next access. Any
 * other throw means the document is not there, and the lens settles without it. Main's reader is disk and never
 * throws this, which is why a compile in main is always complete.
 */
export class PendingRead extends Error {
	readonly path: string;

	constructor( path: string ) {
		super( `Not read yet: ${ path }` );
		this.name = 'PendingRead';
		this.path = path;
	}
}
