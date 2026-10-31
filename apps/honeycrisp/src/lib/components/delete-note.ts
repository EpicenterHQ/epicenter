/**
 * Deleting a note, asked first: the list's menu and the note's own Delete
 * share the question and what is said when it fails.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import {
	type HoneycrispState,
	notePath,
	type Side,
} from '$lib/honeycrisp.svelte.js';

/** Ask, then delete the note `id`, whose name is `label`, from where its copy is. */
export function confirmDeleteNote(
	app: HoneycrispState,
	{ id, label, where }: { id: string; label: string; where: Side },
) {
	confirmationDialog.open({
		title: `Delete “${label}”?`,
		description: `This deletes ${notePath(id)} from ${where === 'repository' ? 'your repository' : 'this device'}.`,
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
