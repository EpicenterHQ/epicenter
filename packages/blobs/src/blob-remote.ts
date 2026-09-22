import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type { BlobNotFound, BlobStoreFailed, BlobStore } from './blob-store.js';

/** Direct uploads are bounded before reading local bytes and at the server. */
export const MAX_REMOTE_BLOB_BYTES = 25 * 1024 * 1024;

export const RemoteBlobsError = defineErrors({
	TooLarge: ({ size }: { size: number }) => ({
		message: `Blob size ${size} exceeds the ${MAX_REMOTE_BLOB_BYTES}-byte upload limit.`,
		size,
		maxBytes: MAX_REMOTE_BLOB_BYTES,
	}),
	InvalidUrl: ({ url }: { url: string }) => ({
		message: 'The blob URL does not belong to this application account.',
		url,
	}),
	Failed: ({ cause, status }: { cause: unknown; status?: number }) => ({
		message: `Remote blob operation failed: ${extractErrorMessage(cause)}`,
		cause,
		status,
	}),
});
export type RemoteBlobsError = InferErrors<typeof RemoteBlobsError>;
export type RemoteBlobOptions = { signal?: AbortSignal };

/** One account's immutable remote objects; URLs never select a new account. */
export type RemoteBlobs = {
	add(
		blob: Blob,
		options?: RemoteBlobOptions,
	): Promise<Result<string, RemoteBlobsError>>;
	addFrom(
		source: { local: Pick<BlobStore, 'get' | 'stat'>; nativeAppId?: string },
		id: BlobId,
		options?: RemoteBlobOptions,
	): Promise<Result<string, RemoteBlobsError | BlobNotFound | BlobStoreFailed>>;
	get(
		url: string,
		options?: RemoteBlobOptions,
	): Promise<Result<Blob, RemoteBlobsError>>;
	open(
		url: string,
		options?: RemoteBlobOptions,
	): Promise<Result<Disposable & { url: string }, RemoteBlobsError>>;
	delete(
		url: string,
		options?: RemoteBlobOptions,
	): Promise<Result<void, RemoteBlobsError>>;
};

/** Owner-pinned authenticated routes. These URLs are locators, not bearer grants. */
export const REMOTE_BLOB_ROUTES = {
	collection: '/api/apps/:appId/blobs',
	object: '/api/apps/:appId/principals/:principalId/blobs/:blobId',
	collectionUrl(baseURL: string, appId: string) {
		return `${baseURL.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(appId)}/blobs`;
	},
	objectUrl(
		baseURL: string,
		appId: string,
		principalId: string,
		blobId: BlobId,
	) {
		return `${baseURL.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(appId)}/principals/${encodeURIComponent(principalId)}/blobs/${blobId}`;
	},
};
