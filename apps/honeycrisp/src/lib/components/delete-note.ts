/**
 * Deleting a note, asked first: the list's menu and the note's own Delete
 * share the question and what is said when it fails.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { type HoneycrispState, notePath } from '$lib/honeycrisp.svelte.js';

/** Ask, then delete the note `id`, whose name is `label`, from the page's store. */
export function confirmDeleteNote(
	app: HoneycrispState,
	{ id, label }: { id: string; label: string },
) {
	confirmationDialog.open({
		title: `Delete “${label}”?`,
		description: `This deletes ${notePath(id)}.`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await app.deleteNote(id);
			if (error !== null)
				toast.error('Could not delete the note', {
					description: error.message,
				});
		},
	});
}
