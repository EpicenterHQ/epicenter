/**
 * What a folder app tells a person when a save fails, worded once.
 *
 * A library error states the failure precisely; this module decides what a
 * person reads about it. Apps can present a `WriteFailure` with the
 * text available to copy while the folder is open.
 *
 * Plain module: a store imports it without loading Svelte components.
 */
import type { SaveError } from '@epicenter/folder';
import type { ActionError } from '@epicenter/folder/edits';

/** The errors `describeWriteError` words by name. */
export type DescribedError = SaveError | ActionError;

/**
 * Any other failure an app reports, such as an agent's message store
 * refusing a save: a person reads its message.
 */
export type OtherError = { readonly name: string; readonly message: string };

/** A save that failed, and the current text its owner can still provide. */
export type WriteFailure = {
	/** The file the save was for. */
	readonly path: string;
	readonly error: DescribedError | OtherError;
	/** The text the person can copy now, or `undefined` when none remains. */
	readonly getText: () => string | undefined;
	/**
	 * Send the edit again, answering whether a save started. Set when the
	 * edit is still on screen, so saving it again is all the person needs to
	 * do. When none starts, the toast stays up with the text to copy.
	 */
	readonly save?: () => boolean;
	/**
	 * Let go of the edit still on screen, answering the text it let go: what
	 * is typed now, which can be newer than an earlier notice, or `undefined`
	 * when the edit was already gone. The file keeps what it holds, and the
	 * notice keeps that text to copy. Set while an edit is held, so a save
	 * that keeps failing never leaves the person with input they cannot
	 * drop.
	 */
	readonly discard?: () => string | undefined;
};

/**
 * What a person is told about a failed save or action.
 */
export function describeWriteError(error: DescribedError | OtherError): string {
	if (error.name === 'Occupied')
		return 'Another file already has this name, so nothing was changed.';
	return error.message;
}
