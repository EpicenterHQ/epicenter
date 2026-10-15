/** Delete a word with a confirmation that names it. */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Entry } from '$lib/data.js';
import { describeError, type Entries } from '$lib/entries.svelte.js';

/**
 * Ask before deleting `entry`. The delete waits for the word's save still
 * under way, so it removes what this page saved last.
 */
export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description: 'Its note and stage are deleted with it.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await entries.remove(entry);
			if (error !== null)
				toast.error(`Could not delete “${entry.text}”`, {
					description: describeError(error),
				});
		},
	});
}
