/**
 * The one toast every folder app shows for a failed save: what failed, why,
 * and the text the file does not hold, to copy. `<FolderApp>` and app failure
 * listeners pass each `WriteFailure` to `toastWriteFailure`.
 *
 * The toast is the only place the unsaved text exists, so nothing here
 * closes it before the text is safe: Copy closes it once the clipboard took
 * the text, and a refused copy keeps it up with the text shown to select by
 * hand. "Save again" closes it only when the app started a save; that save
 * reports again if it fails. "Discard your edit" lets go of the edit still
 * on screen, which a failed save otherwise keeps blocking a rename, a
 * delete, or Save version, and keeps the toast up with the text to copy.
 */
import { toast } from '@epicenter/ui/sonner';
import UnsavedText from './unsaved-text.svelte';
import { describeWriteError, type WriteFailure } from './write-failure.js';

/**
 * Say a save failed. Text that is in no file is offered as "Copy your
 * text", and its toast stays until the text is copied or the person
 * dismisses it. An edit still on screen offers "Save again" and "Discard
 * your edit".
 */
export function toastWriteFailure(failure: WriteFailure) {
	show(failure);
}

/**
 * Show `failure` as a new toast. Once its editor is gone, the unsaved text
 * is shown directly as well as offered for copying. A toast is replaced by dismissing it and
 * showing another, never updated in place: svelte-sonner restarts an updated
 * toast's timer with its duration, and an infinite duration then closes it
 * at once.
 */
function show(failure: WriteFailure, copyRefused = false) {
	const { path, error, unsaved, save, discard } = failure;
	const title = `Could not save ${path}`;
	const said =
		save === undefined
			? describeWriteError(error)
			: `${describeWriteError(error)} Your edit is still on screen.`;
	const copyable = unsaved !== '';
	/** Set while this toast's copy runs, so a second click starts none. */
	let copying = false;

	const copy = {
		label: 'Copy your text',
		onClick: async (event: MouseEvent) => {
			// Closed only once the clipboard took the text.
			event.preventDefault();
			if (copying) return;
			copying = true;
			try {
				await navigator.clipboard.writeText(unsaved);
			} catch {
				toast.dismiss(shown);
				show(failure, true);
				return;
			}
			toast.dismiss(shown);
		},
	};
	/** Start the save again; when none starts, show the failure again without Save again. */
	const saveAgain = () => {
		if (!save?.()) show({ path, error, unsaved }, copyRefused);
	};
	/**
	 * Let go of the edit; the toast stays with only the text to copy: the
	 * text the discard let go, which holds any typing newer than this
	 * toast, or this toast's own when the edit was already gone.
	 */
	const discarded =
		discard === undefined
			? undefined
			: () => {
					const dropped = discard() ?? unsaved;
					toast.dismiss(shown);
					if (dropped !== '')
						show({ path, error, unsaved: dropped }, copyRefused);
				};

	const shown = toast.error(title, {
		...(copyRefused ||
		discarded !== undefined ||
		(copyable && save === undefined)
			? {
					description: UnsavedText,
					componentProps: {
						message: copyRefused
							? `${said} Copying did not work: select your text below and copy it.`
							: said,
						text: copyRefused || save === undefined ? unsaved : undefined,
						discard: discarded,
					},
				}
			: { description: said }),
		duration: copyable ? Number.POSITIVE_INFINITY : undefined,
		action: copyable
			? copy
			: save !== undefined
				? { label: 'Save again', onClick: saveAgain }
				: undefined,
		// Save again closes its toast, and shows it again, with only what is
		// left to offer, when no save started.
		cancel:
			copyable && save !== undefined
				? { label: 'Save again', onClick: saveAgain }
				: undefined,
	});
}
