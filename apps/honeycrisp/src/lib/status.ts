/**
 * What a person is told about saving: the header's one line, and the words
 * for a save, read, or action that failed.
 *
 * Notes are kept in this device's local folder, which keeps no versions and
 * syncs nowhere, so saving is the only fact the header reports. A note is
 * saved when its text is on this device.
 */
import type { WriteError, ReadError } from '@epicenter/folder/next';
import type { StatusLine } from '@epicenter/svelte/status-line';
import { extractErrorMessage } from 'wellcrafted/error';

/** What a person is told about a save, read, or delete that failed. */
export function describeFailure(error: WriteError | ReadError): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This device's storage refused it: ${extractErrorMessage(error.cause)}.`;
		case 'KeptChanging':
			return 'Its file kept changing elsewhere while it saved. Try the change again.';
		case 'Exists':
			return 'A file with that name was made elsewhere first.';
		case 'Closed':
			return 'The folder is closed.';
		case 'NothingToUpdate':
			return 'This file is no longer in the folder.';
		default:
			return error.message;
	}
}

/** The header's line, from the mirror's pending writes. */
export function saveLine(saving: boolean): StatusLine {
	if (saving) return { label: 'Saving…', tone: 'busy' };
	return { label: 'Saved on this device', short: 'Saved', tone: 'good' };
}
