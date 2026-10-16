/**
 * What every folder builds on its storage (`boundary.ts`): content-save
 * accounting, the close fence, and the reads that are only `read` and
 * `list` composed. The one write and the move are in `write.ts`.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CapturedFiles, FileRead, FolderStorage } from './boundary.js';
import { FileError } from './errors.js';
import type { FolderHistory } from './folder.js';
import { isPortablePath } from './paths.js';

/**
 * Every folder records its local saves here: each one that may have changed
 * a file makes the history's observations stale, including those made under
 * the save lock. A save is not reported to the handle's own change listeners
 * (ADR-0548): whoever saved holds the result.
 */
export function withPublication({
	storage,
	history,
}: {
	storage: FolderStorage;
	history: Pick<FolderHistory, 'noteEdit'>;
}): FolderStorage {
	const noting = (inner: FolderStorage): FolderStorage => ({
		...inner,
		async put(path, bytes, ifMatch) {
			const result = await inner.put(path, bytes, ifMatch);
			if (result.data === 'landed' || result.error?.name === 'Unconfirmed')
				history.noteEdit();
			return result;
		},
		lock: (work) => inner.lock((held) => work(noting(held))),
	});
	return noting(storage);
}

/** Fence the next backend call. A begun call owns its complete result. */
export function fenceStorage(
	storage: FolderStorage,
	signal: AbortSignal,
): FolderStorage {
	const closed = () => Promise.resolve(FileError.Closed());
	return {
		list: () => (signal.aborted ? closed() : storage.list()),
		children: (directory) =>
			signal.aborted ? closed() : storage.children(directory),
		read: (path) => (signal.aborted ? closed() : storage.read(path)),
		put: (path, bytes, ifMatch) =>
			signal.aborted ? closed() : storage.put(path, bytes, ifMatch),
		mkdir: (path) => (signal.aborted ? closed() : storage.mkdir(path)),
		rmdir: (path) => (signal.aborted ? closed() : storage.rmdir(path)),
		lock: (work) =>
			signal.aborted
				? Promise.reject(new Error('The folder is closed'))
				: storage.lock(work),
	};
}

/** Reads several files; a missing or unreadable path is reported by path. */
export async function readMany(
	storage: Pick<FolderStorage, 'read'>,
	paths: readonly string[],
): Promise<Map<string, Result<FileRead, FileError>>> {
	const results = new Map<string, Result<FileRead, FileError>>();
	for (const path of paths) results.set(path, await storage.read(path));
	return results;
}

/**
 * Stable bytes for consumption: the bytes are copied into memory, so later
 * changes to the path do not alter them.
 */
export async function openFile(
	storage: Pick<FolderStorage, 'read'>,
	path: string,
): Promise<Result<Blob, FileError>> {
	const { data: read, error } = await storage.read(path);
	if (error !== null) return Err(error);
	return Ok(new Blob([read.bytes as Uint8Array<ArrayBuffer>]));
}

/**
 * Every portable file's bytes, read now, for a commit or a status. A file
 * removed while it is read is left out, as if the listing had missed it; a
 * file that cannot be read is reported.
 */
export async function captureFiles(
	storage: Pick<FolderStorage, 'list' | 'read'>,
): Promise<Result<CapturedFiles, FileError>> {
	const { data: listed, error } = await storage.list();
	if (error !== null) return Err(error);
	const files = new Map<string, Uint8Array>();
	const unreadable: { path: string; error: FileError }[] = [];
	for (const { path } of listed.files) {
		if (!isPortablePath(path)) continue;
		const read = await storage.read(path);
		if (read.error === null) files.set(path, read.data.bytes);
		else if (read.error.name !== 'NotFound')
			unreadable.push({ path, error: read.error });
	}
	return Ok({ files, unreadable });
}
