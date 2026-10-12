/**
 * Actions the lists, the note view, and the file view share: copy a path,
 * and delete with a confirmation that names what will be removed and whether
 * its latest changes are in no saved version.
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

/** What deleting a file loses: nothing a version holds, or changes no version has. */
function history(deletion: Extract<Deletion, { kind: 'file' }>) {
	if (deletion.unversioned === undefined)
		return 'Honeycrisp could not check whether its latest changes are in a saved version, so they may be lost.';
	return deletion.unversioned
		? 'Its latest changes are in no saved version, so deleting it loses them. Save a version first to keep them in history.'
		: 'Its current text is in the last saved version.';
}

export function describeDeletion(deletion: Deletion) {
	switch (deletion.kind) {
		case 'file':
			return {
				title:
					deletion.title !== undefined
						? `Delete “${deletion.title}” permanently?`
						: `Delete ${basename(deletion.path)}?`,
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
export async function confirmDelete(notes: Notes, path: string) {
	const { data: deletion, error: captureError } = await notes.deletionFor(path);
	if (captureError !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: captureError,
		});
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
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
