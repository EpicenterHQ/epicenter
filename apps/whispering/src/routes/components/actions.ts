/**
 * Actions the screens share: copy some text, and delete with a
 * confirmation that names what will be removed.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from 'svelte-sonner';
import { describeDeletion } from '$lib/deletion.js';
import { type NoteRef, notePath } from '$lib/folder.js';
import type { Library } from '$lib/library.svelte.js';

/** Copy text the person asked for. `what` names it: "the transcript". */
export async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`Copied ${what}`);
	} catch {
		toast.error(`Could not copy ${what}`);
	}
}

/**
 * Ask before deleting `note`. What the dialog names is read first, and the
 * deletion deletes those files, whatever they hold by then (ADR-0576).
 */
export function confirmDelete(library: Library, note: NoteRef) {
	const name = notePath(note);
	const { data: deletion, error: refusal } = library.deletionFor(note);
	if (refusal !== null) {
		toast.error(`Could not delete ${name}`, { description: refusal });
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await library.delete(deletion);
			if (problem)
				toast.error(`Could not delete ${name}`, { description: problem });
		},
	});
}
