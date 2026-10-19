/**
 * Operation failures: opening a `Folder` (`OpenFolderError`), and the
 * directory storage, row reading, and one write the CLI's readers and a
 * directory's history use.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. Native publication uses `WriteError` (ADR-0576); public
 * Folder saves use `SaveError`.
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

/** Why a write stopped for what other writers left. */
const WriteRefusal = defineErrors({
	/**
	 * A write found the file changed by another writer, merged with it, and
	 * found it changed again, `attempts` times; nothing of the write landed.
	 */
	KeptChanging: ({ path, attempts }: { path: string; attempts: number }) => ({
		message: `'${path}' kept changing while it was saved; gave up after ${attempts} attempts`,
		path,
		attempts,
	}),
});

/**
 * Every way the one write a directory's history publishes through fails
 * (`write.ts`, ADR-0576): a path no file can be written at (`InvalidPath`, a
 * directory included), a file another writer kept changing past `WRITE_ATTEMPTS`
 * (`KeptChanging`), storage that failed or whose reply was lost and could not
 * be confirmed (`Io`, with the storage failure as its cause), or closed
 * storage (`Closed`). A failed write wrote nothing. A file that does not read
 * as its kind is never a refusal: it merges as text, for repair (ADR-0503).
 */
export type WriteError =
	| Extract<FileError, { name: 'Io' | 'Closed' | 'InvalidPath' }>
	| InferErrors<typeof WriteRefusal>;

/** The constructors of `WriteError`. */
export const WriteError = {
	Io: FileError.Io,
	Closed: FileError.Closed,
	InvalidPath: FileError.InvalidPath,
	...WriteRefusal,
};

/**
 * Why a folder could not be opened. Every opener returns these; none throws
 * for a refusal, and none opens another storage instead.
 */
export const OpenFolderError = defineErrors({
	/** A desktop folder's registered ID is empty. */
	InvalidId: ({ id }: { id: string }) => ({
		message: `'${id}' cannot name a folder`,
		id,
	}),
	/** A desktop folder was asked for outside the desktop shell. */
	NotTauri: () => ({
		message:
			'This folder lives in the desktop app; it cannot be opened from a browser tab',
	}),
	/** The browser's default local folder was asked for inside the desktop shell. */
	InsideTauri: () => ({
		message:
			'This page runs in the desktop app, whose folders are files on disk; browser storage is not opened there',
	}),
	/** The directory a native opener was given cannot hold a folder. */
	InvalidRoot: ({ root, cause }: { root: string; cause: unknown }) => ({
		message: `The directory '${root}' cannot be opened as a folder: ${describe(cause)}`,
		root,
		cause,
	}),
	UnknownScope: ({ scope }: { scope: string }) => ({
		message: `The desktop app has no folder registered as '${scope}'`,
		scope,
	}),
	WindowNotPermitted: ({
		scope,
		window,
	}: {
		scope: string;
		window: string;
	}) => ({
		message: `The window '${window}' may not use the folder '${scope}'`,
		scope,
		window,
	}),
	/**
	 * A registered folder's directory is not there, perhaps moved or removed
	 * since it was chosen. A fixed application default may be created on its
	 * first grant; a later grant does not switch to an empty directory.
	 */
	Missing: ({ root }: { root: string }) => ({
		message: `There is no folder at ${root}; it may have been moved or removed.`,
		root,
	}),
	/**
	 * `tables` named a table that cannot be one top-level directory: empty,
	 * `.`, `..`, containing a slash or NUL, or `.git`.
	 */
	InvalidTable: ({ table }: { table: string }) => ({
		message: `'${table}' cannot name a table: a table is one top-level directory`,
		table,
	}),
	/** The desktop shell assigned no folder to this window. */
	NotAssigned: () => ({
		message: 'The desktop shell did not assign this window a folder',
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
 * Internal: a host refused a change before making any of it, such as a save
 * lock it could not take in time. File storage reports it as `Io`, never
 * `Unconfirmed`. Its message is the refusal's.
 */
export class NothingChanged extends Error {
	constructor(cause: unknown) {
		super(describe(cause), { cause });
		this.name = 'NothingChanged';
	}
}

/**
 * Internal: the Bun directory host checked what a publishing rename or a
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
