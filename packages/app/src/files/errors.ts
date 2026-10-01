/**
 * Operation failures for file folders.
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told. A refusal before publication (`Conflict`, `Exists`, and
 * validation failures) wrote nothing. `Partial` reports a multi-file operation
 * that stopped after some steps reached the folder.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { FileExpectation, FileVersion } from './version.js';

export const FileError = defineErrors({
	InvalidPath: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The path '${path}' is not usable: ${reason}`,
		path,
		reason,
	}),
	NotFound: ({ path }: { path: string }) => ({
		message: `No file exists at '${path}'`,
		path,
	}),
	Conflict: ({
		path,
		expected,
		actual,
	}: {
		path: string;
		expected: FileExpectation;
		actual: FileVersion | undefined;
	}) => ({
		message:
			expected === 'absent'
				? `A file already exists at '${path}'`
				: actual === undefined
					? `The file at '${path}' was removed after it was read`
					: `The file at '${path}' changed after it was read`,
		path,
		expected,
		actual,
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
	Closed: () => ({ message: 'The folder is closed' }),
});
export type FileError = InferErrors<typeof FileError>;

/** A step that reached, or failed to reach, the folder. */
export type FileStep =
	| { readonly kind: 'write'; readonly path: string }
	| { readonly kind: 'remove'; readonly path: string }
	| { readonly kind: 'move'; readonly from: string; readonly to: string };

export const ApplyError = defineErrors({
	/**
	 * A native multi-file operation stopped partway. `applied` steps reached the
	 * folder; nothing was rolled back. `failed` did not complete, and
	 * `notAttempted` never started.
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

export const TableError = defineErrors({
	InvalidStem: ({ stem, reason }: { stem: string; reason: string }) => ({
		message: `The stem '${stem}' is not usable: ${reason}`,
		stem,
		reason,
	}),
	Exists: ({ path }: { path: string }) => ({
		message: `The destination '${path}' is already occupied`,
		path,
	}),
	Collision: ({ path, existing }: { path: string; existing: string }) => ({
		message: `The destination '${path}' collides with '${existing}' on case-insensitive filesystems`,
		path,
		existing,
	}),
	AmbiguousAttachment: ({
		path,
		candidates,
	}: {
		path: string;
		candidates: readonly string[];
	}) => ({
		message: `'${path}' has ${candidates.length} same-stem attachment candidates; resolve them before this operation`,
		path,
		candidates,
	}),
	InvalidValues: ({
		issues,
	}: {
		issues: readonly { field: string; message: string }[];
	}) => ({
		message: `Supplied values do not conform: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')}`,
		issues,
	}),
	UnsupportedSource: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The source of '${path}' cannot be changed safely: ${reason}`,
		path,
		reason,
	}),
	InvalidUtf8: ({ path }: { path: string }) => ({
		message: `'${path}' is not valid UTF-8 text`,
		path,
	}),
});
export type TableError = InferErrors<typeof TableError>;

/** Failures from a table read. Absence is a successful `undefined`. */
export type TableReadError = FileError;

/** Failures from a table write. */
export type TableWriteError = TableError | FileError | ApplyError;

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
