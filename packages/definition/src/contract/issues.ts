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
import type { ConformanceIssue } from '../declaration.js';

export type { ConformanceIssue };

export const describeIssues = (
	issues: readonly Pick<ConformanceIssue, 'field' | 'message'>[],
) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');
