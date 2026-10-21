/**
 * What a folder app tells a person when a save fails, worded once.
 *
 * A library error states the failure precisely; this module decides what a
 * person reads about it. `<FolderApp>` shows every `WriteFailure` as one
 * toast that offers the text the file does not hold, so typed text is never
 * lost without the person being told and handed it.
 *
 * Plain module: a store imports it without loading Svelte components.
 */
import type { SaveError } from '@epicenter/folder';
import type { ActionError, Pending } from '@epicenter/folder/edits';

/** The errors `describeWriteError` words by name. */
export type DescribedError = SaveError | ActionError;

/**
 * Any other failure an app reports, such as an agent's message store
 * refusing a save: a person reads its message.
 */
export type OtherError = { readonly name: string; readonly message: string };

/** A save that failed, and what it held. */
export type WriteFailure = {
	/** The file the save was for. */
	readonly path: string;
	readonly error: DescribedError | OtherError;
	/** The text that was typed and is not in the file; `''` when none is lost. */
	readonly unsaved: string;
	/**
	 * Send the edit again, answering whether a save started. Set when the
	 * edit is still on screen, so saving it again is all the person needs to
	 * do. When none starts, the toast stays up with the text to copy.
	 */
	readonly save?: () => boolean;
	/**
	 * Let go of the edit still on screen, answering the text it let go: what
	 * is typed now, which can be newer than `unsaved`, or `undefined` when
	 * the edit was already gone. The file keeps what it holds, and the
	 * notice keeps that text to copy. Set while an edit is held, so a save
	 * that keeps failing, or typing that cannot be sent, never traps the
	 * person in an edit that blocks a rename or delete.
	 */
	readonly discard?: () => string | undefined;
};

/** The exact held source a person can copy. */
export function unsavedText(pending: Pending): string {
	return pending.text;
}

/** The failure a person is shown for held input that did not save. */
export function pendingFailure(pending: Pending): WriteFailure {
	return {
		path: pending.path,
		error: pending.error ?? {
			name: 'Unsaved',
			message: 'The edit did not save.',
		},
		unsaved: unsavedText(pending),
	};
}

/**
 * What a person is told about a failed save or action.
 */
export function describeWriteError(error: DescribedError | OtherError): string {
	if (error.name === 'Occupied')
		return 'Another file already has this name, so nothing was changed.';
	return error.message;
}
