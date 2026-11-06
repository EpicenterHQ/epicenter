/**
 * A place's store: four verbs over bytes at paths (ADR-0779), answered by
 * memory (`memory-store.ts`), a directory in Bun (`node-store.ts`), a root
 * the desktop shell named (`tauri-store.ts`), a directory a program serves
 * its page (`served/store.ts`), and a folder on the server
 * (`remote/repository.ts`). Paths are relative and `/`-separated, the same paths
 * a desktop folder holds. A store knows nothing of contracts, notes, or what
 * a page holds: the folder composes its connection from these verbs.
 *
 * A file's version is the SHA-256 of its bytes on every store, for every
 * path (ADR-0824, `versionOf`). One version names one file's bytes on a
 * computer, in the browser, and on the server, so nothing translates
 * between them.
 *
 * A write is `put(path, bytes | null, expect)`: it lands only while the
 * path still holds `expect` (null: nothing), checked where the write lands,
 * right before the change, and fails with `Moved { now }` otherwise.
 *
 * `storeChecks` (`store.conformance.ts`) holds every store to the same
 * behavior.
 */
import type { ClientError } from '@epicenter/definition/contract';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { versionOf } from '../hash.js';

export type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * A file's version: the SHA-256 of its bytes, 64 lowercase hex digits. Opaque to apps: the folder compares it and writes
 * over it, and no app ever holds one (ADR-0774).
 */
export type Version = string & Brand<'Version'>;

/** Why a `put` did not land. */
export const StoreError = defineErrors({
	/**
	 * The path no longer holds what the writer expected: `now` is what it
	 * holds (null: nothing), and nothing changed.
	 */
	Moved: ({ path, now }: { path: string; now: Version | null }) => ({
		message: `${path} moved: it holds ${now ?? 'nothing'}`,
		path,
		now,
	}),
});
export type Moved = InferError<typeof StoreError.Moved>;
export type StoreError = InferErrors<typeof StoreError>;

/** One file a listing found: its version, and its size in bytes where the store knows it without reading. */
export type Listed = {
	readonly path: string;
	readonly version: Version;
	readonly size: number | null;
};

/** One path a read answered: its bytes and their version, or that nothing is there. */
export type FileRead =
	| {
			readonly path: string;
			readonly bytes: Uint8Array;
			readonly version: Version;
	  }
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
	 * Put `bytes` at `path`, or remove the file for null, only while the
	 * path holds `expect` (null: nothing), and answer the version that
	 * landed (null for a removal). `Moved` when the path holds something
	 * else, carrying what, and nothing changed. A new file appears whole,
	 * never empty first; missing parent directories are made.
	 */
	put(
		path: string,
		bytes: Uint8Array | null,
		expect: Version | null,
	): Promise<Result<Version | null, Moved | Unavailable>>;
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
	/**
	 * Whether puts made at once land together (the folder on the server
	 * commits them as one), so the folder runs the writes waiting at
	 * different paths at once rather than one after another.
	 */
	readonly batches?: true;
};

/**
 * `put`, where a `Moved` whose `now` is the version this write meant to
 * land counts as landed (ADR-0808): a reply that was lost, or another
 * writer that wrote the same bytes.
 */
export async function putLanded(
	store: Store,
	path: string,
	bytes: Uint8Array | null,
	expect: Version | null,
): Promise<Result<Version | null, Moved | Unavailable>> {
	const put = await store.put(path, bytes, expect);
	if (put.error?.name !== 'Moved') return put;
	const meant = bytes === null ? null : await versionOf(bytes);
	return put.error.now === meant ? Ok(meant) : put;
}

/** Whether `path` is at or below one of `under` (`''` is everything). */
export function within(path: string, under: readonly string[]): boolean {
	return under.some(
		(prefix) =>
			prefix === '' || path === prefix || path.startsWith(`${prefix}/`),
	);
}
