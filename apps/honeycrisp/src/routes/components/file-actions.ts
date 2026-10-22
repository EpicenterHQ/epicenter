/**
 * Actions the lists, the note view, and the file view share: copy a path,
 * and delete with a confirmation that names what will be removed.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Deletion, Notes } from '$lib/notes.svelte.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

export function describeDeletion(deletion: Deletion) {
	return {
		title:
			deletion.title !== undefined
				? `Delete “${deletion.title}” permanently?`
				: `Delete ${basename(deletion.path)}?`,
		description: `This deletes ${deletion.path} from this device. Honeycrisp keeps no versions, so it cannot be brought back.`,
	};
}

/**
 * Ask before deleting `path`. The delete joins the file publication lane
 * without saving pending input first.
 */
export async function confirmDelete(notes: Notes, path: string) {
	const { data: deletion, error: refusal } = await notes.deletionFor(path);
	if (refusal !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: refusal,
		});
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await notes.delete(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}
