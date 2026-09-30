/**
 * Actions the file browser, the todo editor, and the file view share: copy a
 * path, and delete with a confirmation that names what will be removed.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { basename } from '$lib/files.js';
import type { Deletion, Todos } from '$lib/todos.svelte.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

function describe(deletion: Deletion) {
	switch (deletion.kind) {
		case 'todo': {
			const { entry } = deletion;
			const title =
				typeof entry.fields.title === 'string' &&
				entry.fields.title.trim() !== ''
					? entry.fields.title
					: basename(entry.path);
			return {
				title: `Delete “${title}”?`,
				description: `This deletes ${entry.path}${entry.attachment ? ` and its attachment ${entry.attachment}` : ''} from the folder. Committed versions stay in Git history.`,
			};
		}
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
	const captured = await todos.deletionFor(path);
	if (captured.error !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: captured.error,
		});
		return;
	}
	const deletion = captured.data;
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
