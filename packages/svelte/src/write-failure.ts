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

/** The errors `describeWriteError` words by name. */
export type DescribedError =
	| RowWriteError
	| FileError
	| GitError
	| SyncError
	| ActionError;

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
	readonly retry?: () => boolean;
};

/**
 * The text fields of a set that failed, as a person reads them back: one
 * `name: value` line for each string field sent, so a typed title or note
 * is offered to copy. Other fields, such as a checkbox, are not text the
 * person typed; `''` when no field was text.
 */
export function unsavedFields(
	fields: Readonly<Record<string, unknown>>,
): string {
	return Object.entries(fields)
		.filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[1] !== '',
		)
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
}

const UNCONFIRMED =
	'The change was sent, but nothing confirmed it, so it may or may not have happened.';

/**
 * What a person is told about a failed write or action. A write that failed
 * wrote nothing (ADR-0576), unless its reply was lost, which leaves the
 * outcome unknown; an action the app refused says why. Any other error is
 * its message.
 */
export function describeWriteError(error: DescribedError | OtherError): string {
	// Narrowed by name. A field is checked where an error of another kind
	// could share the name.
	const known = error as DescribedError;
	switch (known.name) {
		case 'NotStarted':
			return 'reason' in known ? known.reason : error.message;
		case 'Io':
			return (known.cause as FileError | undefined)?.name === 'Unconfirmed'
				? `${UNCONFIRMED} ${known.message}`
				: error.message;
		case 'Unconfirmed':
			return `${UNCONFIRMED} ${known.message}`;
		case 'InvalidValues':
			return 'issues' in known
				? known.issues.map((issue) => issue.message).join(' ')
				: error.message;
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
			return known.message;
	}
}
