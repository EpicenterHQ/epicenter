import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Entry, Stage } from '$lib/data.js';
import type { Entries } from '$lib/entries.svelte.js';

export async function changeStage(entries: Entries, id: string, stage: Stage) {
	const { error } = await entries.setStage(id, stage);
	if (error !== null)
		toast.error('The stage was not saved', { description: error.message });
}

export function confirmDelete(entries: Entries, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description: 'Its note and stage are deleted with it.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await entries.delete(entry.id);
			if (error !== null)
				toast.error('The word was not deleted', { description: error.message });
		},
	});
}
