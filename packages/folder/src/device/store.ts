/**
 * The storage a device client works over: a directory in Bun
 * (`node-store.ts`), this origin's private file system in a browser
 * (`opfs-store.ts`), or a repository on the server (`remote/store.ts`).
 * Paths are relative and `/`-separated, the same paths a desktop folder
 * holds.
 *
 * A version names a file's bytes, and only the store that gave it can read
 * it: a device's is their sha256, a repository's the Git blob id on `main`.
 * A write carries the version its writer read and lands only while the
 * file still holds it. The store checks that where the write lands, right
 * before the change.
 */
import type { ClientError } from '@epicenter/definition/contract';
import type { Brand } from 'wellcrafted/brand';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { ChangeListener } from '../changes.js';

export type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * The version of a file a read saw: a device's sha256 of its bytes, the
 * repository's Git blob id (a note) or Git LFS object id (any other file).
 * Opaque and internal: the folder compares it and writes over it, and no
 * app ever holds one (ADR-0774).
 */
export type Version = string & Brand<'Version'>;

/**
 * What a device write expects at its path, the version its writer read:
 * nothing (`'absent'`, a create), or the bytes `version` names. Each case
 * is its own shape, so a version can never be read as a keyword.
 */
export type DeviceExpectation = 'absent' | { readonly version: Version };

/** A write that landed: the version now at its path (null for a removal). */
export type DeviceLanded = { readonly landed: Version | null };

export type DeviceStore = {
	/**
	 * Every file below the root, at any depth, hidden ones included, each
	 * with a stamp that changes whenever its bytes do, and its version when
	 * the store knows it without reading the bytes. Directories are not
	 * listed. `under` (a directory, `/`-separated) is a hint: a store that
	 * can list less lists only the files below it, and one that cannot lists
	 * every file, so a caller still checks each path.
	 */
	list(
		under?: string,
	): Promise<
		Result<{ path: string; stamp: string; version?: Version }[], Unavailable>
	>;
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
	 * path holds what `expected` says, and answer the version that landed.
	 * `'stale'` when it does not, and nothing changed. A new file appears
	 * whole, never empty first; missing parent directories are made.
	 */
	write(
		path: string,
		bytes: Uint8Array | null,
		expected: DeviceExpectation,
	): Promise<Result<DeviceLanded | 'stale', Unavailable>>;
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
