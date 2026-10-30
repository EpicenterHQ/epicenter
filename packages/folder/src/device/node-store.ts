/**
 * A device store over a directory, in Bun: the directory storage the native
 * folder already uses (`native/storage.ts`). Each write is staged beside the
 * directory and renamed over its path, with the version it expects checked
 * under the directory's save lock, the lock the desktop shell takes too, so
 * a file appears whole and never lands over bytes its writer did not see.
 */
import { mkdir } from 'node:fs/promises';
import { ClientError, type Version } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { LockingStorage } from '../boundary.js';
import { sweepStaleScratch } from '../directory-store.js';
import { localRoot, scratchDirectory } from '../native/directory.js';
import { nativeStorage, savingPrimitives } from '../native/storage.js';
import type { DeviceStore } from './store.js';

/**
 * The store of the directory at `path`, made (with its parents) at the
 * first call when `create`. A call that cannot open it is `Unavailable`, and
 * the next one tries again.
 */
export function nodeStore(
	path: string,
	{ create }: { create: boolean },
): DeviceStore {
	let opening:
		| Promise<
				Result<LockingStorage, InferError<typeof ClientError.Unavailable>>
		  >
		| undefined;

	async function open() {
		if (create)
			try {
				await mkdir(path, { recursive: true });
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
		const { data: root, error } = await localRoot(path);
		if (error !== null) return ClientError.Unavailable({ cause: error.cause });
		await sweepStaleScratch(scratchDirectory(root), savingPrimitives(root));
		return Ok(nativeStorage(root));
	}

	function storage() {
		opening ??= open().then((opened) => {
			if (opened.error !== null) opening = undefined;
			return opened;
		});
		return opening;
	}

	return {
		async list() {
			const { data: files, error } = await storage();
			if (error !== null) return { data: null, error };
			const listed = await files.list();
			if (listed.error !== null)
				return ClientError.Unavailable({ cause: listed.error });
			return Ok(listed.data.files.map(({ path, stamp }) => ({ path, stamp })));
		},
		async read(path) {
			const { data: files, error } = await storage();
			if (error !== null) return { data: null, error };
			const read = await files.read(path);
			if (read.error?.name === 'NotFound') return Ok(null);
			if (read.error !== null)
				return ClientError.Unavailable({ cause: read.error });
			const { bytes, sha256, stamp } = read.data;
			return Ok({ bytes, version: sha256 as Version, stamp });
		},
		async write(path, bytes, expected) {
			const { data: files, error } = await storage();
			if (error !== null) return { data: null, error };
			const put = await files.put(
				path,
				bytes,
				expected === 'absent' || expected === 'any'
					? (expected as 'absent' | 'any')
					: { sha256: expected },
			);
			if (put.error !== null)
				return ClientError.Unavailable({ cause: put.error });
			return Ok(put.data.kind);
		},
	};
}
