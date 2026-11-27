/**
 * Where Whispering keeps its files: a few operations on one folder, with
 * one implementation for each place the page runs (`platform/index.ts` picks):
 *
 * - `tauriFiles()` on the desktop: the app's local data directory.
 * - `opfsFiles()` in a browser: the Origin Private File System.
 *
 * A path is relative to the folder, uses `/`, and is a plain name
 * (`checkPath`), so nothing reaches outside the folder. The page reads only
 * text: a note is small and read whole, while audio is played from `url`
 * and never read into the page.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';

/** `Refused`: the path is not a plain path in the folder. `Io`: the storage failed. */
export type FilesError = {
	readonly name: 'Refused' | 'Io';
	readonly message: string;
};

export type Files = {
	/** Where the files are, as a person reads it: "this app's data folder". */
	keptIn: string;
	/**
	 * The names of the files directly in `dir` (`''` is the folder itself),
	 * sorted: plain names only, so no directory, hidden file, or temporary
	 * file. A directory that is not there holds none.
	 */
	list(dir: string): Promise<Result<string[], FilesError>>;
	/** The text of each file of `paths` that is there, by path; a missing one is left out. */
	readMany(
		paths: readonly string[],
	): Promise<Result<Map<string, string>, FilesError>>;
	/**
	 * Replace the file at `path` whole, making its directories. A reader sees
	 * the old contents or the new, never part of either.
	 */
	write(
		path: string,
		contents: string | Uint8Array,
	): Promise<Result<undefined, FilesError>>;
	/** Remove the file at `path`. One that is not there is already removed. */
	remove(path: string): Promise<Result<undefined, FilesError>>;
	/** A URL an `<audio>` element plays the file at `path` from, without reading it into the page. */
	url(path: string): Promise<Result<string, FilesError>>;
	/** How many bytes the files directly in `dir` hold; a directory that is not there holds none. */
	size(dir: string): Promise<Result<number, FilesError>>;
	/**
	 * Show the folder in the system's file manager, or null where no file
	 * manager can: a browser's files are the browser's own.
	 */
	reveal: (() => Promise<Result<undefined, FilesError>>) | null;
};

export const refused = (message: string) =>
	Err<FilesError>({ name: 'Refused', message });
export const failed = (message: string) =>
	Err<FilesError>({ name: 'Io', message });

/** A directory's name: letters, digits, `-` and `_`. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A file's name: a directory's name, then at most one extension. */
const NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;

/** Whether `name` is a plain file name, as a listing shows it. A temporary `<name>.md.tmp` is not. */
export const isPlainName = (name: string) => NAME.test(name);

/**
 * The segments of `path` when it is a plain path in the folder: each segment
 * letters, digits, `-` and `_`, and a file's may end in one extension. No
 * segment starts with a dot, so `..`, a hidden file and an absolute path are
 * refused. A directory (`directory: true`) has no extension, and `''` is the
 * folder itself.
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

/** `contents` as bytes. */
export const toBytes = (contents: string | Uint8Array) =>
	typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
