/**
 * Actions the file browser, the todo editor, and the file view share: copy a
 * path, and delete with a confirmation that names what will be removed and
 * whether its latest changes are in no saved version.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeError } from '$lib/describe-error.js';
import { type Deletion, todos } from '$lib/todos.svelte.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

/** What deleting a file loses: nothing a version holds, or changes no version has. */
function history(deletion: Extract<Deletion, { kind: 'todo' | 'file' }>) {
	if (deletion.unversioned === undefined)
		return 'Todos could not check whether its latest changes are in a saved version, so they may be lost.';
	return deletion.unversioned
		? 'Its latest changes are in no saved version, so deleting it loses them. Save a version first to keep them in history.'
		: 'Its current text is in the last saved version.';
}

export function describeDeletion(deletion: Deletion) {
	switch (deletion.kind) {
		case 'todo':
			return {
				title: `Delete “${deletion.title}”?`,
				description: `This deletes ${deletion.path} from the folder. ${history(deletion)}`,
			};
		case 'file':
			return {
				title: `Delete ${basename(deletion.path)}?`,
				description: `This deletes ${deletion.path} from the folder. ${history(deletion)}`,
			};
		case 'folder':
			return {
				title: `Delete the folder ${basename(deletion.path)}?`,
				description: `${deletion.path} is empty. Deleting it removes only the folder.`,
			};
	}
}

/**
 * Ask before deleting `path`. The delete runs after the file's queued
 * writes, so it removes what the app saved last; a file changed elsewhere
 * since is refused.
 */
export async function confirmDelete(path: string) {
	const { data: deletion, error: captureError } = await todos.deletionFor(path);
	if (captureError !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: describeError(captureError),
		});
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await todos.remove(deletion);
			if (error !== null)
				toast.error(`Could not delete ${basename(path)}`, {
					description: describeError(error),
				});
		},
	});
}
