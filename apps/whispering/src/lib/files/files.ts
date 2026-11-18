/**
 * Whispering's storage: five operations on the files of one folder, passed
 * in at startup (ADR-0894). Everything above it (recordings, transcriptions,
 * transformations, runs, `settings.md`) is written once, in the contract's
 * layout, over whichever `Files` the page was given:
 *
 * - `tauriFiles(dir)` on the desktop, through Whispering's own commands in
 *   its shell (`files_read`, `files_read_many`, `files_write`,
 *   `files_list`, `files_remove`);
 * - `opfsFiles(dir)` in a browser, in the Origin Private File System;
 * - `memoryFiles()` in tests.
 *
 * A path is relative to the folder and uses `/`, and only plain names pass
 * (`checkPath`). Each implementation passes the one conformance suite
 * (`conformance.ts`).
 */
import { Err, Ok, type Result } from 'wellcrafted/result';

/**
 * Why an operation did not happen. `NotFound`: the folder is not there.
 * `Refused`: the path is not a plain name in the folder, or the folder is
 * not one this app may use. `Io`: the storage failed.
 */
export type FilesError = {
	readonly name: 'NotFound' | 'Refused' | 'Io';
	readonly message: string;
};

/** A listed file: its name in its directory, its size in bytes, and when it last changed. */
export type Entry = {
	readonly name: string;
	readonly size: number;
	readonly modifiedMs: number;
};

export type Files = {
	/** The file's bytes, or null when nothing is at `path`. */
	read(path: string): Promise<Result<Uint8Array | null, FilesError>>;
	/**
	 * The bytes of each file of `paths` that is there, by path; a missing
	 * one is left out. It reads files, never a directory, so a list loads
	 * its notes without reading audio.
	 */
	readMany(
		paths: readonly string[],
	): Promise<Result<Map<string, Uint8Array>, FilesError>>;
	/**
	 * Replace the file at `path` with `bytes`, whole, making its directories.
	 * A reader sees the old bytes or the new ones, never a part of either.
	 */
	write(
		path: string,
		bytes: Uint8Array,
	): Promise<Result<undefined, FilesError>>;
	/**
	 * The files directly in the directory `dir` (`''` is the folder itself),
	 * sorted by name: only plain names, so no directory, hidden file, or
	 * temporary file. A directory that is not there holds none.
	 */
	list(dir: string): Promise<Result<Entry[], FilesError>>;
	/** Remove the file at `path`. One that is not there is already removed. */
	remove(path: string): Promise<Result<undefined, FilesError>>;
};

export const refused = (message: string) =>
	Err<FilesError>({ name: 'Refused', message });
export const failed = (message: string) =>
	Err<FilesError>({ name: 'Io', message });

/** A directory's name: letters, digits, `-` and `_`. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A file's name: a directory's name, then at most one extension. */
const NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;

/** Whether `name` is a plain file name, as a listing shows it. */
export const isPlainName = (name: string) => NAME.test(name);

/**
 * The segments of `path` when it is a plain path in the folder: each
 * segment letters, digits, `-` and `_`, and the last (a file's) may end in
 * one extension. No segment starts with a dot, so `..`, a hidden file, and
 * an absolute path are refused. Both id formats pass (`k3x9a2f8` and
 * `2026-10-30T22-41-05-123Z-k3x9a2f8`). A directory (`directory: true`)
 * has no extension, and `''` is the folder itself.
 */
export function checkPath(
	path: string,
	{ directory = false }: { directory?: boolean } = {},
): Result<string[], FilesError> {
	if (path === '')
		return directory ? Ok([]) : refused('An empty path names no file.');
	const segments = path.split('/');
	const last = segments.length - 1;
	for (const [index, segment] of segments.entries()) {
		const plain =
			index === last && !directory ? NAME.test(segment) : SEGMENT.test(segment);
		if (!plain)
			return refused(
				`"${path}" is not a plain path in the folder: each part is letters, digits, "-" and "_", and only a file's name ends in one extension.`,
			);
	}
	return Ok(segments);
}

/** UTF-8 text as bytes, and back. */
export const encode = (text: string) => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array) =>
	new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** A message for whatever was thrown. */
export const messageOf = (cause: unknown) =>
	cause instanceof Error
		? cause.message
		: typeof cause === 'object' && cause !== null && 'message' in cause
			? String((cause as { message: unknown }).message)
			: String(cause);
