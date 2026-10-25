import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import type { Entry } from '$lib/data.js';
import type { Entries } from '$lib/entries.svelte.js';

export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description: 'Its note and stage are deleted with it.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			await entries.delete(entry.id);
		},
	});
}
