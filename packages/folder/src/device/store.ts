/**
 * The storage a device client works over: a directory in Bun
 * (`node-store.ts`) or this origin's private file system in a browser
 * (`opfs-store.ts`). Paths are relative and `/`-separated, the same paths a
 * desktop folder holds.
 *
 * A version is the sha256 of a file's bytes, so a write can carry the
 * version its writer read and land only while the file still holds it. The
 * store checks that where the write lands, right before the change.
 */
import type { ClientError, Version } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { ChangeListener } from '../changes.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * What a device write expects at its path: nothing (`'absent'`), the bytes
 * whose sha256 is `sha256`, the version its writer read, or anything
 * (`'any'`, for a cache: never stale, and nothing is read first). Each case
 * is its own shape, so a version can never be read as a keyword.
 */
export type DeviceExpectation = 'absent' | 'any' | { readonly sha256: Version };

export type DeviceStore = {
	/**
	 * Every file below the root, at any depth, hidden ones included, each
	 * with a stamp that changes whenever its bytes do. Directories are not
	 * listed.
	 */
	list(): Promise<Result<{ path: string; stamp: string }[], Unavailable>>;
	/** The file at `path`, or null when nothing is there. */
	read(
		path: string,
	): Promise<
		Result<
			{ bytes: Uint8Array; version: Version; stamp: string } | null,
			Unavailable
		>
	>;
	/**
	 * Write `bytes` at `path`, or remove the file for null, only while the
	 * path holds what `expected` says. `'stale'` when it does not, and
	 * nothing changed. A new file appears whole, never empty first; missing
	 * parent directories are made.
	 */
	write(
		path: string,
		bytes: Uint8Array | null,
		expected: DeviceExpectation,
	): Promise<Result<'landed' | 'stale', Unavailable>>;
	/**
	 * Add `bytes` to the end of the file at `path`, for a file written while
	 * it is made, such as a recording. With `create` the file is made with
	 * these bytes (and its missing directories), never over one that is
	 * there (`'stale'`); without, the bytes go after what is there, and a
	 * file that went is `'stale'`. Only this origin's private files have it:
	 * on the desktop the shell writes a recording itself.
	 *
	 * Listeners hear the file when it is made, and after that only an append
	 * with `announce`: a file that grows every second would otherwise be
	 * listed, read, and hashed again every second.
	 */
	append?(
		path: string,
		bytes: Uint8Array,
		options: { create: boolean; announce: boolean },
	): Promise<Result<'landed' | 'stale', Unavailable>>;
	/**
	 * Hear changes made outside this store: by another tab, the desktop
	 * shell's watcher, or another program. It may also hear this store's own
	 * writes, and may give null for "something may have changed". Started
	 * by the first listener, stopped with the last; returns the stop.
	 */
	watch(listener: ChangeListener): () => void;
	/** Release what the store holds open; every later call is `Unavailable`. */
	close?(): void;
};
