/**
 * Actions the file browser, the todo editor, and the file view share: open
 * an item, and delete with a confirmation that names what will be removed.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Deletion, Todos, Workspace } from '$lib/todos.svelte.js';

function describe(deletion: Deletion) {
	switch (deletion.kind) {
		case 'todo':
			return {
				title: `Delete “${deletion.title}”?`,
				description: `This deletes ${deletion.path} from the folder. Committed versions stay in Git history.`,
			};
		case 'file':
			return {
				title: `Delete ${basename(deletion.path)}?`,
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
export async function confirmDelete(todos: Todos, path: string) {
	const { data: deletion, error: captureError } = await todos.deletionFor(path);
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
			const problem = await todos.remove(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}

/**
 * Open `path`, asking first when the open item holds a draft it could not
 * save: discarding it lets the open proceed, cancelling keeps the item.
 */
export async function openItem(
	todos: Todos,
	path: string,
	workspace: Workspace,
) {
	const opening = await todos.open(path, workspace);
	if (opening.kind !== 'unsaved') return;
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description:
			'The open file has changes that could not be saved. Discard them to open another file, or cancel to keep working on them.',
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			// The session the open answered: confirming discards that draft only.
			await todos.open(path, workspace, { discard: opening.session });
		},
	});
}
