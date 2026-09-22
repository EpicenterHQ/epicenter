import type { Account } from '@epicenter/auth';
import type { BlobId, BlobStore, BlobSources } from '@epicenter/blobs';
import {
	createLocalBlobAccess,
	createRemoteBlobAccess,
} from '@epicenter/blobs/owner';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { createRemoteBlobClient } from '@epicenter/client';
import { isAppId } from '@epicenter/constants/app-id';
import { isTauri } from '@tauri-apps/api/core';
import { blobDestination, blobDestinations } from './blob-destination.js';
import { createBrowserRecording } from './recording/browser.js';
import { createDesktopRecording } from './recording/desktop.js';
import type { RecordingFactory } from './recorder.js';

/** A supplied test binding is complete and never selects native storage. */
export type LocalBlobBinding = {
	local: BlobStore;
	sources: BlobSources;
	recording: RecordingFactory;
};

export async function openLocalBlobs({
	id,
	binding,
}: {
	id: string;
	binding?: LocalBlobBinding;
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
	const lifetime = new AbortController();
	const assertOpen = () => lifetime.signal.throwIfAborted();
	const access = createLocalBlobAccess({ ...bytes, assertUsable: assertOpen });
	const recorders = new Set<{ close(): Promise<void> }>();
	const transfers = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	const handle = Object.freeze({
		...access.value,
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
				const failures = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				);
				if (failures.length)
					throw new AggregateError(failures, 'Local blob cleanup failed.');
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	});
	blobDestinations.set(handle, {
		id,
		native,
		store: bytes.local,
		recording:
			binding?.recording ??
			(native ? createDesktopRecording : createBrowserRecording),
		assertOpen,
		recorders,
		transfers,
	});
	return handle;
}
export type LocalBlobs = Awaited<ReturnType<typeof openLocalBlobs>>;

export async function openRemoteBlobs({
	id,
	account,
}: {
	id: string;
	account: Account;
}) {
	const remote = createRemoteBlobClient({ appId: id, account });
	const access = createRemoteBlobAccess({ remote });
	return Object.freeze({
		...access.value,
		signal: access.signal,
		close: access.close,
		addFrom(local: LocalBlobs, id: BlobId, options?: { signal?: AbortSignal }) {
			const source = blobDestination(local);
			const signal = AbortSignal.any([
				local.signal,
				access.signal,
				...(options?.signal ? [options.signal] : []),
			]);
			const transfer = access.value.addFrom(
				{
					local: source.store,
					nativeAppId: source.native ? source.id : undefined,
				},
				id,
				{ signal },
			);
			source.transfers.add(transfer);
			void transfer.then(
				() => source.transfers.delete(transfer),
				() => source.transfers.delete(transfer),
			);
			return transfer;
		},
	});
}
export type RemoteBlobs = Awaited<ReturnType<typeof openRemoteBlobs>>;
