/**
 * Deleting a capture, with the confirmation it needs. There is no history on
 * this path, so a deleted capture cannot be brought back.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures } from './captures.svelte.js';

/** Ask before deleting the capture at `stem`; the delete acts on the file as stored when it runs. */
export function confirmDelete(captures: Captures, stem: string) {
	const deletion = captures.deletionFor(stem);
	const named = deletion.title ? `“${deletion.title}” ` : 'This capture ';
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${named}and its thoughts are deleted from this device. A deleted capture cannot be brought back.`,
		confirm: {
			text: 'Delete',
			variant: 'destructive',
		},
		onConfirm: async () => {
			const deleted = await captures.delete(deletion);
			if (deleted.error !== null)
				toast.error('Could not delete this capture', {
					description: deleted.error.message,
				});
		},
	});
}
