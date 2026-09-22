import type { Account } from '@epicenter/auth';
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
	type RemoteBlobsError as RemoteError,
} from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createLocalBlobAccess,
	createRemoteBlobAccess,
} from '@epicenter/blobs/owner';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { createRemoteBlobClient } from '@epicenter/client';
import { isAppId } from '@epicenter/constants/app-id';
import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { blobDestination, blobDestinations } from './blob-destination.js';
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
			source: LocalBlobs | PersonalBlobs,
			blobId: BlobId,
			options?: { signal?: AbortSignal },
		): Promise<Result<BlobId, BlobStorageError | RemoteError>> {
			assertOpen();
			const localSource = blobDestinations.get(source);
			const personalSource = personalSources.get(source);
			if (!localSource && !personalSource)
				throw new TypeError('Expected a store-owned blob source.');
			const origin = localSource ?? personalSource!;
			origin.assertOpen();
			const destinationId = generateBlobId(blobKeyFormat(blobId).extension);
			const signal = AbortSignal.any([
				lifetime.signal,
				origin.signal,
				...(options?.signal ? [options.signal] : []),
			]);
			let nativeDispatched = false;
			const transfer = Promise.resolve().then(async () => {
				try {
					signal.throwIfAborted();
					if (native && personalSource) {
						nativeDispatched = true;
						const copied = await personalSource.copyToLocal(
							blobId,
							id,
							destinationId,
							{
								signal,
							},
						);
						if (copied.error?.name === 'BlobAlreadyExists') return copied;
						return copied.error
							? BlobStoreError.PublicationUnconfirmed({
									id: destinationId,
									namespace: id,
									cause: copied.error,
								})
							: copied;
					}
					if (native && localSource?.native) {
						nativeDispatched = true;
						const response = await fetch(
							`/api/apps/${encodeURIComponent(id)}/blobs/${destinationId}?owner=no-account`,
							{
								method: 'PUT',
								headers: {
									'x-epicenter-copy-source-app': localSource.id,
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
					// A custom source still publishes through the native destination;
					// a native source can also own an unfinished host read.
					nativeDispatched = native || localSource?.native === true;
					const snapshot = await (localSource
						? localSource.store.get(blobId)
						: personalSource!.get(blobId, { signal }));
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
const personalBrand = Symbol('PersonalBlobs');
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
		source: LocalBlobs | PersonalBlobs,
		id: BlobId,
		options?: { signal?: AbortSignal },
	): Promise<Result<BlobId, BlobStorageError | RemoteError>>;
};
export type PersonalBlobs = Pick<
	ReturnType<typeof createRemoteBlobAccess>['value'],
	'get' | 'open' | 'delete'
> & {
	readonly [personalBrand]: true;
	add(
		blob: Blob,
		options?: { signal?: AbortSignal },
	): Promise<Result<BlobId, RemoteError>>;
	copyFrom(
		source: LocalBlobs,
		id: BlobId,
		options?: { signal?: AbortSignal },
	): Promise<Result<BlobId, BlobStorageError | RemoteError>>;
};

const personalSources = new WeakMap<
	object,
	{
		signal: AbortSignal;
		assertOpen(): void;
		transfers: Set<Promise<unknown>>;
		cleanupFailures: unknown[];
		get: ReturnType<typeof createRemoteBlobAccess>['value']['get'];
		copyToLocal: ReturnType<
			typeof createRemoteBlobAccess
		>['value']['copyToLocal'];
	}
>();

/** Captured Personal transport; the store owns its admission and cleanup. */
export async function acquireRemoteBlobs({
	id,
	account,
	assertUsable,
}: {
	id: string;
	account: Account;
	assertUsable: () => void;
}) {
	const remote = createRemoteBlobClient({ appId: id, account });
	const access = createRemoteBlobAccess({ remote, assertUsable });
	const transfers = new Set<Promise<unknown>>();
	const cleanupFailures: unknown[] = [];
	const value: PersonalBlobs = Object.freeze({
		[personalBrand]: true as const,
		get: access.value.get,
		open: access.value.open,
		delete: access.value.delete,
		add: access.value.add,
		copyFrom(
			localBlobs: LocalBlobs,
			blobId: BlobId,
			options?: { signal?: AbortSignal },
		) {
			const source = blobDestination(localBlobs);
			const signal = AbortSignal.any([
				source.signal,
				access.signal,
				...(options?.signal ? [options.signal] : []),
			]);
			const transfer = access.value.copyFromLocal(
				{
					local: source.store,
					nativeAppId: source.native ? source.id : undefined,
				},
				blobId,
				{ signal },
			);
			source.transfers.add(transfer);
			void transfer.then(
				(result) => {
					if (
						source.native &&
						result.error?.name === 'PublicationUnconfirmed'
					) {
						cleanupFailures.push(result.error);
						source.cleanupFailures.push(result.error);
					}
					source.transfers.delete(transfer);
				},
				(cause) => {
					if (source.native) {
						cleanupFailures.push(cause);
						source.cleanupFailures.push(cause);
					}
					source.transfers.delete(transfer);
				},
			);
			return transfer;
		},
	});
	personalSources.set(value, {
		signal: access.signal,
		assertOpen() {
			assertUsable();
			access.signal.throwIfAborted();
		},
		transfers,
		cleanupFailures,
		get: access.value.get,
		copyToLocal: access.value.copyToLocal,
	});
	let closing: Promise<void> | undefined;
	return Object.freeze({
		value,
		signal: access.signal,
		close() {
			if (closing) return closing;
			const closed = access.close();
			closing = (async () => {
				const [result] = await Promise.all([
					Promise.allSettled([closed]),
					Promise.allSettled(transfers),
				]);
				if (result[0]!.status === 'rejected')
					cleanupFailures.push(result[0]!.reason);
				if (cleanupFailures.length)
					throw new AggregateError(
						cleanupFailures,
						'Personal blob cleanup failed.',
					);
			})();
			return closing;
		},
	});
}
