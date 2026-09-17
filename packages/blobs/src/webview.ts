/// <reference lib="dom" />

import { isAppId } from '@epicenter/constants/app-id';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { type BlobId, parseBlobId } from './blob-id.js';
import { blobListOptions, isBlobMetadata } from './blob-metadata.js';
import type { BlobSources } from './blob-source.js';
import {
	type BlobListPage,
	type BlobStore,
	BlobStoreError,
} from './blob-store.js';

/** Canonical collection paths shared with the desktop host's route mounts. */
export const BLOB_PATHS = { local: '/api/apps/:appId/blobs' } as const;

type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** Capture one app-local namespace on the authenticated desktop origin. */
export function createWebviewBlobs({
	appId,
	fetch: fetcher = globalThis.fetch,
}: {
	appId: string;
	fetch?: HttpFetch;
}): { local: BlobStore; sources: BlobSources } {
	if (typeof appId !== 'string' || !isAppId(appId))
		throw new TypeError('Invalid blob application ID.');
	const prefix = `/api/apps/${encodeURIComponent(appId)}/blobs`;
	const blobUrl = (id: BlobId) => `${prefix}/${id}`;
	async function request(id: BlobId, init: RequestInit) {
		return tryAsync({
			try: () => {
				if (!parseBlobId(id)) throw new TypeError('Invalid complete blob key.');
				return fetcher(blobUrl(id), {
					...init,
					credentials: 'same-origin',
					redirect: 'error',
				});
			},
			catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
		});
	}

	const local: BlobStore = {
		list(options) {
			return tryAsync({
				try: async () => {
					const { cursor, limit } = blobListOptions(options);
					const query = new URLSearchParams({ limit: String(limit) });
					if (cursor !== undefined) query.set('cursor', cursor);
					const response = await fetcher(`${prefix}?${query}`, {
						method: 'GET',
						credentials: 'same-origin',
						redirect: 'error',
					});
					if (!response.ok)
						throw new Error(`Local blob LIST returned ${response.status}.`);
					const page: unknown = await response.json();
					if (
						!page ||
						typeof page !== 'object' ||
						!('items' in page) ||
						!Array.isArray(page.items)
					)
						throw new Error('Local blob LIST returned invalid metadata.');
					const items: BlobListPage['items'] = [];
					let previous = cursor;
					for (const item of page.items) {
						const id = parseBlobId(item?.id);
						if (
							!id ||
							!isBlobMetadata(item) ||
							(previous !== undefined && id <= previous)
						)
							throw new Error('Local blob LIST returned invalid metadata.');
						items.push({ id, size: item.size, contentType: item.contentType });
						previous = id;
					}
					if (items.length > limit)
						throw new Error('Local blob LIST exceeded the page limit.');
					if (
						'nextCursor' in page &&
						(typeof page.nextCursor !== 'string' ||
							page.nextCursor !== items.at(-1)?.id)
					)
						throw new Error('Local blob LIST returned an invalid cursor.');
					return {
						items,
						...('nextCursor' in page
							? { nextCursor: page.nextCursor as string }
							: {}),
					};
				},
				catch: (cause) => BlobStoreError.BlobStoreFailed({ cause }),
			});
		},
		async put(id, blob) {
			const response = await request(id, {
				method: 'PUT',
				headers: blob.type === '' ? undefined : { 'content-type': blob.type },
				body: blob,
			});
			if (response.error !== null) return Err(response.error);
			if (response.data.status === 409) {
				return BlobStoreError.BlobAlreadyExists({ id });
			}
			if (!response.data.ok) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error(`Local blob PUT returned ${response.data.status}.`),
				});
			}
			return Ok(undefined);
		},

		async get(id) {
			const response = await request(id, { method: 'GET' });
			if (response.error !== null) return Err(response.error);
			if (response.data.status === 404) {
				return BlobStoreError.BlobNotFound({ id });
			}
			if (!response.data.ok) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error(`Local blob GET returned ${response.data.status}.`),
				});
			}
			const blob = await tryAsync({
				try: () => response.data.blob(),
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
			if (blob.error !== null) return Err(blob.error);
			return Ok(blob.data);
		},

		async stat(id) {
			const response = await request(id, { method: 'HEAD' });
			if (response.error !== null) return Err(response.error);
			if (response.data.status === 404) {
				return BlobStoreError.BlobNotFound({ id });
			}
			if (!response.data.ok) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error(`Local blob HEAD returned ${response.data.status}.`),
				});
			}
			const contentType = response.data.headers.get('content-type');
			const contentLength = response.data.headers.get('content-length');
			const size = contentLength === null ? Number.NaN : Number(contentLength);
			if (!isBlobMetadata({ contentType, size })) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Local blob HEAD returned invalid metadata.'),
				});
			}

			return Ok({ contentType: contentType!, size });
		},

		async delete(id) {
			const response = await request(id, { method: 'DELETE' });
			if (response.error !== null) return Err(response.error);
			if (!response.data.ok) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error(
						`Local blob DELETE returned ${response.data.status}.`,
					),
				});
			}
			return Ok(undefined);
		},
	};

	const sources: BlobSources = {
		async open(id) {
			const { error } = await local.stat(id);
			if (error !== null) return Err(error);
			return Ok({
				url: blobUrl(id),
				// Stable host URLs allocate nothing per acquisition.
				[Symbol.dispose]() {},
			});
		},
	};
	return { local, sources };
}
