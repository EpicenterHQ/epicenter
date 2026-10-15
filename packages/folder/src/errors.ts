/**
 * Operation failures for file folders.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. A refusal before publication (`Conflict`, `Exists`, and
 * preparation failures) wrote nothing. Each ordinary operation publishes one
 * file change; a move that landed its destination but kept its source is
 * `MoveError.SourceNotRemoved`.
 *
 * A row file whose text was read but is not a valid row is `InvalidRow`: it
 * carries the exact text, the hash of the bytes read, and every issue, so the
 * row can be repaired as text and saved guarded by those bytes.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { FileCapture } from './capture.js';
import type { Issue, Issues } from './row-text.js';

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
	/** The create target or move destination is occupied. */
	Exists: ({ path }: { path: string }) => ({
		message: `The destination '${path}' is already occupied`,
		path,
	}),
	/** The current bytes differ from the captured baseline. This refusal wrote nothing. */
	Conflict: ({
		path,
		expectedSha256,
		actualSha256,
	}: {
		path: string;
		expectedSha256: string;
		actualSha256: string | undefined;
	}) => ({
		message:
			actualSha256 === undefined
				? `No file exists at '${path}' to match the captured SHA-256`
				: `The file at '${path}' does not match the captured SHA-256`,
		path,
		expectedSha256,
		actualSha256,
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

/** A step that reached, or failed to reach, the folder. */
export type FileStep =
	| { readonly kind: 'write'; readonly path: string }
	| { readonly kind: 'remove'; readonly path: string }
	| { readonly kind: 'move'; readonly from: string; readonly to: string };

/**
 * Raw storage failures beyond one file's refusal. Internal: Git publication
 * applies ordered changes, and the ordinary domain methods restate a single
 * change's outcome as `FileError` or `MoveError` (`applyOne` in
 * `storage.ts`).
 */
export const ApplyError = defineErrors({
	/**
	 * A multi-file operation stopped partway. `applied` steps reached the
	 * folder; nothing was rolled back. `failed` did not complete, and
	 * `notAttempted` never started.
	 *
	 * `failed` may name the second half of a step whose first half is in
	 * `applied`. A move whose destination landed but whose source stayed has
	 * the destination write applied and `{ kind: 'remove', path: from }`
	 * failed.
	 */
	Partial: ({
		applied,
		failed,
		error,
		notAttempted,
	}: {
		applied: readonly FileStep[];
		failed: FileStep;
		error: FileError;
		notAttempted: readonly FileStep[];
	}) => ({
		message: `${applied.length} of ${applied.length + 1 + notAttempted.length} file steps completed before a failure: ${error.message}`,
		applied,
		failed,
		error,
		notAttempted,
	}),
});
export type ApplyError = InferErrors<typeof ApplyError>;

export const MoveError = defineErrors({
	/**
	 * A move is two steps: the bytes at `from` are put at `to`, then `from`
	 * is removed. A native directory and browser OPFS storage both move this
	 * way. The first step landed and the second failed, so `to` was written
	 * and `from` is still there. Nothing was rolled back. `cause` is why
	 * `from` was not removed.
	 *
	 * `moved` is `to` with the SHA-256 the move was guarded by: every move
	 * names the bytes it carries. It is a receipt conditioned on that
	 * baseline, never a read of `to`: another program may have written there
	 * since, and a native directory checks the source only as well as another
	 * program lets it. Read `to` to learn what it holds now.
	 */
	SourceNotRemoved: ({
		from,
		to,
		moved,
		cause,
	}: {
		from: string;
		to: string;
		moved: FileCapture;
		cause: FileError;
	}) => ({
		message: `The file reached '${to}', but '${from}' could not be removed, so both paths hold it: ${cause.message}`,
		from,
		to,
		moved,
		cause,
	}),
});
export type MoveError = InferErrors<typeof MoveError>;

/**
 * Failures of reading a row or `kv.json` as text and of preparing a
 * structured write. None of them published anything. An address a folder does not admit is
 * `FileError.InvalidPath`, and an occupied destination is `FileError.Exists`:
 * a table has no naming or collision rule of its own (ADR-0457).
 */
export const TableError = defineErrors({
	/**
	 * Supplied values are undeclared, do not conform to their fields, are
	 * absent from a complete row, or cannot be copied or written to the file.
	 */
	InvalidValues: ({ issues }: { issues: readonly Issue[] }) => ({
		message: `Supplied values do not conform: ${issues.map((issue) => issue.message).join('; ')}`,
		issues,
	}),
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
	 * `kv.json` was read as text, but it is not a file a folder can hold: not
	 * one strict JSON object, or a key that appears twice. `text` is exactly
	 * what was read and `sha256` the hash of its bytes, so a repair can show
	 * the text and save guarded by them.
	 */
	InvalidKv: ({
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
		message: `'${path}' cannot be read as settings: ${issues
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
export type TableError = InferErrors<typeof TableError>;

type TableErrorOf<TName extends TableError['name']> = Extract<
	TableError,
	{ name: TName }
>;

/** Storage failures are forwarded intact. Narrower storage signatures belong to their producers. */
export type TableEnumerationError = FileError;

/** Acquisition or UTF-8 decoding failed: there is no text to read as a row. */
export type TableReadError = FileError | TableErrorOf<'InvalidUtf8'>;

/** Why a read row file is not a row: there was no text, or the text is not a valid row. */
export type RowReadError = TableReadError | TableErrorOf<'InvalidRow'>;

/** The row cannot be written as a valid row, or publication failed. */
export type TableCreateError = FileError | TableErrorOf<'InvalidValues'>;

/** The row cannot be written as a valid row, or the guarded publication failed. */
export type TableReplaceError = FileError | TableErrorOf<'InvalidValues'>;

/** A guarded row move preserves the file move's failures, its landed capture included. */
export type TableRenameError = FileError | MoveError;

/** Removing a row preserves the storage operation's failures. */
export type TableDeleteError = FileError;

/** Every failure a table write can report. */
export type TableWriteError =
	| TableCreateError
	| TableReplaceError
	| TableRenameError
	| TableDeleteError;

/** `kv.json` could not be read, is not UTF-8, or is not a file a folder can hold. */
export type KvReadError = FileError | TableErrorOf<'InvalidUtf8' | 'InvalidKv'>;

/**
 * Why a `kv.set` saved nothing: the value cannot be stored, the current file
 * cannot be read as settings, or publication failed. `Conflict` means the
 * set lost its race on every attempt.
 */
export type KvWriteError = KvReadError | TableErrorOf<'InvalidValues'>;

/**
 * Why a folder could not be opened. Every opener returns these; none throws
 * for a refusal, and none opens another storage instead.
 */
export const OpenFolderError = defineErrors({
	/** The definition declares something a file folder cannot keep. */
	InvalidDefinition: ({ reason }: { reason: string }) => ({
		message: `This definition cannot be opened as a folder: ${reason}`,
		reason,
	}),
	/**
	 * The folder's own `epicenter.json`, which `openDataFolder` reads, is not
	 * a readable file, is not UTF-8 JSON, is not the declaration grammar, or
	 * declares a field a folder cannot keep. Nothing was opened.
	 */
	InvalidDeclaration: ({ reason }: { reason: string }) => ({
		message: `The folder's epicenter.json cannot be used: ${reason}`,
		reason,
	}),
	/** A folder ID names one directory: not empty, `.`, or `..`, with no slash, backslash, or control character. */
	InvalidId: ({ id }: { id: string }) => ({
		message: `'${id}' cannot name a folder`,
		id,
	}),
	/** The desktop adapter was asked to open outside the desktop shell. */
	NotTauri: () => ({
		message:
			'This folder lives in the desktop app; it cannot be opened from a browser tab',
	}),
	/** The browser adapter was asked to open inside the desktop shell. */
	InsideTauri: () => ({
		message:
			'This page runs in the desktop app, whose folders are files on disk; browser storage is not opened there',
	}),
	/**
	 * The origin private file system, its writable streams, or Web Locks are
	 * missing: a server render, a worker without them, or an insecure page.
	 */
	NoFileSystem: ({ missing }: { missing: string }) => ({
		message: `Browser folders are stored in the origin private file system, which is not usable here: ${missing}`,
		missing,
	}),
	/** The directory an explicit opener was given cannot hold a folder. */
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
	Busy: ({ root }: { root: string }) => ({
		message: `Another Epicenter is already using the folder at ${root}. Quit the other Epicenter, then open this one again.`,
		root,
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
 * Internal: a change whose outcome is unknown, such as a stream that failed
 * to close, a file it created whose absence could not be shown after it
 * failed, or a removal whose reply was lost and whose path is still there.
 * Git work that meets one reports `unconfirmed`, never `failed`, and does not
 * treat the private file's current bytes as proof of what landed; file
 * storage reports `Unconfirmed`.
 */
export class UnconfirmedWrite extends Error {
	constructor(
		readonly path: string,
		cause: unknown,
		done: 'written' | 'removed' = 'written',
	) {
		super(`Whether '${path}' was ${done} is unknown: ${describe(cause)}`, {
			cause,
		});
		this.name = 'UnconfirmedWrite';
	}
}

/**
 * Internal: a directory host checked what a publishing rename or a removal
 * expected at its path, found something else, and changed nothing. `found`
 * says what: a file with other bytes (`actualSha256`, or `undefined` when no
 * file is there), something where nothing was expected, or nothing where a
 * file was. File storage reports it as `Conflict`, `Exists`, or `NotFound`,
 * never as `Unconfirmed`.
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
