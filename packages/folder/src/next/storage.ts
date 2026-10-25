/**
 * What a folder needs from its host: a listing with a cheap change token per
 * file, batched reads that carry each file's content version, a put that lands
 * only while the path holds what it expects, and path hints.
 *
 * `version` identifies content and guards conditional saves (a SHA-256 on
 * disk, a blob oid in the browser). `token` is the cheap stat a listing can
 * compare without reading (mtime and size where the host has them). Hints
 * carry no data: they only make the folder look again.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from '../boundary.js';
import { hashBytes } from '../hash.js';
import type { FolderWatch } from '../native/watch.js';
import { ReadError, SaveError } from '../shared/errors.js';

export type Listed = { readonly token: string };

/** A read: the file's bytes and identity, or `null` when no file is there. */
export type Fetched = {
	readonly bytes: Uint8Array;
	readonly version: string;
	readonly token: string;
} | null;

/** What a put expects at its path: no file, anything, or exact content. */
export type Expected = 'absent' | 'any' | { readonly version: string };

/** What landed: the new file's identity, or `null` for a removal. */
export type Landed = {
	readonly version: string;
	readonly token: string;
} | null;

export type FolderHost = {
	list(): Promise<Result<ReadonlyMap<string, Listed>, ReadError>>;
	read(
		paths: readonly string[],
	): Promise<ReadonlyMap<string, Result<Fetched, ReadError>>>;
	put(
		path: string,
		bytes: Uint8Array | null,
		expected: Expected,
	): Promise<Result<{ landed: Landed } | 'stale', SaveError>>;
	/** Paths that may have changed, or `null` when the scope is unknown. */
	hints?(listener: (paths: readonly string[] | null) => void): () => void;
	close?(): void;
};

/**
 * A host over the directory storage contract, until the shell answers
 * listings with change tokens and reads in batches. Its listing has sizes
 * only, so the token is the size: a same-size rewrite is caught by a hint
 * naming the path (always reread) or by a conditional save, not by a
 * checkpoint. Reads run with bounded parallelism, and a landed put hashes its
 * bytes here.
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
					data.files.map(({ path, size }) => [path, { token: `${size}` }]),
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
								token: `${data.bytes.length}`,
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
		async put(path, bytes, expected) {
			const { data, error } = await storage.put(
				path,
				bytes,
				typeof expected === 'string' ? expected : { sha256: expected.version },
			);
			if (error !== null) {
				if (error.name === 'InvalidPath')
					return SaveError.InvalidPath({ path });
				return SaveError.StorageFailed({ cause: error });
			}
			if (data === 'stale') return Ok('stale');
			if (bytes === null) return Ok({ landed: null });
			return Ok({
				landed: { version: await hashBytes(bytes), token: `${bytes.length}` },
			});
		},
		hints: watch,
	};
}
