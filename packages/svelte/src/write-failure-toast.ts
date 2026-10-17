/**
 * The one toast every folder app shows for a failed save: what failed, why,
 * and the text the file does not hold, to copy. Shown by `<FolderApp>` for
 * each `WriteFailure` an app reports through `getFolder().writeFailed`.
 */
import { toast } from '@epicenter/ui/sonner';
import { describeWriteError, type WriteFailure } from './write-failure.js';

/** Copy `text`; a refused clipboard leaves the toast up to try again. */
function copy(text: string) {
	void navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * Say a save failed. An edit still on screen offers "Save again"; text that
 * is in no file is offered as "Copy your text", and its toast stays until the
 * person dismisses it.
 */
export function toastWriteFailure({
	path,
	error,
	unsaved,
	retry,
}: WriteFailure) {
	const copyable = unsaved !== '';
	toast.error(`Could not save ${path}`, {
		description:
			retry === undefined
				? describeWriteError(error)
				: `${describeWriteError(error)} Your edit is still on screen.`,
		duration: copyable ? Number.POSITIVE_INFINITY : undefined,
		action:
			retry !== undefined
				? { label: 'Save again', onClick: retry }
				: copyable
					? { label: 'Copy your text', onClick: () => copy(unsaved) }
					: undefined,
		cancel:
			retry !== undefined && copyable
				? { label: 'Copy your text', onClick: () => copy(unsaved) }
				: undefined,
	});
}
