/**
 * What a person is told about saving: the header's one line, and the words
 * for a save, read, or action that failed.
 *
 * Notes are kept in this device's local folder, which keeps no versions and
 * syncs nowhere, so saving is the only fact the header reports. A note is
 * saved when its text is on this device.
 */
import type { FolderStatus, ReadError, SaveError } from '@epicenter/folder';
import type { StatusLine } from '@epicenter/svelte/status-line';
import type { ActionError } from '@epicenter/folder/edits';
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
 * Pending row and whole-file edits share one Folder status.
 */
export function saveLine({
	failures,
	saving,
	unsaved,
	storageFailure,
}: FolderStatus): StatusLine {
	const reasons = [
		...failures.flatMap(({ error }) => (error ? [describeFailure(error)] : [])),
	];
	if (failures.length > 0)
		return {
			label: 'Not saved',
			detail:
				[...new Set(reasons)].join('\n') ||
				'A save failed. The edit is still on screen, and it saves again with your next change or Save again.',
			tone: 'error',
		};
	if (saving || unsaved.length > 0) return { label: 'Saving…', tone: 'busy' };
	if (storageFailure !== null)
		return {
			label: 'A save failed',
			detail: describeFailure(storageFailure),
			tone: 'error',
		};
	return { label: 'Saved on this device', short: 'Saved', tone: 'good' };
}
