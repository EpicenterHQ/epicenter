/** Account-bound direct blob operations and inference clients. */
import type { Account } from '@epicenter/auth';
import {
	type BlobStore,
	blobInputContentType,
	MAX_REMOTE_BLOB_BYTES,
	parseBlobId,
	REMOTE_BLOB_ROUTES,
	type RemoteBlobs,
	RemoteBlobsError,
} from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { Err, Ok, tryAsync } from 'wellcrafted/result';

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

/** Internal platform composition; construction performs no IO. */
export function createRemoteBlobClient({
	appId,
	account,
	local,
	host = false,
}: {
	appId: string;
	account: Account;
	local: Pick<BlobStore, 'get' | 'stat'>;
	/** The desktop Account broker replaces the control request with native bytes. */
	host?: boolean;
}): RemoteBlobs {
	if (!isAppId(appId)) throw new TypeError('Invalid blob application ID.');
	const { baseURL, principalId, fetch: accountFetch } = account;
	const collection = REMOTE_BLOB_ROUTES.collectionUrl(baseURL, appId);
	const objectPrefix = `${baseURL.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(appId)}/principals/${encodeURIComponent(principalId)}/blobs/`;
	function owns(url: string) {
		if (!url.startsWith(objectPrefix)) return false;
		const id = parseBlobId(url.slice(objectPrefix.length));
		return (
			id !== undefined &&
			REMOTE_BLOB_ROUTES.objectUrl(baseURL, appId, principalId, id) === url
		);
	}
	async function request(url: string, init?: RequestInit) {
		const response = await tryAsync({
			try: () => accountFetch(url, { ...init, redirect: 'error' }),
			catch: (cause) => RemoteBlobsError.Failed({ cause }),
		});
		if (response.error) return response;
		if (!response.data.ok) {
			await response.data.body?.cancel().catch(() => {});
			return RemoteBlobsError.Failed({
				cause: `HTTP ${response.data.status}`,
				status: response.data.status,
			});
		}
		return response;
	}
	async function uploaded(response: Awaited<ReturnType<typeof request>>) {
		if (response.error) return response;
		return tryAsync({
			try: async () => {
				const result: unknown = await response.data.json();
				if (
					!result ||
					typeof result !== 'object' ||
					!('url' in result) ||
					typeof result.url !== 'string' ||
					!owns(result.url)
				)
					throw new Error('Upload returned an invalid remote blob URL.');
				return result.url;
			},
			catch: (cause) => RemoteBlobsError.Failed({ cause }),
		});
	}
	const remote: RemoteBlobs = {
		async add(blob, options) {
			if (blob.size > MAX_REMOTE_BLOB_BYTES)
				return RemoteBlobsError.TooLarge({ size: blob.size });
			return uploaded(
				await request(collection, {
					method: 'POST',
					headers: { 'content-type': blobInputContentType(blob) },
					body: blob,
					signal: options?.signal,
				}),
			);
		},
		async addLocal(id, options) {
			const stat = await local.stat(id);
			if (stat.error) return Err(stat.error);
			if (stat.data.size > MAX_REMOTE_BLOB_BYTES)
				return RemoteBlobsError.TooLarge({ size: stat.data.size });
			if (host)
				return uploaded(
					await request(collection, {
						method: 'POST',
						headers: { 'x-epicenter-local-blob-id': id },
						signal: options?.signal,
					}),
				);
			const blob = await local.get(id);
			if (blob.error) return Err(blob.error);
			return remote.add(blob.data, options);
		},
		async get(url, options) {
			if (!owns(url)) return RemoteBlobsError.InvalidUrl({ url });
			const response = await request(url, { signal: options?.signal });
			if (response.error) return response;
			return tryAsync({
				try: () => response.data.blob(),
				catch: (cause) => RemoteBlobsError.Failed({ cause }),
			});
		},
		async open(url, options) {
			const result = await remote.get(url, options);
			if (result.error) return result;
			return tryAsync({
				try: async () => {
					const source = URL.createObjectURL(result.data);
					let disposed = false;
					return {
						url: source,
						[Symbol.dispose]() {
							if (disposed) return;
							disposed = true;
							URL.revokeObjectURL(source);
						},
					};
				},
				catch: (cause) => RemoteBlobsError.Failed({ cause }),
			});
		},
		async delete(url, options) {
			if (!owns(url)) return RemoteBlobsError.InvalidUrl({ url });
			const response = await request(url, {
				method: 'DELETE',
				signal: options?.signal,
			});
			if (response.error) return response;
			await response.data.body?.cancel().catch(() => {});
			return Ok(undefined);
		},
	};
	return remote;
}
