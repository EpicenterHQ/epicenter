/**
 * Deleting a capture, with the confirmation it needs. A capture still in
 * this browser has no history, so deleting it cannot be undone here; one in
 * the repository stays in its Git history.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures } from './captures.svelte.js';

/** Ask before deleting the capture `id`; the delete acts on the capture as shown when it runs. */
export function confirmDelete(captures: Captures, id: string) {
	const deletion = captures.deletionFor(id);
	const named = deletion.title ? `“${deletion.title}” ` : 'This capture ';
	const inRepository = captures.list.where({ id }) === 'repository';
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: inRepository
			? `${named}and its thoughts are deleted from your repository. Its Git history keeps them.`
			: `${named}and its thoughts are deleted from this browser. A deleted capture cannot be brought back.`,
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
