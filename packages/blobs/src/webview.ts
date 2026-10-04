/// <reference lib="dom" />

import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type { BlobSources } from './blob-source.js';
import { BlobStoreError, type Blobs } from './blobs.js';

/** The desktop host path shared by its server and WebView adapter. */
export const LOCAL_BLOB_PATH = '/api/local-blobs';

type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** Construct the stable same-origin media URL for a desktop-local blob. */
export function desktopBlobUrl(id: BlobId): string {
	return `${LOCAL_BLOB_PATH}/${id}`;
}

/**
 * Create the WebView adapter for Epicenter's authenticated local-blob routes.
 * Relative URLs deliberately preserve the active loopback origin and its
 * HttpOnly session cookie.
 */
export function createWebviewBlobs({
	fetch: fetcher = globalThis.fetch,
}: {
	fetch?: HttpFetch;
} = {}): Blobs {
	async function request(id: BlobId, init: RequestInit) {
		return tryAsync({
			try: () =>
				fetcher(desktopBlobUrl(id), {
					...init,
					credentials: 'same-origin',
					redirect: 'error',
				}),
			catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
		});
	}

	return {
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
			if (contentType === null || !Number.isSafeInteger(size) || size < 0) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Local blob HEAD returned invalid metadata.'),
				});
			}
			return Ok({ contentType, size });
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
}

/**
 * Create WebView playback sources over the desktop host's local-blob routes.
 *
 * `open` confirms the host has local bytes (`stat`), then hands out the
 * stable relative loopback URL. Nothing is allocated per acquisition, so the
 * disposer is deliberately a harmless no-op: the shared `BlobSources`
 * contract promises release is always safe, not that every platform revokes
 * something.
 */
export function createWebviewBlobSources(
	blobs: Pick<Blobs, 'stat'>,
): BlobSources {
	return {
		async open(id) {
			const { error } = await blobs.stat(id);
			if (error !== null) return Err(error);
			return Ok({ url: desktopBlobUrl(id), [Symbol.dispose]() {} });
		},
	};
}
