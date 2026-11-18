/**
 * A folder's history on the server, as the retired folder sync read it
 * (ADR-0803, ADR-0824). The server answers it (`remote/repository.ts`).
 *
 * A file's version is the SHA-256 of its bytes, the same on every store, so
 * a sync asks which paths changed since the cursor both sides last agreed at,
 * each with its version now (`changes`), every file when it cannot tell
 * (`files`), and bytes by version (`blobs`): a note's base for a merge is the
 * version the manifest agreed on, read by it. It lands a batch of files in
 * one change, each only where the path still holds the version its writer
 * expects (`append`), or nothing; a batch adding a path that differs only in
 * case from one the folder holds is refused, naming that path (ADR-0804).
 */
import type { Result } from 'wellcrafted/result';
import type { Unavailable, Version } from '../device/store.js';

/** A path whose version changed: its version now, null when it was deleted. */
export type ChangedPath = { path: string; version: Version | null };

/** One file the folder holds: its version, and its size. */
export type FileEntry = { path: string; version: Version; size: number | null };

/** One file of a change: its bytes, or null to delete it, where the path holds the version its writer expects (null: nothing). */
export type ChangeWrite = {
	path: string;
	bytes: Uint8Array | null;
	expect: Version | null;
};

/**
 * A change the folder refused for one place, which no retry fixes: a path
 * that differs only in case from one it holds (`refused` is that path, or
 * the folder whose name clashes), and why.
 */
export type ChangeRefusal = { refused: string; reason: string };

/** A change that landed: the log's head after it, and the version now at each path (null where a delete landed). */
export type ChangeReceipt = {
	cursor: string;
	versions: Record<string, Version | null>;
};

/** A change that landed nothing: every path that held something other than its writer expected, and what. */
export type ChangeMoved = {
	moved: { path: string; now: Version | null }[];
};

export type Repository = {
	/**
	 * The log's head as a cursor, and each path whose version changed since
	 * `since` with its version now: null ("compare every path") when `since`
	 * is null, names no point of this log, or is too far behind.
	 */
	changes(
		since: string | null,
	): Promise<
		Result<{ cursor: string; changes: ChangedPath[] | null }, Unavailable>
	>;
	/** Every file the folder holds now, and the cursor they are as of. */
	files(): Promise<Result<{ cursor: string; files: FileEntry[] }, Unavailable>>;
	/** The bytes of each version, in order: null for one the folder holds no bytes for. */
	blobs(
		versions: readonly Version[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>>;
	/**
	 * Land every write in one change, or none: `ChangeMoved` when any path
	 * holds something other than its `expect`, and a `ChangeRefusal` when a
	 * path would differ only in case from one the folder then holds.
	 */
	append(
		writes: readonly ChangeWrite[],
	): Promise<Result<ChangeReceipt | ChangeMoved | ChangeRefusal, Unavailable>>;
};
