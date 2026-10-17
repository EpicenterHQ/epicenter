/**
 * The one toast every folder app shows for a failed save: what failed, why,
 * and the text the file does not hold, to copy. Shown by `<FolderApp>` for
 * each `WriteFailure` an app reports through `getFolder().writeFailed`.
 *
 * The toast is the only place the unsaved text exists, so nothing here
 * closes it before the text is safe: Copy closes it once the clipboard took
 * the text, and a refused copy keeps it up with the text shown to select by
 * hand. "Save again" closes it only when the app started a save; that save
 * reports again if it fails.
 */
import { toast } from '@epicenter/ui/sonner';
import UnsavedText from './unsaved-text.svelte';
import { describeWriteError, type WriteFailure } from './write-failure.js';

/** Copy `text`; resolves whether the clipboard took it. */
async function copied(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Say a save failed. Text that is in no file is offered as "Copy your
 * text", and its toast stays until the text is copied or the person
 * dismisses it. An edit still on screen offers "Save again".
 */
export function toastWriteFailure(failure: WriteFailure) {
	show(failure);
}

/**
 * Show `failure` as a new toast. A toast is replaced by dismissing it and
 * showing another, never updated in place: svelte-sonner restarts an updated
 * toast's timer with its duration, and an infinite duration then closes it
 * at once.
 */
function show(failure: WriteFailure, copyRefused = false): string | number {
	const { path, error, unsaved, retry } = failure;
	const title = `Could not save ${path}`;
	const said =
		retry === undefined
			? describeWriteError(error)
			: `${describeWriteError(error)} Your edit is still on screen.`;
	const copyable = unsaved !== '';
	let shown: string | number = '';
	/** Set while this toast's copy runs, so a second click starts none. */
	let copying = false;

	const copy = {
		label: 'Copy your text',
		onClick: (event: MouseEvent) => {
			// Closed only once the clipboard took the text.
			event.preventDefault();
			if (copying) return;
			copying = true;
			void copied(unsaved).then((took) => {
				toast.dismiss(shown);
				if (!took) show(failure, true);
			});
		},
	};
	/** Start the save again; when none starts, show the failure again without Save again. */
	const saveAgain = () => {
		if (!retry?.()) show({ path, error, unsaved }, copyRefused);
	};

	shown = toast.error(title, {
		...(copyRefused
			? {
					description: UnsavedText,
					componentProps: {
						message: `${said} Copying did not work: select your text below and copy it.`,
						text: unsaved,
					},
				}
			: { description: said }),
		duration: copyable ? Number.POSITIVE_INFINITY : undefined,
		action: copyable
			? copy
			: retry !== undefined
				? { label: 'Save again', onClick: saveAgain }
				: undefined,
		// Save again closes its toast, and shows it again, with only what is
		// left to offer, when no save started.
		cancel:
			copyable && retry !== undefined
				? { label: 'Save again', onClick: saveAgain }
				: undefined,
	});
	return shown;
}
