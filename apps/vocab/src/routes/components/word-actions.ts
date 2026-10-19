/** Delete a word with a confirmation that names it. */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Entry } from '$lib/data.js';
import type { Entries } from '$lib/entries.svelte.js';
import { describeFailure } from '$lib/failure.js';

/**
 * Ask before deleting `entry`. The delete waits for the word's save still
 * under way, so what this page saved last goes with it. A word changed in
 * that moment, here or in another tab, is kept.
 */
export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description: 'Its note and stage are deleted with it.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { data, error } = await entries.delete(entry);
			if (error !== null)
				toast.error(`Could not delete “${entry.text}”`, {
					description: describeFailure(error),
				});
			else if (!data.deleted)
				toast.error(`“${entry.text}” was not deleted`, {
					description: 'It changed while it was being deleted, so it was kept.',
				});
		},
	});
}
