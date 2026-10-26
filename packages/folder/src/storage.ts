/**
 * The folder host lists cheap change stamps, reads file bytes and content
 * versions, and lands unconditional puts. Hints prompt another look.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { hashBytes } from './hash.js';
import type { FolderWatch } from './native/watch.js';
import { ReadError, SaveError } from './shared/errors.js';

export type Listed = { readonly stamp: string };

/** A read: the file's bytes and identity, or `null` when no file is there. */
export type Fetched = {
	readonly bytes: Uint8Array;
	readonly version: string;
	readonly stamp: string;
} | null;

/** What landed: the new file's identity, or `null` for a removal. */
export type Landed = {
	readonly version: string;
	readonly stamp: string;
} | null;

export type FolderHost = {
	list(): Promise<Result<ReadonlyMap<string, Listed>, ReadError>>;
	read(
		paths: readonly string[],
	): Promise<ReadonlyMap<string, Result<Fetched, ReadError>>>;
	put(
		path: string,
		bytes: Uint8Array | null,
	): Promise<Result<Landed, SaveError>>;
	/** Paths that may have changed, or `null` when the scope is unknown. */
	hints?(listener: (paths: readonly string[] | null) => void): () => void;
	close?(): void;
};

/**
 * Adapt directory storage. Its listing stamp is only the file size, so a
 * same-size outside edit needs a named hint to trigger a read. A put hashes
 * its landed bytes here.
 */
export function storageHost(
	storage: FolderStorage,
	{ watch, parallel = 8 }: { watch?: FolderWatch; parallel?: number } = {},
): FolderHost {
	return {
		async list() {
			const { data, error } = await storage.list();
			if (error !== null) return ReadError.StorageFailed({ cause: error });
			return Ok(
				new Map(
					data.files.map(({ path, size }) => [path, { stamp: `${size}` }]),
				),
			);
		},
		async read(paths) {
			const results = new Map<string, Result<Fetched, ReadError>>();
			let next = 0;
			const worker = async () => {
				for (;;) {
					const path = paths[next++];
					if (path === undefined) return;
					const { data, error } = await storage.read(path);
					if (error === null)
						results.set(
							path,
							Ok({
								bytes: data.bytes,
								version: data.sha256,
								stamp: `${data.bytes.length}`,
							}),
						);
					else if (error.name === 'NotFound') results.set(path, Ok(null));
					else results.set(path, ReadError.StorageFailed({ cause: error }));
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(parallel, paths.length) }, worker),
			);
			return results;
		},
		async put(path, bytes) {
			const { data, error } = await storage.put(path, bytes, 'any');
			if (error !== null) {
				if (error.name === 'InvalidPath')
					return SaveError.InvalidPath({ path });
				return SaveError.StorageFailed({ cause: error });
			}
			if (data === 'stale')
				return SaveError.StorageFailed({
					cause: 'Unconditional put was stale',
				});
			if (bytes === null) return Ok(null);
			return Ok({ version: await hashBytes(bytes), stamp: `${bytes.length}` });
		},
		hints: watch,
	};
}
