/**
 * The failures a folder or collection throws on purpose when a file is not
 * as the call needs it, as tagged errors (wellcrafted's `defineErrors`). A run
 * keeps a thrown tagged error whole in its answer, and a UI's client answers
 * each as its own `ActionError`, so a page tells them apart by `name`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

const WHY = {
	quote: "'s body does not have that text; it may have changed since it was read, so get it again",
	empty: "'s body is no longer empty; get it again",
	kept: ' kept changing while it was updated',
} as const;

export const FileError = defineErrors({
	/**
	 * What the write depended on is no longer in the file: the passage an
	 * `edit` quoted (`quote`), the empty body it filled (`empty`), or, for
	 * `update`, the file another writer kept changing (`kept`).
	 */
	Changed: ({ path, why }: { path: string; why: keyof typeof WHY }) => ({
		message: `${path}${WHY[why]}`,
		path,
		why,
	}),
	/** There is no file at `path` to read or change: it was never made, or it was deleted. */
	Missing: ({ path }: { path: string }) => ({
		message: `There is no ${path}`,
		path,
	}),
});
export type FileError = InferErrors<typeof FileError>;
