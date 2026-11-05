import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import type { Entry } from '$lib/data.js';
import type { Entries } from '$lib/entries.svelte.js';

export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description:
			'It is deleted from your repository with its note and stage. Its Git history keeps them.',
		confirm: { text: 'Delete', variant: 'destructive' },
		onConfirm: () => entries.delete(entry.id),
	});
}
