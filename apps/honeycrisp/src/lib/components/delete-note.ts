/**
 * Deleting a note, asked first: the list's menu and the note's own Delete
 * share the question. The delete never fails, so the dialog closes at once
 * and the note goes once the delete lands (ADR-0775).
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
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
		onConfirm() {
			void app.deleteNote(id);
		},
	});
}
