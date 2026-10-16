/**
 * Actions the screens share: copy a path or some text, open a file, delete
 * with a confirmation that names what will be removed, and textarea newlines.
 */

import { basename } from '@epicenter/folder/file-browser';
import { toastReplaced } from '@epicenter/svelte/replaced-notice';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeDeletion } from '$lib/deletion.js';
import { describeError } from '$lib/files.js';
import type { Library, WriteNotice } from '$lib/library.svelte.js';

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
 * already reads with LF (ADR-0570).
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
 * Open `path`. Opening never waits or asks: edits already made are in the
 * folder or on their way. Answers whether `path` opened.
 */
export async function openItem(
	library: Library,
	path: string,
): Promise<boolean> {
	await library.open(path);
	return !library.closing;
}

/**
 * Tell the person what an edit's write did that they need to know: it
 * failed, offering to copy text that did not reach the file, or it replaced
 * a change made elsewhere to the same place.
 */
export function reportWriteNotice(notice: WriteNotice) {
	const name = basename(notice.path);
	if (notice.kind === 'replaced') {
		const { replaced, restore } = notice;
		void toastReplaced({ replaced, subject: name, restore });
		return;
	}
	const { error, lost } = notice;
	if (lost === undefined) {
		toast.error(`${name} was not saved`, {
			description: `${describeError(error)} Your edit is kept here and is saved again with your next change.`,
		});
		return;
	}
	toast.error(`${name} was not saved`, {
		description: `${describeError(error)} What you typed there is not in the file.`,
		duration: Number.POSITIVE_INFINITY,
		...(lost.trim() !== '' && {
			action: {
				label: 'Copy what was lost',
				onClick: () => void copyText(lost, 'the text that was not saved'),
			},
		}),
	});
}
