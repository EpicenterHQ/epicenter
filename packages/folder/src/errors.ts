/**
 * Operation failures: opening a `Folder` (`OpenFolderError`), and the
 * directory storage and row reading the CLI's readers use.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. Public Folder saves use `SaveError`.
 *
 * A row file whose text was read but is not a valid row is `InvalidRow`: it
 * carries the exact text, the hash of the bytes read, and every issue, so the
 * row can be repaired as text and saved guarded by those bytes.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Issues } from './row-text.js';

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
	DirectoryNotEmpty: ({ path }: { path: string }) => ({
		message: `The directory '${path}' is not empty`,
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

/** Why a row file's text, read whole, is not a row. Nothing was written. */
const RowTextError = defineErrors({
	/**
	 * The file was read as text, but it is not a valid row: its frontmatter
	 * has no canonical form, or a declared field does not conform or is
	 * missing. `text` is exactly what was read and `sha256` the hash of its
	 * bytes, so a repair can show the text and save guarded by them.
	 */
	InvalidRow: ({
		path,
		sha256,
		text,
		issues,
	}: {
		path: string;
		sha256: string;
		text: string;
		issues: Issues;
	}) => ({
		message: `'${path}' is not a valid row: ${issues
			.map((issue) =>
				issue.line === undefined
					? issue.message
					: `line ${issue.line}: ${issue.message}`,
			)
			.join('; ')}`,
		path,
		sha256,
		text,
		issues,
	}),
	/**
	 * The file was read, but its bytes are not UTF-8. `sha256` is the hash of
	 * the bytes read, so a repair can be guarded by them.
	 */
	InvalidUtf8: ({ path, sha256 }: { path: string; sha256: string }) => ({
		message: `'${path}' is not valid UTF-8 text`,
		path,
		sha256,
	}),
});

/**
 * Why a read row file is not a row: storage could not read it, its bytes are
 * not UTF-8, or its text is not a valid row.
 */
export type RowReadError = FileError | InferErrors<typeof RowTextError>;

/** The constructors of `RowReadError`. */
export const RowReadError = { ...FileError, ...RowTextError };

/**
 * Why a folder could not be opened. Every opener returns these; none throws
 * for a refusal, and none opens another storage instead.
 */
export const OpenFolderError = defineErrors({
	/** A desktop folder was asked for outside the desktop shell. */
	NotTauri: () => ({
		message:
			'This folder lives in the desktop app; it cannot be opened from a browser tab',
	}),
	/** The directory a native opener was given cannot hold a folder. */
	InvalidRoot: ({ root, cause }: { root: string; cause: unknown }) => ({
		message: `The directory '${root}' cannot be opened as a folder: ${describe(cause)}`,
		root,
		cause,
	}),
	/**
	 * The desktop window's folder is not there anymore, perhaps moved or
	 * removed since the window opened. Opening never makes it again: only
	 * the shell's launch makes a fixed default.
	 */
	Missing: () => ({
		message:
			"This window's folder is not there anymore; it may have been moved or removed.",
	}),
	/**
	 * `tables` named a table that cannot be one top-level directory: empty,
	 * `.`, `..`, containing a slash or NUL, or `.git`.
	 */
	InvalidTable: ({ table }: { table: string }) => ({
		message: `'${table}' cannot name a table: a table is one top-level directory`,
		table,
	}),
	/** The desktop shell bound no folder to this window. */
	NotBound: () => ({
		message: 'The desktop app did not open this window on a folder',
	}),
	/** The folder's storage could not be reached or made ready. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The folder could not be opened: ${describe(cause)}`,
		cause,
	}),
	ShuttingDown: () => ({ message: 'The desktop app is shutting down' }),
});
export type OpenFolderError = InferErrors<typeof OpenFolderError>;

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
 * Internal: a write whose outcome is unknown, such as a stream that failed
 * to close, or a file it created whose absence could not be shown after it
 * failed. Git work that meets one reports `unconfirmed`, never `failed`, and
 * does not treat the private file's current bytes as proof of what landed;
 * file storage reports `Unconfirmed`.
 */
export class UnconfirmedWrite extends Error {
	constructor(
		readonly path: string,
		cause: unknown,
	) {
		super(`Whether '${path}' was written is unknown: ${describe(cause)}`, {
			cause,
		});
		this.name = 'UnconfirmedWrite';
	}
}

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
