/**
 * What every folder builds on its storage (`boundary.ts`): content-save
 * accounting, the close fence, and the reads and file verbs that are only
 * `read` and `put` composed.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CapturedFiles, FileRead, FolderStorage } from './boundary.js';
import { type FileCapture, fileCapture, hashBytes } from './capture.js';
import { FileError, MoveError } from './errors.js';
import type { History } from './git/history.js';
import { isPortablePath } from './paths.js';
import { confirmedPut } from './save-file.js';

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
	history: Pick<History, 'noteEdit'>;
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

/** The SHA-256 at `path` now, for a refusal that names it. */
async function actualAt(storage: Pick<FolderStorage, 'read'>, path: string) {
	const read = await storage.read(path);
	return read.error === null ? read.data.sha256 : undefined;
}

/** Create `path` holding `bytes`, only where no file is: `Exists` otherwise. */
export async function createFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	path: string,
	bytes: Uint8Array,
): Promise<Result<FileCapture, FileError>> {
	const sha256 = await hashBytes(bytes);
	const { data: put, error } = await confirmedPut(
		storage,
		path,
		bytes,
		null,
		sha256,
	);
	if (error !== null) return Err(error);
	if (put === 'stale') return FileError.Exists({ path });
	return Ok(fileCapture(path, sha256));
}

/**
 * Replace the captured file's bytes, only while it holds the captured ones:
 * `Conflict` otherwise.
 */
export async function replaceFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	file: FileCapture,
	bytes: Uint8Array,
): Promise<Result<FileCapture, FileError>> {
	const sha256 = await hashBytes(bytes);
	const { data: put, error } = await confirmedPut(
		storage,
		file.path,
		bytes,
		file.sha256,
		sha256,
	);
	if (error !== null) return Err(error);
	if (put === 'stale')
		return FileError.Conflict({
			path: file.path,
			expectedSha256: file.sha256,
			actualSha256: await actualAt(storage, file.path),
		});
	return Ok(fileCapture(file.path, sha256));
}

/** Remove the captured file, only while it holds the captured bytes. */
export async function removeFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	file: FileCapture,
): Promise<Result<undefined, FileError>> {
	const { data: put, error } = await confirmedPut(
		storage,
		file.path,
		null,
		file.sha256,
		null,
	);
	if (error !== null) return Err(error);
	if (put === 'stale') {
		const actualSha256 = await actualAt(storage, file.path);
		return actualSha256 === undefined
			? FileError.NotFound({ path: file.path })
			: FileError.Conflict({
					path: file.path,
					expectedSha256: file.sha256,
					actualSha256,
				});
	}
	return Ok(undefined);
}

/**
 * Move the captured file to `to`, where no file is: its bytes land at `to`,
 * then `from` is removed while it still holds them. Two changes, so a crash
 * or a refused removal between them leaves both paths holding the file
 * (`MoveError.SourceNotRemoved`), which a person can see and repair
 * (ADR-0503).
 */
export async function moveFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	file: FileCapture,
	to: string,
): Promise<Result<FileCapture, FileError | MoveError>> {
	const { data: read, error: readError } = await storage.read(file.path);
	if (readError !== null) return Err(readError);
	if (read.sha256 !== file.sha256)
		return FileError.Conflict({
			path: file.path,
			expectedSha256: file.sha256,
			actualSha256: read.sha256,
		});
	const created = await createFile(storage, to, read.bytes);
	if (created.error !== null) return created;
	const removed = await removeFile(storage, file);
	if (removed.error !== null)
		return MoveError.SourceNotRemoved({
			from: file.path,
			to,
			moved: created.data,
			cause: removed.error,
		});
	return created;
}
