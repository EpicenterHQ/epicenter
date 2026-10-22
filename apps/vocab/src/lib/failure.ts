/** What a learner is told about a save, read, or action that failed. */
import type { ReadError, SaveError } from '@epicenter/folder';
import type { ActionError } from '@epicenter/folder/edits';
import { extractErrorMessage } from 'wellcrafted/error';

export function describeFailure(
	error: SaveError | ReadError | ActionError,
): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This browser's storage refused it: ${extractErrorMessage(error.cause)}.`;
		case 'Closing':
			return error.message;
		case 'Unparseable':
			return `Its file cannot be edited as a word: ${error.reason}.`;
		case 'NotText':
			return 'Its file is not text, so Vocab cannot change it.';
		default:
			return error.message;
	}
}

/** Why nothing starts once Vocab's folder is closing. */
export const CLOSING = 'Vocab is closing, so nothing was saved.';

/**
 * A call on a closed folder throws: Vocab turns that into a refusal, so a
 * save or a read that starts while the page closes answers instead of
 * rejecting.
 */
export async function untilClosed<T, U>(
	work: () => Promise<T>,
	closed: (cause: unknown) => U,
): Promise<T | U> {
	try {
		return await work();
	} catch (cause) {
		return closed(cause);
	}
}
