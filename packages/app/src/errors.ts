/**
 * The failures a folder or collection write throws on purpose, as tagged
 * errors (wellcrafted's `defineErrors`). A run keeps a thrown tagged error
 * whole in its answer, so a UI tells them apart by `name` through
 * `changedElsewhere`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

const WHY = {
	quote: "'s body does not have that text; it may have changed since it was read, so get it again",
	empty: "'s body is no longer empty; get it again",
	kept: ' kept changing while it was updated',
} as const;

export const WriteError = defineErrors({
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
});
export type WriteError = InferErrors<typeof WriteError>;
