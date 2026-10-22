/**
 * The one toast every folder app shows for a failed save: what failed, why,
 * and the text the file does not hold, to copy. App failure
 * listeners pass each `WriteFailure` to `toastWriteFailure`.
 *
 * Copy samples the editor's current text when pressed and closes the toast
 * once the clipboard takes it. A refused copy keeps that attempted text
 * shown to select by hand. "Save again" closes it only when the app started
 * a save; that save
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
function show(
	failure: WriteFailure,
	copyRefused = false,
	attemptedText?: string,
) {
	const { path, error, getText } = failure;
	const shownText = getText();
	const copyable = shownText !== undefined;
	const save = copyable ? failure.save : undefined;
	const discard = copyable ? failure.discard : undefined;
	const title = `Could not save ${path}`;
	const said =
		save === undefined
			? describeWriteError(error)
			: `${describeWriteError(error)} Your edit is still on screen.`;
	let live = true;
	/** Set while this toast's copy runs, so a second click starts none. */
	let copying = false;
	const dismiss = () => {
		live = false;
		toast.dismiss(shown);
	};

	const copy = {
		label: 'Copy your text',
		onClick: async (event: MouseEvent) => {
			event.preventDefault();
			if (copying) return;
			const text = getText();
			if (text === undefined) {
				dismiss();
				return;
			}
			copying = true;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				if (!live) return;
				dismiss();
				show(failure, true, text);
				return;
			}
			if (live) dismiss();
		},
	};
	/** Start the save again; when none starts, show the failure again without Save again. */
	const saveAgain = () => {
		dismiss();
		if (!save?.())
			show({ ...failure, save: undefined }, copyRefused, attemptedText);
	};
	/**
	 * Let go of the edit; the toast stays with only the text to copy: the
	 * text the discard let go, which holds any typing newer than this toast.
	 * When the edit was already gone, nothing is shown again.
	 */
	const discarded =
		discard === undefined
			? undefined
			: () => {
					dismiss();
					const dropped = discard();
					if (dropped !== undefined)
						show({ path, error, getText: () => dropped });
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
						text:
							copyRefused && attemptedText !== undefined
								? attemptedText
								: save === undefined
									? shownText
									: undefined,
						discard: discarded,
					},
				}
			: { description: said }),
		duration:
			copyable || attemptedText !== undefined
				? Number.POSITIVE_INFINITY
				: undefined,
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
		onDismiss: () => {
			live = false;
		},
		onAutoClose: () => {
			live = false;
		},
	});
}
