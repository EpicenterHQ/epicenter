/**
 * Why a folder did not open or a write did not land. Storage refusals keep
 * the folder's `SaveError` names; the rest are the folder's own answers. A
 * write that did not land leaves the disk, and so the mirror, as it was.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type ReadError, SaveError } from '../shared/errors.js';

export const EditError = defineErrors({
	/** `create` found a file already there. */
	Exists: ({ path }: { path: string }) => ({
		message: `A file already exists at ${path}`,
		path,
	}),
	/** Storage changed under every attempt to save parts of the file. */
	KeptChanging: ({ path }: { path: string }) => ({
		message: `${path} kept changing while it was being saved`,
		path,
	}),
	/** `update` has nothing to change: no file is there, or it was never read. */
	NothingToUpdate: ({ path }: { path: string }) => ({
		message: `There is no readable file at ${path} to update`,
		path,
	}),
	/** The folder is closing or closed and accepts no new writes. */
	Closed: () => ({ message: 'The folder is closed' }),
});
export type EditError = InferErrors<typeof EditError> | SaveError;

export const OpenError = defineErrors({
	/** The first listing failed, so the folder cannot show what it holds. */
	ListFailed: ({ cause }: { cause: ReadError }) => ({
		message: `The folder could not be listed: ${cause.message}`,
		cause,
	}),
});
export type OpenError = InferErrors<typeof OpenError>;

export { SaveError };
