/**
 * Why a note does not read, in one line a person can be shown: each issue
 * as `field: message` (the message alone when it is about the note as a
 * whole, such as front matter that does not parse), joined by `; `.
 *
 * The issues are the ones a client lists with an invalid note
 * (`InvalidNoteOf['issues']`) or refuses a write with (`Invalid`).
 *
 * @example
 * ```ts
 * describeIssues([{ field: 'done', message: 'is required' }]); // 'done: is required'
 * ```
 */
/** A field diagnostic. Messages and diagnostic counts are not machine contracts. */
export type ConformanceIssue = {
	field: string;
	/** JSON pointer within the field value, when the validator identifies it. */
	path?: string;
	message: string;
};

export const describeIssues = (
	issues: readonly Pick<ConformanceIssue, 'field' | 'message'>[],
) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');
