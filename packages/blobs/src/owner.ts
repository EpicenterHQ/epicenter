import { Err, Ok } from 'wellcrafted/result';
import { blobInputContentType, selectBlobFormat } from './blob-format.js';
import { BlobStoreError } from './blob-store.js';
import {
	type BlobId,
	type BlobSource,
	type BlobSources,
	type BlobStore,
	generateBlobId,
} from './index.js';

/** Own public blob operations and playback; raw bytes remain available to dependent producers. */
export function createLocalBlobAccess({
	local,
	sources,
	assertUsable,
}: {
	local: BlobStore;
	sources: BlobSources;
	assertUsable?: () => void;
}) {
	let closed = false;
	let closing: Promise<void> | undefined;
	const operations = new Set<Promise<unknown>>();
	const playback = new Set<BlobSource>();
	const cleanupFailures: unknown[] = [];
	function assertOpen() {
		assertUsable?.();
		if (closed) throw new Error('Blob access is closed.');
	}
	function run<T>(operation: () => Promise<T>): Promise<T> {
		assertOpen();
		const pending = Promise.resolve().then(operation);
		operations.add(pending);
		void pending.then(
			() => operations.delete(pending),
			() => operations.delete(pending),
		);
		return pending;
	}
	function release(source: BlobSource) {
		try {
			source[Symbol.dispose]();
		} catch (cause) {
			cleanupFailures.push(cause);
			throw cause;
		}
	}
	return Object.freeze({
		value: Object.freeze({
			add(blob: Blob, options?: { signal?: AbortSignal }) {
				return run(async () => {
					options?.signal?.throwIfAborted();
					const id = generateBlobId(selectBlobFormat(blob).extension);
					const contentType = blobInputContentType(blob);
					const input =
						blob.type === contentType
							? blob
							: blob.slice(0, blob.size, contentType);
					try {
						const result = await local.put(id, input);
						return result.error === null
							? Ok(id)
							: Err({ ...result.error, id });
					} catch (cause) {
						return Err({
							...BlobStoreError.BlobStoreFailed({ id, cause }).error,
							id,
						});
					}
				});
			},
			get: (id: BlobId) => run(() => local.get(id)),
			stat: (id: BlobId) => run(() => local.stat(id)),
			list: (options?: Parameters<BlobStore['list']>[0]) =>
				run(() => local.list(options)),
			open(id: BlobId) {
				return run(async () => {
					const result = await sources.open(id);
					if (result.error !== null) return result;
					const source = result.data;
					try {
						assertOpen();
					} catch (cause) {
						release(source);
						throw cause;
					}
					playback.add(source);
					return Ok(
						Object.freeze({
							url: source.url,
							[Symbol.dispose]() {
								if (playback.delete(source)) release(source);
							},
						}),
					);
				});
			},
			delete: (id: BlobId) => run(() => local.delete(id)),
		}),
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			void (async () => {
				await Promise.allSettled(operations);
				const held = [...playback];
				playback.clear();
				await Promise.allSettled(held.map(async (source) => release(source)));
				if (cleanupFailures.length)
					throw new AggregateError(
						cleanupFailures,
						'Playback source cleanup failed.',
					);
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	});
}
