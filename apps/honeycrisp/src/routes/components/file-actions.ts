/**
 * Actions the lists, the note view, and the file view share: open an item
 * (asking first when the open one holds a draft it could not save), and
 * delete with a confirmation that names what will be removed.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Deletion, Notes, OpenAs } from '$lib/notes.svelte.js';

function describe(deletion: Deletion) {
	switch (deletion.kind) {
		case 'file':
			return {
				title:
					deletion.title !== undefined
						? `Delete “${deletion.title}” permanently?`
						: `Delete ${basename(deletion.path)}?`,
				description: `This deletes ${deletion.path} from the folder. Committed versions stay in Git history.`,
			};
		case 'folder':
			return {
				title: `Delete the folder ${basename(deletion.path)}?`,
				description: `${deletion.path} is empty. Deleting it removes only the folder.`,
			};
	}
}

/**
 * Ask before deleting `path`. What the dialog names is captured first, and
 * the deletion applies only to that captured version.
 */
export async function confirmDelete(notes: Notes, path: string) {
	const { data: deletion, error: captureError } = await notes.deletionFor(path);
	if (captureError !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: captureError,
		});
		return;
	}
	confirmationDialog.open({
		...describe(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await notes.remove(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}

/**
 * Open `path`, asking first when the open item holds a draft it could not
 * save: discarding it lets the open proceed, cancelling keeps the item. The
 * discard applies to the session the open answered, the one the dialog
 * describes.
 */
export async function openItem(notes: Notes, path: string, as?: OpenAs) {
	const opening = await notes.open(path, { as });
	if (opening.kind !== 'unsaved') return;
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description:
			'The open file has changes that could not be saved. Discard them to open another file, or cancel to keep working on them.',
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			await notes.open(path, { as, discard: opening.session });
		},
	});
}
