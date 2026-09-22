import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type {
	BlobAlreadyExists,
	BlobNotFound,
	BlobStore,
	BlobStoreFailed,
} from './blob-store.js';

/** Remote publication is bounded at the client and server; browser copies first acquire one snapshot. */
export const MAX_REMOTE_BLOB_BYTES = 25 * 1024 * 1024;

export const RemoteBlobsError = defineErrors({
	TooLarge: ({ size }: { size: number }) => ({
		message: `Blob size ${size} exceeds the ${MAX_REMOTE_BLOB_BYTES}-byte upload limit.`,
		size,
		maxBytes: MAX_REMOTE_BLOB_BYTES,
	}),
	PublicationUnconfirmed: ({
		destination,
		cause,
	}: {
		destination: {
			namespace: string;
			authorityId: string;
			principalId: string;
		};
		cause: unknown;
	}) => ({
		message: 'Remote blob creation could not be confirmed.',
		destination,
		cause,
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
	copyToLocal(
		id: BlobId,
		appId: string,
		destinationId: BlobId,
		options?: RemoteBlobOptions,
	): Promise<Result<BlobId, RemoteBlobsError | BlobAlreadyExists>>;
	add(
		blob: Blob,
		options?: RemoteBlobOptions,
	): Promise<Result<BlobId, RemoteBlobsError>>;
	copyFromLocal(
		source: { local: Pick<BlobStore, 'get'>; nativeAppId?: string },
		id: BlobId,
		options?: RemoteBlobOptions,
	): Promise<Result<BlobId, RemoteBlobsError | BlobNotFound | BlobStoreFailed>>;
	get(
		id: BlobId,
		options?: RemoteBlobOptions,
	): Promise<Result<Blob, RemoteBlobsError>>;
	open(
		id: BlobId,
		options?: RemoteBlobOptions,
	): Promise<
		Result<Disposable & AsyncDisposable & { url: string }, RemoteBlobsError>
	>;
	delete(
		id: BlobId,
		options?: RemoteBlobOptions,
	): Promise<Result<void, RemoteBlobsError>>;
};

/** Owner-pinned authenticated routes. These URLs are locators, not bearer grants. */
export const REMOTE_BLOB_ROUTES = {
	collection: '/api/apps/:appId/principals/:principalId/blobs',
	collectionUrl(baseURL: string, appId: string, principalId: string) {
		return `${baseURL.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(appId)}/principals/${encodeURIComponent(principalId)}/blobs`;
	},
	object: '/api/apps/:appId/principals/:principalId/blobs/:blobId',
	objectUrl(
		baseURL: string,
		appId: string,
		principalId: string,
		blobId: BlobId,
	) {
		return `${baseURL.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(appId)}/principals/${encodeURIComponent(principalId)}/blobs/${blobId}`;
	},
};
