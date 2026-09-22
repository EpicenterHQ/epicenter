/** Account-bound direct blob operations and inference clients. */
import type { Account } from '@epicenter/auth';
import {
	type BlobId,
	BlobStoreError,
	blobInputContentType,
	MAX_REMOTE_BLOB_BYTES,
	parseBlobId,
	REMOTE_BLOB_ROUTES,
	type RemoteBlobs,
	RemoteBlobsError,
} from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { openBlobPresentation } from './blob-presentation.js';

export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
	ModelMessage,
	ModelToolCall,
} from '@epicenter/agent-protocol';
export {
	CONNECTION_PRESETS,
	type ConnectionPreset,
	type PresetId,
} from './connection-presets.js';
export {
	CompleteError,
	ListModelsError,
	TranscribeError,
} from './inference-errors.js';
export {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from './openai-provider.js';

/** Internal transport captures one store's placement; construction performs no IO. */
export function createRemoteBlobClient({
	appId,
	account,
}: {
	appId: string;
	account: Account;
}): RemoteBlobs {
	if (!isAppId(appId)) throw new TypeError('Invalid blob application ID.');
	const { baseURL, authorityId, principalId, fetch: accountFetch } = account;
	const destination = Object.freeze({
		namespace: appId,
		authorityId,
		principalId,
	});
	const url = (id: BlobId) => {
		if (!parseBlobId(id)) throw new TypeError('Invalid complete blob key.');
		return REMOTE_BLOB_ROUTES.objectUrl(baseURL, appId, principalId, id);
	};
	async function request(id: BlobId, init?: RequestInit) {
		return tryAsync({
			try: () => accountFetch(url(id), { ...init, redirect: 'error' }),
			catch: (cause) => RemoteBlobsError.Failed({ cause }),
		});
	}
	async function create(init: RequestInit) {
		const response = await tryAsync({
			try: () =>
				accountFetch(
					REMOTE_BLOB_ROUTES.collectionUrl(baseURL, appId, principalId),
					{ ...init, method: 'POST', redirect: 'error' },
				),
			catch: (cause) => RemoteBlobsError.Failed({ cause }),
		});
		if (response.error)
			return RemoteBlobsError.PublicationUnconfirmed({
				destination,
				cause: response.error,
			});
		return created(response.data);
	}
	async function created(response: Response, expectedId?: BlobId) {
		return tryAsync({
			try: async () => {
				if (response.status !== 201) {
					await response.body?.cancel();
					throw new Error(`Blob creation returned ${response.status}`);
				}
				const body: unknown = await response.json();
				const id =
					body &&
					typeof body === 'object' &&
					'id' in body &&
					typeof body.id === 'string'
						? parseBlobId(body.id)
						: null;
				if (!id) throw new Error('Blob creation returned an invalid ID.');
				if (expectedId !== undefined && id !== expectedId)
					throw new Error('Native copy returned a different destination ID.');
				return id;
			},
			catch: (cause) =>
				RemoteBlobsError.PublicationUnconfirmed({ destination, cause }),
		});
	}
	const remote: RemoteBlobs = {
		async copyToLocal(id, destinationAppId, destinationId, options) {
			if (!isAppId(destinationAppId))
				throw new TypeError('Invalid native destination namespace.');
			if (!parseBlobId(destinationId))
				throw new TypeError('Invalid native destination ID.');
			const response = await request(id, {
				method: 'POST',
				headers: {
					'x-epicenter-copy-destination-app': destinationAppId,
					'x-epicenter-copy-destination-id': destinationId,
				},
				signal: options?.signal,
			});
			if (response.error) return response;
			if (response.data.status === 409) {
				await response.data.body?.cancel();
				return BlobStoreError.BlobAlreadyExists({ id: destinationId });
			}
			return created(response.data, destinationId);
		},
		async add(blob, options) {
			options?.signal?.throwIfAborted();
			if (blob.size > MAX_REMOTE_BLOB_BYTES)
				return RemoteBlobsError.TooLarge({ size: blob.size });
			return create({
				headers: { 'content-type': blobInputContentType(blob) },
				body: blob,
				signal: options?.signal,
			});
		},
		async copyFromLocal({ local, nativeAppId }, id, options) {
			options?.signal?.throwIfAborted();
			if (!parseBlobId(id)) throw new TypeError('Invalid source blob ID.');
			if (nativeAppId !== undefined) {
				if (!isAppId(nativeAppId))
					throw new TypeError('Invalid native source namespace.');
				return create({
					headers: {
						'x-epicenter-local-blob-id': id,
						'x-epicenter-local-blob-app': nativeAppId,
					},
					signal: options?.signal,
				});
			}
			const snapshot = await local.get(id);
			if (snapshot.error) return Err(snapshot.error);
			options?.signal?.throwIfAborted();
			return remote.add(snapshot.data, options);
		},
		async get(id, options) {
			const response = await request(id, { signal: options?.signal });
			if (response.error) return response;
			if (!response.data.ok) {
				await response.data.body?.cancel();
				return RemoteBlobsError.Failed({
					cause: `HTTP ${response.data.status}`,
					status: response.data.status,
				});
			}
			return tryAsync({
				try: () => response.data.blob(),
				catch: (cause) => RemoteBlobsError.Failed({ cause }),
			});
		},
		async open(id, options) {
			return tryAsync({
				try: () => openBlobPresentation(accountFetch, url(id), options?.signal),
				catch: (cause) => RemoteBlobsError.Failed({ cause }),
			});
		},
		async delete(id, options) {
			const response = await request(id, {
				method: 'DELETE',
				signal: options?.signal,
			});
			if (response.error) return response;
			await response.data.body?.cancel();
			if (!response.data.ok)
				return RemoteBlobsError.Failed({
					cause: `HTTP ${response.data.status}`,
					status: response.data.status,
				});
			return Ok(undefined);
		},
	};
	return remote;
}
