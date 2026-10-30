/**
 * The storage a device client works over: a directory in Bun
 * (`node-store.ts`) or this origin's private file system in a browser
 * (`opfs-store.ts`). Paths are relative and `/`-separated, the same paths a
 * desktop folder holds.
 *
 * A version is the sha256 of a file's bytes, so a write can carry the
 * version its writer read and land only while the file still holds it. The
 * store checks that where the write lands, under its own lock, so no
 * cooperating writer lands between the check and the change.
 */
import type { ClientError, Version } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

type Unavailable = InferError<typeof ClientError.Unavailable>;

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
	 * path holds what `expected` says: nothing (`'absent'`), bytes whose
	 * sha256 is the version, or anything (`'any'`, for a cache: never stale,
	 * and nothing is read first). `'stale'` when it does not, and nothing
	 * changed. A new file appears whole, never empty first; missing parent
	 * directories are made.
	 */
	write(
		path: string,
		bytes: Uint8Array | null,
		expected: 'absent' | 'any' | Version,
	): Promise<Result<'landed' | 'stale', Unavailable>>;
	/** Release what the store holds open; every later call is `Unavailable`. */
	close?(): void;
};
