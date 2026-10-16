/**
 * The folder's one storage contract, which every host implements natively
 * (ADR-0576): a browser over the origin private file system
 * (`opfs-store.ts`), and a directory over its host's file system
 * (`directory-store.ts`), in Bun and in the desktop shell alike.
 *
 * `put` is the one change: one file's bytes, or its removal, landing only
 * while the path holds what the caller expects. It lands whole: a reader,
 * and a crash, see the old file or the new one, never part of either, and a
 * new file never appears empty first. Where Sync publishes, `lock` holds the
 * folder's save lock, the one every cooperating writer takes for each
 * change, across several (`LockingStorage`). Reads, a folder's list, and its
 * captures are built on these.
 *
 * Saves are not ordered by when their methods were called: the last to land
 * on a path wins. A change that must not overwrite bytes its caller did not
 * review carries `ifMatch`.
 */
import type { Result } from 'wellcrafted/result';
import type { FileError } from './errors.js';

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

/** Every portable file's bytes, captured for a commit or status observation. */
export type CapturedFiles = {
	readonly files: ReadonlyMap<string, Uint8Array>;
	/** Paths enumeration found but whose bytes could not be read. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: FileError;
	}[];
};

/** A folder's files, as each host stores them. */
export type FolderStorage = {
	/** Every entry below the folder, `.git` aside. */
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
	/**
	 * Publish `bytes` at `path`, or remove its file for `null`, only while
	 * the path holds `ifMatch`: the SHA-256 of the file there, or `null` for
	 * no file. `'stale'` when it does not, and nothing changed. Missing
	 * parent directories are made for a new file. The bytes land whole. The
	 * host checks the condition where the change lands, under the folder's
	 * save lock: the Web Lock in a browser, and in a directory the lock the
	 * desktop shell and Bun share (ADR-0562). A reply that was lost is
	 * `Unconfirmed`.
	 */
	put(
		path: string,
		bytes: Uint8Array | null,
		ifMatch: string | null,
	): Promise<Result<'landed' | 'stale', FileError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	/** Remove the empty directory at `path`. */
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/**
 * Storage that Sync publishes through: the browser's, and a directory's in
 * Bun, where the `epicenter` CLI runs a desktop page's Sync. A desktop page's
 * own storage has no `lock`, since its Sync never runs there.
 */
export type LockingStorage = FolderStorage & {
	/**
	 * Run `work` holding the folder's save lock, with storage whose changes
	 * land under it without asking for it again, so no cooperating save lands
	 * between `work`'s check and its last change.
	 */
	lock<T>(work: (held: FolderStorage) => Promise<T>): Promise<T>;
};
