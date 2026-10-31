/**
 * The folder host lists cheap change stamps, reads file bytes, and lands
 * puts with optional content expectations. Hints prompt another look.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { hashBytes } from './hash.js';
import type { FolderWatch } from './native/watch.js';
import { ReadError, SaveError } from './shared/errors.js';

export type Listed = { readonly stamp: string };

/** A read: the file's bytes and listing stamp, or `null` when absent. */
export type Fetched = {
	readonly bytes: Uint8Array;
	readonly stamp: string;
} | null;

/** What landed: the new file's listing stamp, or `null` for a removal. */
export type Landed = {
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
		expect?: 'absent' | Uint8Array,
	): Promise<Result<Landed, SaveError>>;
	/** Paths that may have changed, or `null` when the scope is unknown. */
	hints?(listener: (paths: readonly string[] | null) => void): () => void;
	close?(): void;
};

/**
 * Adapt directory storage. Native stamps describe the version each operation
 * observed, while byte hashes remain the expectation for checked writes.
 */
export function storageHost(
	storage: FolderStorage,
	{ watch, parallel = 8 }: { watch?: FolderWatch; parallel?: number } = {},
): FolderHost {
	return {
		async list() {
			const { data, error } = await storage.list();
			if (error !== null) return ReadError.StorageFailed({ cause: error });
			return Ok(new Map(data.map(({ path, stamp }) => [path, { stamp }])));
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
								stamp: data.stamp,
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
		async put(path, bytes, expect) {
			const expected =
				expect === undefined
					? 'any'
					: expect === 'absent'
						? expect
						: { sha256: await hashBytes(expect) };
			const { data, error } = await storage.put(path, bytes, expected);
			if (error !== null) {
				if (error.name === 'InvalidPath')
					return SaveError.InvalidPath({ path });
				return SaveError.StorageFailed({ cause: error });
			}
			if (data.kind === 'stale') return SaveError.Changed({ path });
			if (bytes === null) return Ok(null);
			if (data.stamp === null)
				return SaveError.StorageFailed({
					cause: new Error('A landed file has no stamp'),
				});
			return Ok({ stamp: data.stamp });
		},
		hints: watch,
	};
}
