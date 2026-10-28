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
		description: `This deletes ${deletion.path}, on this device and, when it syncs, everywhere.`,
	};
}

/** Ask before deleting `path`; the delete applies on this device at once. */
export function confirmDelete(notes: Notes, path: string) {
	const { data: deletion, error: refusal } = notes.deletionFor(path);
	if (refusal !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: refusal,
		});
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		onConfirm() {
			notes.delete(deletion);
		},
	});
}
