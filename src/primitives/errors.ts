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

	constructor(
		message: string,
		path: string,
		expected: string,
		got: string | null,
		opts?: { field?: string; section?: string }
	) {
		super(message);
		this.name = 'KCDValidationError';
		this.path = path;
		this.expected = expected;
		this.got = got;
		this.field = opts?.field;
		this.section = opts?.section;
	}
}
