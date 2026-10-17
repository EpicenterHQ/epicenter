/** Ordinary file reads and directories over the folder's accounted storage. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileListing, FileRead, FolderStorage } from './boundary.js';
import type { FileError } from './errors.js';

/**
 * Ordinary files at literal folder-relative paths (ADR-0479): what a folder
 * holds, and its directories. A file's content changes only through the one
 * write, `folder.write(path, from, to)`, and a file moves only through
 * `folder.move(path, next)` (ADR-0576).
 */
export type FolderFiles = {
	list(): Promise<Result<FileListing, FileError>>;
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	/** The file's bytes, detached from storage, and the SHA-256 that names them. */
	read(path: string): Promise<Result<FileRead, FileError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/** The file reads and directories over `storage`. */
export function createFiles({
	storage,
}: {
	storage: FolderStorage;
}): FolderFiles {
	return Object.freeze({
		list: () => storage.list(),
		children: (directory) => storage.children(directory),
		async read(path) {
			const { data: read, error } = await storage.read(path);
			if (error !== null) return Err(error);
			return Ok(Object.freeze({ bytes: read.bytes, sha256: read.sha256 }));
		},
		mkdir: (path) => storage.mkdir(path),
		rmdir: (path) => storage.rmdir(path),
	} satisfies FolderFiles);
}
