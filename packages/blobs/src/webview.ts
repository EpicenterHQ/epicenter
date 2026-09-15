/// <reference lib="dom" />

import { isAppId } from '@epicenter/constants/app-id';
import {
	captureLibraryReplica,
	type LibraryReplicaIdentity,
} from '@epicenter/principal';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import { type BlobRemote, BlobRemoteError } from './blob-remote.js';
import type { BlobSources } from './blob-source.js';
import {
	type BlobStore,
	BlobStoreError,
	AttachmentTransferError,
	type AttachmentContent,
	type BlobStat,
} from './blob-store.js';

/** Canonical collection paths shared with the desktop host's route mounts. */
export const BLOB_PATHS = {
	local: '/api/apps/:appId/local/blobs',
	account: '/api/apps/:appId/accounts/:authorityId/:principalId/blobs',
	shared: '/api/apps/:appId/accounts/:authorityId/:principalId/shared/blobs',
} as const;

type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function encodeIdentitySegment(value: unknown, label: string): string {
	if (
		typeof value !== 'string' ||
		value === '' ||
		value === '.' ||
		value === '..' ||
		/[\\/\p{Cc}]/u.test(value)
	) {
		throw new TypeError(
			`Invalid blob account ${label}: expected one path segment.`,
		);
	}
	return encodeURIComponent(value);
}

/**
 * Capture one app's library replica before any asynchronous work.
 * Invalid addressing throws at construction.
 * Relative URLs preserve the loopback origin and its HttpOnly session cookie.
 * The host owns remote credentials and byte transfer. A local partition has no
 * remote backing; the document store constructs its guarded public remote.
 */
export function createWebviewBlobs({
	appId,
	replica: input,
	remote: selectedRemote,
	fetch: fetcher = globalThis.fetch,
	publishNative,
	nativeTransfer,
}: {
	appId: string;
	replica: LibraryReplicaIdentity;
	remote: { baseURL: string; fetch: HttpFetch } | null;
	fetch?: HttpFetch;
	nativeTransfer(
		direction: 'upload' | 'download',
		id: BlobId,
		expected: AttachmentContent,
		ticket: { url: string; requiredHeaders?: Record<string, string> },
		signal: AbortSignal,
	): Promise<void>;
	publishNative?(
		fileId: string,
		storageId: BlobId,
		originGeneration: number | null,
	): Promise<AttachmentContent>;
}): { local: BlobStore; sources: BlobSources; remote: BlobRemote | null } {
	if (typeof appId !== 'string' || appId.trim() !== appId || !isAppId(appId)) {
		throw new TypeError(
			'Invalid blob app id: expected a reverse-domain app id.',
		);
	}
	const replica = captureLibraryReplica(input);
	const prefix =
		replica.library === 'local'
			? `/api/apps/${encodeURIComponent(appId)}/local/blobs`
			: `/api/apps/${encodeURIComponent(appId)}/accounts/${encodeIdentitySegment(replica.account.authorityId, 'authorityId')}/${encodeIdentitySegment(replica.account.principalId, 'principalId')}/${replica.library === 'shared' ? 'shared/' : ''}blobs`;
	const blobUrl = (id: BlobId) => `${prefix}/${id}`;
	async function request(id: BlobId, init: RequestInit, suffix = '') {
		return tryAsync({
			try: () =>
				fetcher(`${blobUrl(id)}${suffix}`, {
					...init,
					credentials: 'same-origin',
					redirect: 'error',
				}),
			catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
		});
	}

	async function transfer(
		operation: 'upload' | 'download',
		id: BlobId,
		expected: AttachmentContent,
		ticket: { url: string; requiredHeaders?: Record<string, string> },
		signal: AbortSignal,
	) {
		try {
			await nativeTransfer(operation, id, expected, ticket, signal);
			return Ok(undefined);
		} catch (cause) {
			if (
				cause &&
				typeof cause === 'object' &&
				'kind' in cause &&
				(cause.kind === 'transport' ||
					cause.kind === 'storage' ||
					cause.kind === 'conflict')
			)
				return AttachmentTransferError.Failed({
					kind: cause.kind,
					cause,
					status:
						'status' in cause && typeof cause.status === 'number'
							? cause.status
							: undefined,
				});
			return AttachmentTransferError.Failed({ kind: 'transport', cause });
		}
	}
	const local: BlobStore = {
		attachments: {
			upload: (id, expected, ticket, signal) =>
				transfer('upload', id, expected, ticket, signal),
			download: (id, expected, ticket, signal) =>
				transfer('download', id, expected, ticket, signal),
			async put(id, file, originGeneration) {
				if (!(file instanceof Blob)) {
					return tryAsync({
						try: async () => {
							if (!publishNative || originGeneration === undefined)
								throw new Error('Native publication is unavailable.');
							return publishNative(file.id, id, originGeneration);
						},
						catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
					});
				}
				const response = await request(id, {
					method: 'PUT',
					headers: {
						'content-type': file.type || 'application/octet-stream',
						'x-epicenter-attachment-origin':
							originGeneration === undefined
								? 'download'
								: String(originGeneration),
					},
					body: file,
				});
				if (response.error) return response;
				if (response.data.status === 409)
					return BlobStoreError.BlobAlreadyExists({ id });
				if (!response.data.ok)
					return BlobStoreError.BlobStoreFailed({
						id,
						cause: `Attachment publication returned ${response.data.status}.`,
					});
				return tryAsync({
					try: () => response.data.json() as Promise<AttachmentContent>,
					catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
				});
			},
			async acknowledge(id, expected, generation) {
				const response = await request(
					id,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ expected, generation }),
					},
					'/acknowledge',
				);
				if (response.error) return response;
				return response.data.ok
					? Ok(undefined)
					: BlobStoreError.BlobStoreFailed({
							id,
							cause: `Attachment acknowledgment returned ${response.data.status}.`,
						});
			},
		},
		async copy(sourceId, destinationId) {
			const response = await request(
				destinationId,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sourceId }),
				},
				'/copy',
			);
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
			const header = response.data.headers.get('x-epicenter-attachment');
			if (header !== null) {
				try {
					const attachment = JSON.parse(header) as NonNullable<
						BlobStat['attachment']
					>;
					if (
						!/^[a-f0-9]{64}$/.test(attachment.sha256) ||
						attachment.size !== size ||
						attachment.contentType !== contentType ||
						typeof attachment.pendingUpload !== 'boolean'
					)
						throw new Error('Invalid attachment metadata.');
					return Ok({ contentType, size, attachment });
				} catch (cause) {
					return BlobStoreError.BlobStoreFailed({ id, cause });
				}
			}
			return Ok({ contentType, size });
		},

		statMany(ids) {
			return Promise.all(ids.map((id) => local.stat(id)));
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

	async function operate(
		id: BlobId,
		operation: 'upload' | 'download' | 'purge',
	) {
		return tryAsync({
			try: () =>
				fetcher(`${blobUrl(id)}/${operation}`, {
					method: 'POST',
					credentials: 'same-origin',
					redirect: 'error',
				}),
			catch: (cause) => BlobRemoteError.BlobRemoteFailed({ id, cause }),
		});
	}

	function operationFailed(id: BlobId, operation: string, status: number) {
		if (status === 503) return BlobRemoteError.RemoteNotConfigured();
		return BlobRemoteError.BlobRemoteFailed({
			id,
			cause: new Error(`Host blob ${operation} returned ${status}.`),
		});
	}

	const remote: BlobRemote | null =
		selectedRemote === null || replica.library === 'local'
			? null
			: {
					async upload(id) {
						const response = await operate(id, 'upload');
						if (response.error !== null) return Err(response.error);
						if (response.data.status === 404) {
							return BlobStoreError.BlobNotFound({ id });
						}
						if (response.data.status === 500) {
							return BlobStoreError.BlobStoreFailed({
								id,
								cause: new Error(
									'Host blob upload failed to read local bytes.',
								),
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
								cause: new Error(
									'Host blob download failed to write local bytes.',
								),
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
	return { local, sources, remote };
}
