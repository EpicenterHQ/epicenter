/**
 * What a person is told about a failure. The store returns typed errors and
 * never words them; components call this where they show one.
 */
import type { FileError, RowWriteError } from '@epicenter/folder';
import type { TodosError } from './session.js';

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A write that failed wrote nothing (ADR-0576), unless its reply was
 * lost, which leaves the outcome unknown; an action Todos did not start
 * says why.
 */
export function describeError(error: RowWriteError | TodosError): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'Io':
			return (error.cause as FileError | undefined)?.name === 'Unconfirmed'
				? `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`
				: error.message;
		case 'InvalidValues':
			return error.issues.map((issue) => issue.message).join(' ');
		case 'Occupied':
			return 'Another file already has this name, so nothing was changed.';
		default:
			return error.message;
	}
}
