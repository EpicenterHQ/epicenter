/**
 * `@epicenter/client`: typed HTTP client for the Epicenter server.
 *
 * Principal-scoped data surfaces (`blobs`) over `AuthFetch` from
 * `@epicenter/auth`, which handles OAuth bearer attach, refresh, and 401
 * propagation. This package owns neither auth state nor identity: the caller
 * passes the authed fetch handle, so the client never fetches `/api/session`
 * itself. Profile reads live on the auth client (`auth.getProfile()`); see
 * ADR-0067.
 *
 * Works against any Epicenter deployment (cloud at `epicenter.so` or a
 * self-hosted single-partition instance).
 */

import type { AuthFetch } from '@epicenter/auth';
import {
	type BlobAlreadyExists,
	type BlobId,
	type BlobNotFound,
	type BlobRemote,
	BlobRemoteError,
	type BlobStat,
	type BlobStore,
	type BlobStoreFailed,
} from '@epicenter/blobs';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
	EngineFetch,
	ModelMessage,
	ModelToolCall,
} from './agent-engine.js';
export { CompleteError, complete } from './complete.js';
export {
	CONNECTION_PRESETS,
	type Connection,
	type ConnectionPreset,
	ListModelsError,
	listModels,
	type PresetId,
	type ResolvedConnection,
	resolveConnection,
} from './connection.js';
export {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from './openai-provider.js';
export { TranscribeError, transcribe } from './transcribe.js';

export type EpicenterClientOptions = {
	/** Base URL of the Epicenter server (no trailing slash required). */
	baseURL: string;
	/**
	 * Authenticated fetch from a captured `Account` in `@epicenter/auth`.
	 * The client does not own auth lifecycle.
	 */
	fetch: AuthFetch;
};

// ---------------------------------------------------------------------------
// Blob types (opaque-id remote store; mirror the server response shapes)
// ---------------------------------------------------------------------------

/** Result of the client's `blobs.add`. */
export type AddBlobResult = {
	blobId: BlobId;
	/** Authenticated read URL (`GET /blobs/:blobId`, a 302 to a presigned GET). */
	url: string;
};

/**
 * Upload-ticket response from `POST /blobs`: a create-only presigned PUT plus
 * the headers the client must echo verbatim. Internal to `blobs.add`.
 */
type BlobTicket = {
	url: string;
	uploadUrl: string;
	requiredHeaders: Record<string, string>;
};

/** Failure modes of the Result-returning client surfaces (`blobs.*`). */
export const ClientError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS. */
	TransportFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `${operation}: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	/** A request reached the server/store but returned a non-2xx status. */
	RequestFailed: ({
		operation,
		status,
		detail,
	}: {
		operation: string;
		status: number;
		detail?: string;
	}) => ({
		message: `${operation} failed (${status})${detail ? `: ${detail}` : ''}`,
		operation,
		status,
		detail,
	}),
});
export type ClientError = InferErrors<typeof ClientError>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a typed Epicenter client bound to a base URL and an authed fetch. Every
 * surface is synchronous to construct; nothing here touches `/api/session`.
 */
export function createEpicenterClient(opts: EpicenterClientOptions) {
	const base = opts.baseURL.replace(/\/+$/, '');

	// Run one authed request, folding transport failure and non-2xx into a typed
	// Result so the blob methods never throw.
	async function request(
		input: string,
		init: RequestInit | undefined,
		operation: string,
	): Promise<Result<Response, ClientError>> {
		const { data: res, error } = await tryAsync({
			try: () => opts.fetch(input, init),
			catch: (cause) => ClientError.TransportFailed({ operation, cause }),
		});
		if (error !== null) return Err(error);
		if (!res.ok) {
			const detail = (await res.text().catch(() => '')).slice(0, 200);
			return ClientError.RequestFailed({
				operation,
				status: res.status,
				detail,
			});
		}
		return Ok(res);
	}

	const blobs = {
		/**
		 * Store bytes under a caller-minted BlobId: mint an upload ticket and PUT
		 * the bytes straight to the store. This portable browser-facing boundary
		 * accepts a Blob/File, never a request stream; Bun shells resolve file and
		 * URL sources before calling it.
		 *
		 * The presigned PUT goes direct to the store with a plain `fetch`, not the
		 * authed one: the URL is self-authenticating and an extra bearer is not in
		 * the signed header set. The signed `If-None-Match: *` makes the first
		 * upload for an id immutable; a repeated upload's 412 is idempotent success.
		 */
		async add(
			blobId: BlobId,
			blob: Blob,
			params: { contentType?: string } = {},
		): Promise<Result<AddBlobResult, ClientError>> {
			const contentType =
				params.contentType || blob.type || 'application/octet-stream';

			const { data: ticketRes, error: ticketError } = await request(
				API_ROUTES.blobs.collection.url(base),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						blobId,
						sizeBytes: blob.size,
						contentType,
					}),
				},
				'POST /blobs',
			);
			if (ticketError !== null) return Err(ticketError);
			const ticket = (await ticketRes.json()) as BlobTicket;

			const { data: put, error: putError } = await tryAsync({
				try: () =>
					fetch(ticket.uploadUrl, {
						method: 'PUT',
						headers: ticket.requiredHeaders,
						body: blob,
					}),
				catch: (cause) =>
					ClientError.TransportFailed({ operation: 'store PUT', cause }),
			});
			if (putError !== null) return Err(putError);
			if (!put.ok && put.status !== 412) {
				const detail = (await put.text().catch(() => '')).slice(0, 200);
				return ClientError.RequestFailed({
					operation: 'store PUT',
					status: put.status,
					detail,
				});
			}
			return Ok({ blobId, url: ticket.url });
		},

		/**
		 * Build the authenticated read URL for a blob under the authenticated
		 * principal. Synchronous; the principal partition comes from auth.
		 *
		 * Useful for resolving a manifest entry, an `<img src>`, or a share link.
		 */
		url(blobId: BlobId): string {
			return API_ROUTES.blobs.byId.url(base, blobId);
		},

		/**
		 * Read a blob's bytes. The server answers 302 to a short-lived presigned
		 * GET. A cookie-authed fetch follows the redirect itself and arrives here
		 * as a 2xx bytes `Response`. A bearer-authed fetch pins
		 * `redirect: 'manual'` (a bearer must never follow a cross-origin
		 * redirect), so the 302 surfaces raw; we read `Location` and fetch the
		 * presigned URL with the plain global `fetch`, so no bearer reaches the
		 * storage origin. On success `data` is the bytes `Response`.
		 */
		async get(blobId: BlobId): Promise<Result<Response, ClientError>> {
			const operation = 'GET /blobs/:blobId';
			const { data: res, error } = await tryAsync({
				try: () => opts.fetch(API_ROUTES.blobs.byId.url(base, blobId)),
				catch: (cause) => ClientError.TransportFailed({ operation, cause }),
			});
			if (error !== null) return Err(error);

			// A fetch that followed the redirect already holds the bytes.
			if (res.ok) return Ok(res);

			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get('location');
				if (!location) {
					return ClientError.RequestFailed({
						operation,
						status: res.status,
						detail: 'redirect without a Location header',
					});
				}
				const { data: store, error: storeError } = await tryAsync({
					try: () => fetch(location),
					catch: (cause) =>
						ClientError.TransportFailed({ operation: 'store GET', cause }),
				});
				if (storeError !== null) return Err(storeError);
				if (!store.ok) {
					const detail = (await store.text().catch(() => '')).slice(0, 200);
					return ClientError.RequestFailed({
						operation: 'store GET',
						status: store.status,
						detail,
					});
				}
				return Ok(store);
			}

			const detail = (await res.text().catch(() => '')).slice(0, 200);
			return ClientError.RequestFailed({
				operation,
				status: res.status,
				detail,
			});
		},

		async delete(blobId: BlobId): Promise<Result<void, ClientError>> {
			const { error: reqError } = await request(
				API_ROUTES.blobs.byId.url(base, blobId),
				{ method: 'DELETE' },
				'DELETE /blobs/:blobId',
			);
			if (reqError !== null) return Err(reqError);
			return Ok(undefined);
		},
	};

	return {
		blobs,
	};
}

export type EpicenterClient = ReturnType<typeof createEpicenterClient>;

/**
 * Compose a Blob-valued local store with the hosted remote blob surface.
 *
 * This adapter is for browser-like runtimes where `BlobStore.get` already
 * returns an in-process Blob. Epicenter Desktop uses a separate host-owned
 * adapter so large BunFile recordings stream directly to S3 without crossing
 * WebView IPC.
 */
export function createBrowserBlobRemote({
	local,
	client,
}: {
	local: BlobStore;
	client: EpicenterClient;
}): BlobRemote {
	return {
		async upload(id) {
			const { data: blob, error: localError } = await local.get(id);
			if (localError !== null) return Err(localError);
			const { error: remoteError } = await client.blobs.add(id, blob);
			return remoteError === null
				? Ok(undefined)
				: BlobRemoteError.BlobRemoteFailed({ id, cause: remoteError });
		},

		async download(id) {
			const { error: statError } = await local.stat(id);
			if (statError === null) return Ok(undefined);
			if (statError.name !== 'BlobNotFound') return Err(statError);

			const { data: response, error: remoteError } = await client.blobs.get(id);
			if (remoteError !== null) {
				return remoteError.name === 'RequestFailed' &&
					remoteError.status === 404
					? BlobRemoteError.RemoteBlobNotFound({ id })
					: BlobRemoteError.BlobRemoteFailed({ id, cause: remoteError });
			}
			const { data: blob, error: readError } = await tryAsync({
				try: () => response.blob(),
				catch: (cause) => BlobRemoteError.BlobRemoteFailed({ id, cause }),
			});
			if (readError !== null) return Err(readError);

			const { error: putError } = await local.put(id, blob);
			if (putError === null || putError.name === 'BlobAlreadyExists') {
				return Ok(undefined);
			}
			return Err(putError);
		},

		async purge(id) {
			const { error } = await client.blobs.delete(id);
			return error === null
				? Ok(undefined)
				: BlobRemoteError.BlobRemoteFailed({ id, cause: error });
		},
	};
}

/**
 * The streaming surface the desktop remote needs from a host-owned store.
 * `BunBlobStore` satisfies it: `openFile` hands back a lazy file (a `Blob`
 * whose bytes load on demand) and `putResponse` writes a response stream.
 */
export type HostBlobStore = {
	openFile(
		id: BlobId,
	): Promise<
		Result<{ file: Blob; stat: BlobStat }, BlobNotFound | BlobStoreFailed>
	>;
	putResponse(
		id: BlobId,
		response: Response,
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
	stat(id: BlobId): Promise<Result<BlobStat, BlobNotFound | BlobStoreFailed>>;
};

/**
 * Compose the Bun filesystem store with the hosted remote blob surface.
 *
 * This is the desktop host's adapter (ADR-0149): upload hands the store's lazy
 * `BunFile` to the presigned PUT so recording bytes stream from disk, and
 * download writes the presigned GET's response stream straight into the store,
 * so a large object is never materialized in memory and never crosses WebView
 * IPC. The caller owns the authed fetch inside `client`; presigned vocabulary
 * stays inside `client.blobs`.
 */
export function createBunBlobRemote({
	store,
	client,
}: {
	store: HostBlobStore;
	client: EpicenterClient;
}): BlobRemote {
	return {
		async upload(id) {
			const { data: opened, error: localError } = await store.openFile(id);
			if (localError !== null) return Err(localError);
			const { error: remoteError } = await client.blobs.add(id, opened.file, {
				contentType: opened.stat.contentType,
			});
			return remoteError === null
				? Ok(undefined)
				: BlobRemoteError.BlobRemoteFailed({ id, cause: remoteError });
		},

		async download(id) {
			const { error: statError } = await store.stat(id);
			if (statError === null) return Ok(undefined);
			if (statError.name !== 'BlobNotFound') return Err(statError);

			const { data: response, error: remoteError } = await client.blobs.get(id);
			if (remoteError !== null) {
				return remoteError.name === 'RequestFailed' &&
					remoteError.status === 404
					? BlobRemoteError.RemoteBlobNotFound({ id })
					: BlobRemoteError.BlobRemoteFailed({ id, cause: remoteError });
			}

			const { error: putError } = await store.putResponse(id, response);
			if (putError === null || putError.name === 'BlobAlreadyExists') {
				return Ok(undefined);
			}
			return Err(putError);
		},

		async purge(id) {
			const { error } = await client.blobs.delete(id);
			return error === null
				? Ok(undefined)
				: BlobRemoteError.BlobRemoteFailed({ id, cause: error });
		},
	};
}
