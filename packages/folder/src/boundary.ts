/**
 * Domain methods share one storage API. Openers attach local-save accounting
 * before assembly gives it to files, tables, and KV. Git keeps
 * raw storage for its own publication sequence and captures.
 *
 * `put` is the one conditional change of one file that `folder.write`
 * makes (ADR-0576). `apply` takes ordered changes for Git publication and
 * the native transport; the earlier verbs of files, tables, and KV publish
 * one change at a time through `applyOne` (`storage.ts`), which restates
 * the raw outcome.
 *
 * Saves are not ordered by when their methods were called: the last to land
 * on a path wins. A change that must not overwrite bytes its caller did not
 * review carries `expectedSha256`.
 *
 * Browser OPFS and native applications both use ordered filesystem steps and
 * report completed steps on later failure.
 */
import type { Result } from 'wellcrafted/result';
import type { ApplyError, FileError } from './errors.js';

export type FileRead = {
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

export type FileListing = {
	/**
	 * Every entry that is not a directory, including files outside portable
	 * scope, symbolic links, and special entries, none of them followed. A
	 * read refuses what is not a regular file.
	 */
	readonly files: readonly { readonly path: string; readonly size: number }[];
	/** Every directory, including empty ones kept for the shell. */
	readonly directories: readonly string[];
};

/**
 * A write owns its bytes before the asynchronous hash is computed.
 *
 * `replace` always requires a file at the path: it never creates one, with
 * or without `expectedSha256`. With it, the current bytes must also hash to
 * that value. Only `overwrite` saves whatever is, or is not, there.
 */
type FileWriteIntent = { path: string; bytes: Uint8Array } & (
	| { kind: 'create' }
	| { kind: 'overwrite' }
	| { kind: 'replace'; expectedSha256?: string }
);

/** The operation states its publication condition. Move destinations must be absent. */
export type FileChange =
	| (FileWriteIntent & { sha256: string })
	| { kind: 'remove'; path: string; expectedSha256?: string }
	| { kind: 'move'; from: string; to: string; expectedSha256?: string };

/** Every portable file's bytes, captured for a commit or status observation. */
export type CapturedFiles = {
	readonly files: ReadonlyMap<string, Uint8Array>;
	/** Paths enumeration found but whose bytes could not be read. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: FileError;
	}[];
};

/** Storage used by domain methods; apply includes content-save accounting. */
export type FolderStorage = {
	list(): Promise<Result<FileListing, FileError>>;
	/**
	 * Immediate children of a directory by name: real subdirectories in
	 * `directories`, every other entry in `files`, including a symbolic link or
	 * special entry that a read refuses. Nothing present is left out.
	 */
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	read(path: string): Promise<Result<FileRead, FileError>>;
	/** Reads several files; a missing or unreadable path is reported by path. */
	readMany(
		paths: readonly string[],
	): Promise<Result<Map<string, Result<FileRead, FileError>>, FileError>>;
	/** Stable bytes for consumption; later path changes do not alter them. */
	open(path: string): Promise<Result<Blob, FileError>>;
	/**
	 * Publish `bytes` at `path`, or remove its file for `null`, only while
	 * the path holds `ifMatch`: the SHA-256 of the file there, or `null` for
	 * no file. `'stale'` when it does not, and nothing changed. Missing
	 * parent directories are made for a new file. The host checks the
	 * condition where the change lands: under the folder's Web Lock in a
	 * browser, and in a directory under its save lock, in the desktop shell
	 * and in Bun alike (ADR-0562).
	 */
	put(
		path: string,
		bytes: Uint8Array | null,
		ifMatch: string | null,
	): Promise<Result<'landed' | 'stale', FileError>>;
	/** Publish `changes` in order, each under its own condition. */
	apply(
		changes: readonly FileChange[],
	): Promise<Result<undefined, FileError | ApplyError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/** Raw storage also captures portable files for history. */
export type FileBoundary = FolderStorage & {
	capture(): Promise<Result<CapturedFiles, FileError>>;
};
