/**
 * Actions the screens share: copy a path or some text, open a file, delete
 * with a confirmation that names what will be removed, and textarea newlines.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeDeletion } from '$lib/deletion.js';
import type { Whispering } from '$lib/whispering.svelte.js';

export { recordingTitle } from '$lib/deletion.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

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
 * A file's exact text as a textarea reports it: LF only. Raw-text editors
 * restore the file's own line endings with `withFileNewlines`. A row body
 * already reads with LF (ADR-0572).
 */
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');

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
 * Ask before deleting `path`. What the dialog names is read first, and the
 * deletion deletes those files, whatever they hold by then (ADR-0576).
 */
export async function confirmDelete(whispering: Whispering, path: string) {
	const { data: deletion, error: refusal } = await whispering.deletionFor(path);
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
			const problem = await whispering.delete(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}
