import { Ok } from 'wellcrafted/result';
import { blobInputContentType, selectBlobFormat } from './blob-format.js';
import {
	type BlobId,
	type BlobSource,
	type BlobSources,
	type BlobStore,
	generateBlobId,
	type RemoteBlobs,
	RemoteBlobsError,
} from './index.js';

/** Own public blob operations and playback; raw bytes remain available to dependent producers. */
export function createAppBlobs({
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
			add(blob: Blob) {
				return run(async () => {
					const id = generateBlobId(selectBlobFormat(blob).extension);
					const contentType = blobInputContentType(blob);
					const input =
						blob.type === contentType
							? blob
							: blob.slice(0, blob.size, contentType);
					const result = await local.put(id, input);
					return result.error === null ? Ok(id) : result;
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

/** App-owned network admission and display resources over a captured account. */
export function createAppRemoteBlobs({
	remote,
	assertUsable,
}: {
	remote: RemoteBlobs;
	assertUsable?: () => void;
}) {
	const lifetime = new AbortController();
	const operations = new Set<Promise<unknown>>();
	const playback = new Set<BlobSource>();
	const cleanupFailures: unknown[] = [];
	let closing: Promise<void> | undefined;
	function release(source: BlobSource) {
		try {
			source[Symbol.dispose]();
		} catch (cause) {
			cleanupFailures.push(cause);
			throw cause;
		}
	}
	function run<T>(
		signal: AbortSignal | undefined,
		operation: (signal: AbortSignal) => Promise<T>,
	) {
		assertUsable?.();
		if (lifetime.signal.aborted) throw new Error('Blob access is closed.');
		const combined = signal
			? AbortSignal.any([signal, lifetime.signal])
			: lifetime.signal;
		const pending = Promise.resolve().then(() => operation(combined));
		operations.add(pending);
		void pending.then(
			() => operations.delete(pending),
			() => operations.delete(pending),
		);
		return pending;
	}
	return Object.freeze({
		value: Object.freeze({
			add(blob: Blob, options?: { signal?: AbortSignal }) {
				return run(options?.signal, (signal) => remote.add(blob, { signal }));
			},
			addLocal(id: BlobId, options?: { signal?: AbortSignal }) {
				return run(options?.signal, (signal) =>
					remote.addLocal(id, { signal }),
				);
			},
			get(url: string, options?: { signal?: AbortSignal }) {
				return run(options?.signal, (signal) => remote.get(url, { signal }));
			},
			open(url: string, options?: { signal?: AbortSignal }) {
				return run(options?.signal, async (signal) => {
					const result = await remote.open(url, { signal });
					if (result.error) return result;
					const source = result.data;
					if (signal.aborted) {
						release(source);
						return RemoteBlobsError.Failed({ cause: signal.reason });
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
			delete(url: string, options?: { signal?: AbortSignal }) {
				return run(options?.signal, (signal) => remote.delete(url, { signal }));
			},
		} satisfies RemoteBlobs),
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			lifetime.abort();
			void (async () => {
				await Promise.allSettled(operations);
				const held = [...playback];
				playback.clear();
				await Promise.allSettled(held.map(async (source) => release(source)));
				if (cleanupFailures.length)
					throw new AggregateError(
						cleanupFailures,
						'Blob playback cleanup failed.',
					);
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	});
}
