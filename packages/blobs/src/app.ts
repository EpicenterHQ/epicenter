import {
	generateBlobId,
	BlobRemoteError,
	type BlobId,
	type BlobStore,
	type BlobSources,
	type BlobRemote,
	type BlobSource,
} from './index.js';
import { Ok } from 'wellcrafted/result';

/** Own public blob operations and playback; raw bytes remain available to dependent producers. */
export function createAppBlobs({
	local,
	sources,
	remote,
	assertUsable,
}: {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote | null;
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
			remote: Object.freeze({
				upload: (id: BlobId) =>
					run(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.upload(id),
					),
				download: (id: BlobId) =>
					run(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.download(id),
					),
				purge: (id: BlobId) =>
					run(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.purge(id),
					),
			}),
			add(blob: Blob) {
				return run(async () => {
					const id = generateBlobId();
					const result = await local.put(id, blob);
					return result.error === null ? Ok(id) : result;
				});
			},
			get: (id: BlobId) => run(() => local.get(id)),
			stat: (id: BlobId) => run(() => local.stat(id)),
			statMany: (ids: readonly BlobId[]) => run(() => local.statMany(ids)),
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
			removeLocal: (id: BlobId) => run(() => local.delete(id)),
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
