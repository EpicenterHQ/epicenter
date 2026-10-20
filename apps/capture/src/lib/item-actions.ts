/**
 * Deleting a capture, with the confirmation it needs. There is no history on
 * this path, so a deleted capture cannot be brought back.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { type Captures, describeFailure } from './captures.svelte.js';

/** Ask before deleting the capture at `stem`; the delete acts on the file as stored when it runs. */
export function confirmDelete(captures: Captures, stem: string) {
	const deletion = captures.deletionFor(stem);
	const named = deletion.title ? `“${deletion.title}” ` : 'This capture ';
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${named}and its thoughts are deleted from this device. A deleted capture cannot be brought back.`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { data, error } = await captures.delete(deletion);
			if (error !== null)
				toast.error('The capture was not deleted', {
					description: describeFailure(error),
				});
			else if (!data.deleted && captures.isStored(stem))
				toast.error('The capture was not deleted', {
					description:
						'It changed while it was being deleted, so it was kept.',
				});
		},
	});
}
