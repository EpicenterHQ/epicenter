/**
 * Actions the screens share: copy some text, show a time, delete with a
 * confirmation that names what will be removed.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeDeletion, type NoteRef, notePath } from '$lib/deletion.js';
import type { Whispering } from '$lib/whispering.svelte.js';

export { titleOf } from '$lib/deletion.js';

/** Copy text the person asked for. `what` names it: "the transcript". */
export async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`Copied ${what}`);
	} catch {
		toast.error(`Could not copy ${what}`);
	}
}

/** A saved time for display, or the raw value when it is not a time. */
export function formatTime(value: unknown, style: 'short' | 'full' = 'full') {
	if (typeof value !== 'string') return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return style === 'short'
		? date.toLocaleString(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short',
			})
		: date.toLocaleString();
}

/**
 * Ask before deleting `note`. What the dialog names is read first, and the
 * deletion deletes those files, whatever they hold by then (ADR-0576).
 */
export function confirmDelete(whispering: Whispering, note: NoteRef) {
	const name = notePath(note);
	const { data: deletion, error: refusal } = whispering.deletionFor(note);
	if (refusal !== null) {
		toast.error(`Could not delete ${name}`, { description: refusal });
		return;
	}
	confirmationDialog.open({
		...describeDeletion(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await whispering.delete(deletion);
			if (problem)
				toast.error(`Could not delete ${name}`, { description: problem });
		},
	});
}
