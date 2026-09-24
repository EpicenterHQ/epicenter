import {
	type BlobAlreadyExists,
	type BlobId,
	type BlobSources,
	type BlobStoreError as BlobStorageError,
	type BlobStore,
	BlobStoreError,
	type BlobStoreFailed,
	blobKeyFormat,
	generateBlobId,
} from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createLocalBlobAccess } from '@epicenter/blobs/owner';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { isAppId } from '@epicenter/constants/app-id';
import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { blobDestinations } from './blob-destination.js';
import type { RecordingFactory } from './recorder.js';
import { createBrowserRecording } from './recording/browser.js';
import { createDesktopRecording } from './recording/desktop.js';

/** A supplied test binding is complete and never selects native storage. */
export type LocalBlobBinding = {
	local: BlobStore;
	sources: BlobSources;
	recording: RecordingFactory;
};

export async function acquireLocalBlobs({
	id,
	binding,
	assertUsable,
}: {
	id: string;
	binding?: LocalBlobBinding;
	assertUsable: () => void;
}) {
	if (!isAppId(id)) throw new TypeError('Invalid blob namespace ID.');
	const native = binding === undefined && isTauri();
	const bytes =
		binding ??
		(native
			? createWebviewBlobs({ appId: id })
			: (() => {
					const local = createBrowserBlobStore({
						appId: id,
						idb: {
							factory: globalThis.indexedDB,
							keyRange: globalThis.IDBKeyRange,
						},
					});
					return { local, sources: createBrowserBlobSources(local) };
				})());
	const ready = await bytes.local.list({ limit: 1 });
	if (ready.error) return ready;
	const lifetime = new AbortController();
	const assertOpen = () => {
		assertUsable();
		lifetime.signal.throwIfAborted();
	};
	const access = createLocalBlobAccess({ ...bytes, assertUsable: assertOpen });
	const recorders = new Set<{ close(): Promise<void> }>();
	const transfers = new Set<Promise<unknown>>();
	const cleanupFailures: unknown[] = [];
	let closing: Promise<void> | undefined;
	const value: LocalBlobs = Object.freeze({
		[localBrand]: true as const,
		...access.value,
		add(blob: Blob, options?: { signal?: AbortSignal }) {
			return access.value.add(blob, options).then((result) => {
				if (native && result.error && result.error.name !== 'BlobAlreadyExists')
					cleanupFailures.push(result.error);
				return result.error
					? Err({
							...result.error,
							destination: { namespace: id, kind: 'local' as const },
						})
					: result;
			});
		},
		copyFrom(
			source: LocalBlobs,
			blobId: BlobId,
			options?: { signal?: AbortSignal },
		): Promise<Result<BlobId, BlobStorageError>> {
			assertOpen();
			const origin = blobDestinations.get(source);
			if (!origin) throw new TypeError('Expected a store-owned blob source.');
			origin.assertOpen();
			const destinationId = generateBlobId(blobKeyFormat(blobId).extension);
			const signal = AbortSignal.any([
				lifetime.signal,
				origin.signal,
				...(options?.signal ? [options.signal] : []),
			]);
			const nativeDispatched = native || origin.native;
			const transfer = Promise.resolve().then(async () => {
				try {
					signal.throwIfAborted();
					if (native && origin.native) {
						const response = await fetch(
							`/api/apps/${encodeURIComponent(id)}/blobs/${destinationId}?owner=no-account`,
							{
								method: 'PUT',
								headers: {
									'x-epicenter-copy-source-app': origin.id,
									'x-epicenter-copy-source-id': blobId,
								},
								credentials: 'same-origin',
								redirect: 'error',
								signal,
							},
						);
						await response.body?.cancel();
						if (response.status === 409)
							return BlobStoreError.BlobAlreadyExists({ id: destinationId });
						if (!response.ok)
							return BlobStoreError.PublicationUnconfirmed({
								id: destinationId,
								namespace: id,
								cause: `Native copy returned ${response.status}`,
							});
						return Ok(destinationId);
					}
					// A custom source still publishes through the native destination.
					const snapshot = await origin.store.get(blobId);
					if (snapshot.error) return snapshot;
					signal.throwIfAborted();
					const result = await bytes.local.put(destinationId, snapshot.data);
					if (!result.error) return Ok(destinationId);
					if (result.error.name === 'BlobAlreadyExists') return result;
					return BlobStoreError.PublicationUnconfirmed({
						id: destinationId,
						namespace: id,
						cause: result.error,
					});
				} catch (cause) {
					return BlobStoreError.PublicationUnconfirmed({
						id: destinationId,
						namespace: id,
						cause,
					});
				}
			});
			transfers.add(transfer);
			origin.transfers.add(transfer);
			const settled = () => {
				transfers.delete(transfer);
				origin.transfers.delete(transfer);
			};
			void transfer.then((result) => {
				if (
					nativeDispatched &&
					result.error &&
					result.error.name !== 'BlobAlreadyExists'
				) {
					// A lost native acknowledgment cannot prove that host cleanup finished.
					cleanupFailures.push(result.error);
					origin.cleanupFailures.push(result.error);
				}
				settled();
			}, settled);
			return transfer;
		},
	});
	const handle = Object.freeze({
		value,
		signal: lifetime.signal,
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			lifetime.abort();
			// Invoke all dependent closes immediately, before awaiting any one producer.
			const producers = [...recorders].map(async (recorder) =>
				recorder.close(),
			);
			void (async () => {
				const cleanup = Promise.allSettled([...producers, access.close()]);
				await Promise.allSettled(transfers);
				const results = await cleanup;
				const failures = [
					...cleanupFailures,
					...results.flatMap((result) =>
						result.status === 'rejected' ? [result.reason] : [],
					),
				];
				if (failures.length)
					throw new AggregateError(failures, 'Local blob cleanup failed.');
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	});
	blobDestinations.set(value, {
		id,
		signal: lifetime.signal,
		native,
		store: bytes.local,
		recording:
			binding?.recording ??
			(native ? createDesktopRecording : createBrowserRecording),
		assertOpen,
		recorders,
		transfers,
		cleanupFailures,
	});
	return Ok(handle);
}
const localBrand = Symbol('LocalBlobs');
type LocalReadAccess = Pick<
	ReturnType<typeof createLocalBlobAccess>['value'],
	'get' | 'stat' | 'list' | 'open' | 'delete'
>;
export type LocalBlobs = LocalReadAccess & {
	readonly [localBrand]: true;
	add(
		blob: Blob,
		options?: { signal?: AbortSignal },
	): Promise<
		Result<
			BlobId,
			(BlobAlreadyExists | BlobStoreFailed) & {
				id: BlobId;
				destination: { kind: 'local'; namespace: string };
			}
		>
	>;
	copyFrom(
		source: LocalBlobs,
		id: BlobId,
		options?: { signal?: AbortSignal },
	): Promise<Result<BlobId, BlobStorageError>>;
};
