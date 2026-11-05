/**
 * A place's store: four verbs over bytes at paths (ADR-0779), answered by
 * memory (`memory-store.ts`), a directory in Bun (`node-store.ts`), a root
 * the desktop shell named (`tauri-store.ts`), a directory a program serves
 * its page (`served/store.ts`), and a repository on the server
 * (`remote/store.ts`). Paths are relative and `/`-separated, the same paths
 * a desktop folder holds. A store knows nothing of contracts, notes, or what
 * a page holds: the folder composes its connection from these verbs.
 *
 * A version names a file's bytes, and only the store that gave it can read
 * it. A write carries the version its writer read and lands only while the
 * file still holds it; the store checks that where the write lands, right
 * before the change.
 *
 * `storeChecks` (`store.conformance.ts`) holds every store to the same
 * behavior.
 */
import { type ClientError, isNotePath } from '@epicenter/definition/contract';
import type { Brand } from 'wellcrafted/brand';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * The version of a file a store answered: the repository's Git blob id (of
 * a note, or of an attachment's Git LFS pointer); in memory, the sha256 of
 * a file's bytes; in a directory in Bun, a file's stamp (its size,
 * modification time and identity), so a listing never reads a file to name
 * it; in the desktop shell, a note's sha256 and an attachment's stamp
 * (`versionedByContent`). Opaque and internal: the folder compares it and
 * writes over it, and no app ever holds one (ADR-0774). A version says
 * whether a file changed, not whether two files hold the same bytes: a
 * stamp changes when a file is saved with the bytes it had, so a sync that
 * finds a changed version compares bytes before it copies.
 */
export type Version = string & Brand<'Version'>;

/** One file a listing found: its version, and its size in bytes where the store knows it without reading. */
export type Listed = {
	readonly path: string;
	readonly version: Version;
	readonly size: number | null;
};

/** One path a read answered: its bytes and their version, or that nothing is there. */
export type FileRead =
	| { readonly path: string; readonly bytes: Uint8Array; readonly version: Version }
	| { readonly path: string; readonly gone: true };

/** Hear the paths that changed, or `'all'` when the store cannot tell which. */
export type Changed = (paths: readonly string[] | 'all') => void;

export type Store = {
	/**
	 * Every file at or below each of `under` (a directory or a file path;
	 * `''` is everything), at any depth, hidden ones included for the reader
	 * to skip, each with its version. Directories are not listed.
	 */
	list(under: readonly string[]): Promise<Result<Listed[], Unavailable>>;
	/**
	 * The files at `paths`, one answer per path in the same order: its bytes
	 * and version, or `gone`. The repository answers them in one request.
	 */
	read(paths: readonly string[]): Promise<Result<FileRead[], Unavailable>>;
	/**
	 * Write `bytes` at `path`, or remove the file for null, only while the
	 * path holds `over` (`'absent'`: nothing), and answer the version that
	 * landed (null for a removal). `'stale'` when the path holds something
	 * else, and nothing changed. A new file appears whole, never empty first;
	 * missing parent directories are made.
	 */
	write(
		path: string,
		bytes: Uint8Array | null,
		over: Version | 'absent',
	): Promise<Result<Version | null | 'stale', Unavailable>>;
	/**
	 * Start hearing changes: answers once it is listening, with the stop.
	 * From then `changed` hears the paths that changed (another tab, the
	 * desktop shell's watcher, another program, and maybe this store's own
	 * writes), or `'all'` when it cannot tell, and only once a read of them
	 * answers the change.
	 */
	watch(changed: Changed): Promise<Result<() => void, Unavailable>>;
	/** Release what the store holds open; every later call is `Unavailable`. */
	close(): void;
};

/**
 * Whether the desktop shell names the file at `path` by the sha256 of its
 * bytes (a note: small, and read whole anyway), rather than by its stamp
 * (an attachment, which the later write wins, ADR-0771: the stamp tells
 * that it changed without reading what may be a long recording).
 */
export const versionedByContent = (path: string) => isNotePath(path);

/** Whether `path` is at or below one of `under` (`''` is everything). */
export function within(path: string, under: readonly string[]): boolean {
	return under.some(
		(prefix) =>
			prefix === '' || path === prefix || path.startsWith(`${prefix}/`),
	);
}
