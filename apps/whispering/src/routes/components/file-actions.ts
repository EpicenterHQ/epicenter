/**
 * Actions the screens share: copy some text, open a file, delete
 * with a confirmation that names what will be removed, and textarea newlines.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeDeletion } from '$lib/deletion.js';
import type { DraftSession, Library } from '$lib/library.svelte.js';

export { recordingTitle } from '$lib/deletion.js';

/** Copy text the person asked for. `what` names it: "the transcript". */
export async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`Copied ${what}`);
	} catch {
		toast.error(`Could not copy ${what}`);
	}
}

/** Text as a textarea reports it: LF only. Setters restore the file's own line endings. */
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
 * Ask before deleting `path`. What the dialog names is captured first, and
 * the deletion applies only to that captured version.
 */
export async function confirmDelete(library: Library, path: string) {
	const { data: deletion, error: refusal } = await library.deletionFor(path);
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
			const problem = await library.remove(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}

/**
 * Open `path`, asking first when a draft it would leave holds changes that
 * could not be saved: discarding that draft lets the open go on, cancelling
 * keeps it. Answers whether `path` opened.
 */
export async function openItem(
	library: Library,
	path: string,
	discard?: DraftSession,
): Promise<boolean> {
	const opened = await library.open(path, { discard });
	if (opened === undefined) return true;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description: `${opened.unsaved.path} has changes that could not be saved. Discard them to open another file, or cancel to keep working on them.`,
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			// The draft the dialog describes: confirming discards this one only.
			resolve(await openItem(library, path, opened.unsaved));
		},
		onCancel: () => resolve(false),
	});
	return promise;
}
