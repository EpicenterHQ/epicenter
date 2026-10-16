/**
 * Content-save accounting, the close fence over acquired storage, and the
 * one-change publication every ordinary domain method makes.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileChange, FolderStorage } from './boundary.js';
import { type FileCapture, fileCapture, hashBytes } from './capture.js';
import { FileError, MoveError } from './errors.js';
import type { History } from './git/history.js';

/**
 * Whether an application may have changed a file: a confirmed batch, a
 * partial one with a landed step or an unconfirmed failed step, or an
 * unconfirmed one.
 */
function mayHaveChanged(
	error: Awaited<ReturnType<FolderStorage['apply']>>['error'],
): boolean {
	if (error === null) return true;
	if (error.name === 'Partial')
		return error.applied.length > 0 || error.error.name === 'Unconfirmed';
	return error.name === 'Unconfirmed';
}

/**
 * Every folder records its local saves here: each one that may have changed
 * a file makes the history's observations stale. A save is not reported to
 * the handle's own change listeners (ADR-0548): whoever saved holds the
 * result.
 */
export function withPublication({
	storage,
	history,
}: {
	storage: FolderStorage;
	history: Pick<History, 'noteEdit'>;
}): FolderStorage {
	return {
		...storage,
		async put(path, bytes, ifMatch) {
			const result = await storage.put(path, bytes, ifMatch);
			if (result.data === 'landed' || result.error?.name === 'Unconfirmed')
				history.noteEdit();
			return result;
		},
		async apply(changes) {
			const result = await storage.apply(changes);
			if (mayHaveChanged(result.error)) history.noteEdit();
			return result;
		},
	};
}

/** Fence the next backend call. A begun call owns its complete result. */
export function fenceStorage(
	storage: FolderStorage,
	signal: AbortSignal,
): FolderStorage {
	return {
		list: () =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.list(),
		children: (directory) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.children(directory),
		read: (path) =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.read(path),
		readMany: (paths) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.readMany(paths),
		open: (path) =>
			signal.aborted ? Promise.resolve(FileError.Closed()) : storage.open(path),
		put: (path, bytes, ifMatch) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.put(path, bytes, ifMatch),
		apply: (changes) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.apply(changes),
		mkdir: (path) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.mkdir(path),
		rmdir: (path) =>
			signal.aborted
				? Promise.resolve(FileError.Closed())
				: storage.rmdir(path),
	};
}

type Move = Extract<FileChange, { kind: 'move' }>;

/**
 * Publish one change and state its outcome as one file operation.
 *
 * Raw storage reports a move whose destination landed but whose source was
 * not removed as a partial application; that becomes
 * `MoveError.SourceNotRemoved`, which names the destination with the move's
 * guard hash, a baseline-conditioned receipt rather than a read of what the
 * destination holds now. Any other partial report contradicts a single
 * change, so its outcome is `Unconfirmed` and carries the report as its
 * cause. Accounting below this call has already seen the raw report and
 * announced the landed paths.
 */
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Exclude<FileChange, Move>,
): Promise<Result<undefined, FileError>>;
export function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Move & { expectedSha256: string },
): Promise<Result<undefined, FileError | MoveError>>;
export async function applyOne(
	storage: Pick<FolderStorage, 'apply'>,
	change: Exclude<FileChange, Move> | (Move & { expectedSha256: string }),
): Promise<Result<undefined, FileError | MoveError>> {
	const { error } = await storage.apply([change]);
	if (error === null) return Ok(undefined);
	if (error.name !== 'Partial') return Err(error);
	const [landed, ...rest] = error.applied;
	if (
		change.kind === 'move' &&
		rest.length === 0 &&
		landed?.kind === 'write' &&
		landed.path === change.to
	)
		return MoveError.SourceNotRemoved({
			from: change.from,
			to: change.to,
			moved: fileCapture(change.to, change.expectedSha256),
			cause: error.error,
		});
	return FileError.Unconfirmed({
		path: change.kind === 'move' ? change.from : change.path,
		operation: 'publishing',
		cause: error,
	});
}

/**
 * Replace the captured file's bytes and return the capture of the new ones.
 * Refused as `Conflict` when the file no longer holds the captured bytes. A
 * reply that leaves the outcome `Unconfirmed` is checked with one read:
 * bytes that hash to what was sent are this save, confirmed after all, so a
 * session does not mistake its own landed save for someone else's change.
 */
export async function replaceCaptured(
	storage: Pick<FolderStorage, 'apply' | 'read'>,
	file: FileCapture,
	bytes: Uint8Array,
): Promise<Result<FileCapture, FileError>> {
	const sha256 = await hashBytes(bytes);
	const applied = await applyOne(storage, {
		kind: 'replace',
		path: file.path,
		bytes,
		sha256,
		expectedSha256: file.sha256,
	});
	if (applied.error === null) return Ok(fileCapture(file.path, sha256));
	if (applied.error.name !== 'Unconfirmed') return Err(applied.error);
	const read = await storage.read(file.path);
	if (read.error === null && read.data.sha256 === sha256)
		return Ok(fileCapture(file.path, sha256));
	return Err(applied.error);
}
