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
	/** An update or replacement found no file to change. */
	NothingToUpdate: ({ path }: { path: string }) => ({
		message: `There is no file at ${path} to update`,
		path,
	}),
	/** A checked write could not land while another writer kept changing the file. */
	KeptChanging: ({ path }: { path: string }) => ({
		message: `The file at ${path} kept changing; save again to retry`,
		path,
	}),
	/** A move found no source file. */
	NothingToMove: ({ path }: { path: string }) => ({
		message: `There is no file at ${path} to move`,
		path,
	}),
	/** The folder is closing or closed and takes no new writes. */
	Closed: () => ({ message: 'The folder is closed' }),
});
export type WriteError = InferErrors<typeof WriteRefusal> | LandedSaveError;
