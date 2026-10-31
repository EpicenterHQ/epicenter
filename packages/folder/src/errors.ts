/**
 * Operation failures: opening a contract's client (`OpenDeviceError`), and
 * the directory storage the device stores and the CLI's tools use
 * (`FileError`).
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const FileError = defineErrors({
	InvalidPath: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The path '${path}' is not usable: ${reason}`,
		path,
		reason,
	}),
	/** The addressed file is absent. */
	NotFound: ({ path }: { path: string }) => ({
		message: `No file exists at '${path}'`,
		path,
	}),
	NotAFile: ({ path }: { path: string }) => ({
		message: `'${path}' is a directory, not a file`,
		path,
	}),
	NotADirectory: ({ path }: { path: string }) => ({
		message: `'${path}' is a file, not a directory`,
		path,
	}),
	Io: ({
		path,
		operation,
		cause,
	}: {
		path: string;
		operation: string;
		cause: unknown;
	}) => ({
		message: `Could not ${operation} '${path}': ${describe(cause)}`,
		path,
		operation,
		cause,
	}),
	Unconfirmed: ({
		path,
		operation,
		cause,
	}: {
		path: string;
		operation: string;
		cause: unknown;
	}) => ({
		message: `The folder host did not confirm ${operation} '${path}'; the operation may have completed: ${describe(cause)}`,
		path,
		operation,
		cause,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
});
export type FileError = InferErrors<typeof FileError>;

/**
 * Why `openDevice` opened no client, on every platform. A desktop data
 * folder can be missing, not granted, refused or unreadable; storage itself
 * can be unavailable anywhere (outside Tauri, a browser that gives the page
 * no private storage, a shell that did not answer). Each message says what
 * happened in words a person can act on; the app decides what it offers.
 */
export const OpenDeviceError = defineErrors({
	/** The folder is not there: moved, deleted, or on a drive not connected. Never made again on its own. */
	Missing: ({ folder }: { folder: string }) => ({
		message: `${folder} is not there. It may have been moved or deleted, or be on a drive that is not connected.`,
		folder,
	}),
	/** Tauri's file-system scope does not allow the folder: it was named without the folder picker. */
	NotGranted: ({ folder }: { folder: string }) => ({
		message: `This app has not been allowed to open ${folder}. Choose it in the folder picker to allow it.`,
		folder,
	}),
	/** A place no app keeps its files in (the home folder, a .git folder, Epicenter's own records), why in one line. */
	Refused: ({ folder, reason }: { folder: string; reason: string }) => ({
		message: reason,
		folder,
		reason,
	}),
	/** The folder is there but could not be opened or made. */
	Unreadable: ({ folder, cause }: { folder: string; cause: unknown }) => ({
		message: `${folder} could not be opened: ${describe(cause)}`,
		folder,
		cause,
	}),
	/** This platform's storage could not be reached at all. */
	StorageUnavailable: ({ cause }: { cause: unknown }) => ({
		message: `This app's storage is not available: ${describe(cause)}`,
		cause,
	}),
});
export type OpenDeviceError = InferErrors<typeof OpenDeviceError>;

/**
 * Internal: the Bun directory host checked what a staged file's rename or a
 * removal expected at its path, found something else, and changed nothing. `found`
 * says what: a file with other bytes (`actualSha256`, or `undefined` when no
 * file is there), something where nothing was expected, or nothing where a
 * file was. File storage answers it as a `'stale'` put, never as
 * `Unconfirmed`.
 */
export class UnexpectedTarget extends Error {
	constructor(
		readonly path: string,
		readonly found:
			| { readonly name: 'Conflict'; readonly actualSha256: string | undefined }
			| { readonly name: 'Exists' }
			| { readonly name: 'NotFound' },
	) {
		super(
			found.name === 'Conflict'
				? `'${path}' does not hold the bytes the change expected`
				: found.name === 'Exists'
					? `'${path}' is already occupied`
					: `No file exists at '${path}'`,
		);
		this.name = 'UnexpectedTarget';
	}
}

export function describe(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (
		typeof cause === 'object' &&
		cause !== null &&
		'message' in cause &&
		typeof cause.message === 'string'
	)
		return cause.message;
	return String(cause);
}
