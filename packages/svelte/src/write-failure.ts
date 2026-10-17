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
import type {
	FileError,
	GitError,
	RowWriteError,
	SyncError,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * An action the app refused before it changed anything, with the reason a
 * person reads: the app is closing, the file is being renamed, the note was
 * deleted elsewhere.
 */
export const ActionError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type ActionError = InferErrors<typeof ActionError>;

/** Every error `describeWriteError` words. */
export type DescribedError =
	| RowWriteError
	| FileError
	| GitError
	| SyncError
	| ActionError;

/** A save that failed, and what it held. */
export type WriteFailure = {
	/** The file the save was for. */
	readonly path: string;
	readonly error: DescribedError;
	/** The text that was typed and is not in the file; `''` when none is lost. */
	readonly unsaved: string;
	/**
	 * Send the edit again. Set when the edit is still on screen, so saving
	 * it again is all the person needs to do.
	 */
	readonly retry?: () => void;
};

const UNCONFIRMED =
	'The change was sent, but nothing confirmed it, so it may or may not have happened.';

/**
 * What a person is told about a failed write or action. A write that failed
 * wrote nothing (ADR-0576), unless its reply was lost, which leaves the
 * outcome unknown; an action the app refused says why.
 */
export function describeWriteError(error: DescribedError): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'Io':
			return (error.cause as FileError | undefined)?.name === 'Unconfirmed'
				? `${UNCONFIRMED} ${error.message}`
				: error.message;
		case 'Unconfirmed':
			return `${UNCONFIRMED} ${error.message}`;
		case 'InvalidValues':
			return error.issues.map((issue) => issue.message).join(' ');
		case 'Occupied':
			return 'Another file already has this name, so nothing was changed.';
		case 'KeptChanging':
			return 'The file kept changing elsewhere while it was saved, so the edit is not saved yet.';
		case 'NotFound':
			return 'The file is no longer in the folder, so nothing was changed.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'Closed':
			return 'The folder was closed, so nothing was changed.';
		default:
			return error.message;
	}
}
