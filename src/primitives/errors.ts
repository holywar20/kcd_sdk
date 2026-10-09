import type { ValidateIssue } from '../core/html/KcdValidate';

export class KCDParseError extends Error {
	readonly path: string;
	readonly rawContent: string;
	readonly line?: number;

	constructor(message: string, path: string, rawContent: string, line?: number) {
		super(message);
		this.name = 'KCDParseError';
		this.path = path;
		this.rawContent = rawContent;
		this.line = line;
	}
}

export class KCDValidationError extends Error {
	readonly path: string;
	readonly expected: string;
	readonly got: string | null;
	readonly field?: string;
	readonly section?: string;
	/**
	 * Every finding, not only the one `message` names. A consumer that rebuilds from `message` counts N errors as 1,
	 * and a repair loop reads that as progress. `message` is unchanged and still names the first.
	 */
	readonly errors: ValidateIssue[];

	constructor(
		message: string,
		path: string,
		expected: string,
		got: string | null,
		opts?: { field?: string; section?: string; errors?: ValidateIssue[] }
	) {
		super(message);
		this.name = 'KCDValidationError';
		this.path = path;
		this.expected = expected;
		this.got = got;
		this.field = opts?.field;
		this.section = opts?.section;
		this.errors = opts?.errors ?? [];
	}
}
