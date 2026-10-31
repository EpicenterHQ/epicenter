/**
 * Deleting a capture, with the confirmation it needs. The capture is
 * deleted from the person's repository, whose Git history keeps it.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures } from './captures.svelte.js';

/** Ask before deleting the capture `id`; the delete acts on the capture as shown when it runs. */
export function confirmDelete(captures: Captures, id: string) {
	const deletion = captures.deletionFor(id);
	const named = deletion.title ? `“${deletion.title}” ` : 'This capture ';
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${named}and its thoughts are deleted from your repository. Its Git history keeps them.`,
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
