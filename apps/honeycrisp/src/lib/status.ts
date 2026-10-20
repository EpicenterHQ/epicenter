/**
 * What a person is told about saving: the header's one line, and the words
 * for a save, read, or action that failed.
 *
 * Notes are kept in this device's local folder, which keeps no versions and
 * syncs nowhere, so saving is the only fact the header reports. A note is
 * saved when its text is on this device.
 */
import type { ReadError, SaveError } from '@epicenter/folder';
import type { SaveState } from '@epicenter/svelte/folder';
import type { StatusLine } from '@epicenter/svelte/status-line';
import type { ActionError } from '@epicenter/svelte/write-failure';
import { extractErrorMessage } from 'wellcrafted/error';

/** What a person is told about a save, read, or delete that failed. */
export function describeFailure(
	error: SaveError | ReadError | ActionError,
): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This device's storage refused it: ${extractErrorMessage(error.cause)}.`;
		case 'NotStarted':
			return error.reason;
		case 'Unparseable':
			return `Its file cannot be edited as a note: ${error.reason}. Edit it as a file instead.`;
		case 'NotText':
			return 'Its file is not text, so Honeycrisp cannot change it.';
		case 'Occupied':
			return `${error.existing} is already a ${error.kind === 'file' ? 'file' : 'folder'}, so nothing was saved there.`;
		case 'CaseTwin':
			return `${error.existing} differs only in upper and lower case, so nothing was saved.`;
		default:
			return error.message;
	}
}

/**
 * The header's line: whether everything typed is saved on this device.
 * Pending row and whole-file edits share `state` and `failures`.
 */
export function saveLine({
	state,
	failures,
	storageFailure,
}: {
	state: SaveState;
	failures: readonly { readonly error: SaveError | undefined }[];
	storageFailure: SaveError | null;
}): StatusLine {
	const reasons = [
		...failures.flatMap(({ error }) => (error ? [describeFailure(error)] : [])),
	];
	if (state === 'failed')
		return {
			label: 'Not saved',
			detail:
				[...new Set(reasons)].join('\n') ||
				'A save failed. The edit is still on screen, and it saves again with your next change or Save again.',
			tone: 'error',
		};
	if (state === 'saving') return { label: 'Saving…', tone: 'busy' };
	if (state === 'recent-failure')
		return {
			label: 'A save failed',
			detail: storageFailure ? describeFailure(storageFailure) : undefined,
			tone: 'error',
		};
	return { label: 'Saved on this device', short: 'Saved', tone: 'good' };
}
