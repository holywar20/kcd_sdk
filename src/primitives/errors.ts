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
	 * EVERY finding, not only the one the message names.
	 *
	 * `message` can carry one error and one alone — it is a sentence — so a document failing on four
	 * counts threw a sentence about the first, and every consumer that rebuilt a report from
	 * `e.message` reported N errors as 1. That reads as PROGRESS to a repair loop: fix the named
	 * error, re-run, meet the next one, and the tally falls by one each pass while the document is
	 * still broken. Found 2026-09-10 against a live migration, where a whole-vault sweep said 13 and
	 * the truth was 34.
	 *
	 * The message is unchanged and still names the first error — anything reading it keeps working.
	 * This is the list beside it, for a consumer that wants the whole set.
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
