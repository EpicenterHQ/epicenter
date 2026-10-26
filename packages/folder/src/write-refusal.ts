/**
 * Why a write did not land. The folder's own refusals are here; storage's
 * keep their `SaveError` names. A write that did not land leaves the disk,
 * and so the folder copy, as it was.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { LandedSaveError } from './shared/errors.js';

export const WriteRefusal = defineErrors({
	/** A create found a file already there. */
	Exists: ({ path }: { path: string }) => ({
		message: `A file already exists at ${path}`,
		path,
	}),
	/** An update found no readable file to change. */
	NothingToUpdate: ({ path }: { path: string }) => ({
		message: `There is no readable file at ${path} to update`,
		path,
	}),
	/** The folder is closing or closed and takes no new writes. */
	Closed: () => ({ message: 'The folder is closed' }),
});
export type WriteError = InferErrors<typeof WriteRefusal> | LandedSaveError;
