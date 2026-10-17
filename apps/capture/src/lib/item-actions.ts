/**
 * Deleting a capture, with the confirmation it needs. The dialog says when
 * the capture has changes that are in no saved version.
 */

import { describeWriteError } from '@epicenter/svelte/write-failure';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures } from './captures.svelte.js';

/** Ask before deleting the capture at `stem`; the delete acts on what this window saved last. */
export async function confirmDelete(captures: Captures, stem: string) {
	const { data: deletion, error } = await captures.deletionFor(stem);
	if (error !== null) {
		toast.error('The capture was not deleted', {
			description: describeWriteError(error),
		});
		return;
	}
	const named = deletion.title ? `“${deletion.title}” ` : 'This capture ';
	const unversioned = deletion.unversioned
		? ' Its latest changes are in no saved version, so they cannot be brought back.'
		: ' Saved versions stay in its history.';
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${named}and its thoughts are deleted from the folder.${unversioned}`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await captures.delete(deletion);
			if (error !== null)
				toast.error('The capture was not deleted', {
					description: describeWriteError(error),
				});
		},
	});
}
