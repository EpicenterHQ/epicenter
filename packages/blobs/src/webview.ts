/// <reference lib="dom" />

import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import { type BlobRemote, BlobRemoteError } from './blob-remote.js';
import type { BlobSources } from './blob-source.js';
import { type BlobStore, BlobStoreError } from './blob-store.js';

/** The desktop host path shared by its server and WebView adapter. */
export const LOCAL_BLOB_PATH = '/api/local-blobs';

type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type WebviewBlobScope =
	| { kind: 'local' }
	| { kind: 'account'; authorityId: string; principalId: string };

function scopeQuery(
	appId: string | undefined,
	scope: WebviewBlobScope | undefined,
) {
	const query = new URLSearchParams();
	if (appId !== undefined) query.set('appId', appId);
	if (scope?.kind === 'account') {
		query.set('authorityId', scope.authorityId);
		query.set('principalId', scope.principalId);
	}
	const text = query.toString();
	return text === '' ? '' : `?${text}`;
}

/** Construct the stable same-origin media URL for a desktop-local blob. */
export function desktopBlobUrl(
	id: BlobId,
	appId?: string,
	scope?: WebviewBlobScope,
): string {
	return `${LOCAL_BLOB_PATH}/${id}${scopeQuery(appId, scope)}`;
}

/**
 * Create the WebView adapter for Epicenter's authenticated local-blob routes.
 * Relative URLs deliberately preserve the active loopback origin and its
 * HttpOnly session cookie.
 */
export function createWebviewBlobStore({
	appId,
	scope,
	fetch: fetcher = globalThis.fetch,
}: {
	appId?: string;
	scope?: WebviewBlobScope;
	fetch?: HttpFetch;
} = {}): BlobStore {
	const query = scopeQuery(appId, scope);
	const copyQuery = scopeQuery(undefined, scope);
	async function request(id: BlobId, init: RequestInit) {
		return tryAsync({
			try: () =>
				fetcher(`${LOCAL_BLOB_PATH}/${id}${query}`, {
					...init,
					credentials: 'same-origin',
					redirect: 'error',
				}),
			catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
		});
	}

	const store: BlobStore = {
		async copy(sourceId, destinationId) {
			if (appId === undefined) {
				return BlobStoreError.BlobStoreFailed({
					id: destinationId,
					cause: new Error('Local blob COPY requires an explicit app id.'),
				});
			}
			const response = await tryAsync({
				try: () =>
					fetcher(
						`/api/apps/${encodeURIComponent(appId)}/blobs/${destinationId}/copy${copyQuery}`,
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ sourceId }),
							credentials: 'same-origin',
							redirect: 'error',
						},
					),
				catch: (cause) =>
					BlobStoreError.BlobStoreFailed({ id: destinationId, cause }),
			});
			if (response.error !== null) return response;
			if (response.data.status === 404)
				return BlobStoreError.BlobNotFound({ id: sourceId });
			if (response.data.status === 409)
				return BlobStoreError.BlobAlreadyExists({ id: destinationId });
			if (!response.data.ok) {
				return BlobStoreError.BlobStoreFailed({
					id: destinationId,
					cause: new Error(`Local blob COPY returned ${response.data.status}.`),
				});
			}
			return Ok(undefined);
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
			if (contentType === null || !Number.isSafeInteger(size) || size < 0) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Local blob HEAD returned invalid metadata.'),
				});
			}
			return Ok({ contentType, size });
		},

		statMany(ids) {
			return Promise.all(ids.map((id) => store.stat(id)));
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
	return store;
}

/**
 * Create the WebView adapter for the desktop host's remote copy operations.
 *
 * Each verb is one same-origin POST that names only the blob id in its path;
 * the request carries no body, destination, or authorization header. The Bun
 * host owns the deployment credential, mints its own presigned operation, and
 * streams bytes between its filesystem store and the remote, so no signed URL
 * or bearer ever reaches this adapter. A 503 means this process generation
 * has no remote capability (signed out); compositions gate on auth state so
 * callers normally never see it.
 */
export function createWebviewBlobRemote({
	appId,
	scope,
	fetch: fetcher = globalThis.fetch,
}: {
	appId?: string;
	scope?: WebviewBlobScope;
	fetch?: HttpFetch;
} = {}): BlobRemote {
	async function operate(
		id: BlobId,
		operation: 'upload' | 'download' | 'purge',
	) {
		const suffix = scopeQuery(appId, scope);
		return tryAsync({
			try: () =>
				fetcher(`${LOCAL_BLOB_PATH}/${id}/${operation}${suffix}`, {
					method: 'POST',
					credentials: 'same-origin',
					redirect: 'error',
				}),
			catch: (cause) => BlobRemoteError.BlobRemoteFailed({ id, cause }),
		});
	}

	function operationFailed(id: BlobId, operation: string, status: number) {
		return BlobRemoteError.BlobRemoteFailed({
			id,
			cause: new Error(`Host blob ${operation} returned ${status}.`),
		});
	}

	return {
		async upload(id) {
			const response = await operate(id, 'upload');
			if (response.error !== null) return Err(response.error);
			if (response.data.status === 404) {
				return BlobStoreError.BlobNotFound({ id });
			}
			if (response.data.status === 500) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Host blob upload failed to read local bytes.'),
				});
			}
			if (!response.data.ok) {
				return operationFailed(id, 'upload', response.data.status);
			}
			return Ok(undefined);
		},

		async download(id) {
			const response = await operate(id, 'download');
			if (response.error !== null) return Err(response.error);
			if (response.data.status === 404) {
				return BlobRemoteError.RemoteBlobNotFound({ id });
			}
			if (response.data.status === 500) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('Host blob download failed to write local bytes.'),
				});
			}
			if (!response.data.ok) {
				return operationFailed(id, 'download', response.data.status);
			}
			return Ok(undefined);
		},

		async purge(id) {
			const response = await operate(id, 'purge');
			if (response.error !== null) return Err(response.error);
			if (!response.data.ok) {
				return operationFailed(id, 'purge', response.data.status);
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
	local: Pick<BlobStore, 'stat'>,
	appId?: string,
	scope?: WebviewBlobScope,
): BlobSources {
	return {
		async open(id) {
			const { error } = await local.stat(id);
			if (error !== null) return Err(error);
			return Ok({
				url: desktopBlobUrl(id, appId, scope),
				[Symbol.dispose]() {},
			});
		},
	};
}
