/** Delete a word with a confirmation that names it. */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Entry } from '$lib/data.js';
import type { Entries } from '$lib/entries.svelte.js';
import { describeFailure } from '$lib/failure.js';

/**
 * Ask before deleting `entry`. Already admitted saves finish before the delete. New input may recreate the path.
 */
export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description: 'Its note and stage are deleted with it.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await entries.delete(entry);
			if (error !== null)
				toast.error(`Could not delete “${entry.text}”`, {
					description: describeFailure(error),
				});
		},
	});
}
