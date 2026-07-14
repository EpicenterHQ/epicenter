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
	 * Authenticated fetch. Produced by `createOAuthAppAuth({...}).fetch`
	 * from `@epicenter/auth`. The client does not own auth lifecycle.
	 */
	fetch: AuthFetch;
};

// ---------------------------------------------------------------------------
// Blob types (content-addressed store; mirror the server response shapes)
// ---------------------------------------------------------------------------

/** One row of the current principal's blob listing (`GET /blobs`). */
export type BlobRow = { sha256: string; size: number; uploaded: string };

export type BlobRef = { hash: string; size: number; mediaType: string };

/** Result of the client's `blobs.add`. */
export type AddBlobResult = {
	/** Durable table value. It is returned only after the bytes exist. */
	ref: BlobRef;
	/** Content-addressed read URL (`GET /blobs/:sha256`, a 302 to a presigned GET). */
	url: string;
	/** True when the object already existed, so no bytes were uploaded. */
	duplicate: boolean;
};

/**
 * Upload-ticket response from `POST /blobs`. The server either reports the
 * object already exists (`duplicate`) or returns a presigned PUT plus the
 * headers the client must echo verbatim (`upload`). Internal to `blobs.add`.
 */
type BlobTicket =
	| { status: 'duplicate'; url: string; size: number; mediaType: string }
	| {
			status: 'upload';
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

/**
 * Hex sha256 of a byte buffer via the platform WebCrypto (`crypto.subtle`),
 * present on browsers, Node 18+, and Workers. This hex digest IS the blob's
 * content address; the server derives the base64 `x-amz-checksum-sha256` the
 * store enforces from the same digest.
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
}

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
		 * Archive bytes in the content-addressed store: hash the bytes, mint an
		 * upload ticket, and (unless the object already exists) PUT the bytes
		 * straight to the store. Accepts a `File`/`Blob`, or an `http(s)` URL
		 * string to fetch first.
		 *
		 * The presigned PUT goes direct to the store with a plain `fetch`, not the
		 * authed one: the URL is self-authenticating and an extra bearer is not in
		 * the signed header set. The signed `x-amz-checksum-sha256` is echoed
		 * verbatim, so the object can only land under a key whose hash its bytes
		 * actually match (mismatch -> 400 BadDigest).
		 */
		async add(
			fileOrUrl: File | Blob | string,
			params: { contentType?: string } = {},
		): Promise<Result<AddBlobResult, ClientError>> {
			let bytes: ArrayBuffer;
			let contentType: string;
			if (typeof fileOrUrl === 'string') {
				const { data: source, error } = await tryAsync({
					try: () => fetch(fileOrUrl),
					catch: (cause) =>
						ClientError.TransportFailed({
							operation: `GET ${fileOrUrl}`,
							cause,
						}),
				});
				if (error !== null) return Err(error);
				if (!source.ok) {
					return ClientError.RequestFailed({
						operation: `GET ${fileOrUrl}`,
						status: source.status,
					});
				}
				bytes = await source.arrayBuffer();
				// `||`, matching the Blob branch below: an empty-string content type
				// (an override of '' or a bare header) falls through to the default
				// instead of being pinned into the stored object verbatim.
				contentType =
					params.contentType ||
					source.headers.get('content-type') ||
					'application/octet-stream';
			} else {
				bytes = await fileOrUrl.arrayBuffer();
				contentType =
					params.contentType || fileOrUrl.type || 'application/octet-stream';
			}

			const sha256 = await sha256Hex(bytes);

			const { data: ticketRes, error: ticketError } = await request(
				API_ROUTES.blobs.list.url(base),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sha256,
						sizeBytes: bytes.byteLength,
						contentType,
					}),
				},
				'POST /blobs',
			);
			if (ticketError !== null) return Err(ticketError);
			const ticket = (await ticketRes.json()) as BlobTicket;

			if (ticket.status === 'duplicate') {
				return Ok({
					ref: {
						hash: sha256,
						size: ticket.size,
						mediaType: ticket.mediaType,
					},
					url: ticket.url,
					duplicate: true,
				});
			}

			const { data: put, error: putError } = await tryAsync({
				try: () =>
					fetch(ticket.uploadUrl, {
						method: 'PUT',
						headers: ticket.requiredHeaders,
						body: bytes,
					}),
				catch: (cause) =>
					ClientError.TransportFailed({ operation: 'store PUT', cause }),
			});
			if (putError !== null) return Err(putError);
			if (!put.ok) {
				const detail = (await put.text().catch(() => '')).slice(0, 200);
				return ClientError.RequestFailed({
					operation: 'store PUT',
					status: put.status,
					detail,
				});
			}
			return Ok({
				ref: { hash: sha256, size: bytes.byteLength, mediaType: contentType },
				url: ticket.url,
				duplicate: false,
			});
		},

		/**
		 * Build the content-addressed read URL for a blob under the authenticated
		 * principal. Synchronous; the principal partition comes from auth.
		 *
		 * Useful for resolving a manifest entry, an `<img src>`, or a share link.
		 */
		url(sha256: string): string {
			return API_ROUTES.blobs.byHash.url(base, sha256);
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
		async get(sha256: string): Promise<Result<Response, ClientError>> {
			const operation = 'GET /blobs/:sha256';
			const { data: res, error } = await tryAsync({
				try: () => opts.fetch(API_ROUTES.blobs.byHash.url(base, sha256)),
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

		async list(): Promise<Result<BlobRow[], ClientError>> {
			const { data: res, error: reqError } = await request(
				API_ROUTES.blobs.list.url(base),
				undefined,
				'GET /blobs',
			);
			if (reqError !== null) return Err(reqError);
			return Ok((await res.json()) as BlobRow[]);
		},

		/** Read exact durable BlobRef metadata without transferring bytes. */
		async head(sha256: string): Promise<Result<BlobRef, ClientError>> {
			const { data: response, error } = await request(
				API_ROUTES.blobs.byHash.url(base, sha256),
				{ method: 'HEAD' },
				`HEAD /blobs/${sha256}`,
			);
			if (error) return Err(error);
			const size = Number(response.headers.get('content-length'));
			const mediaType = response.headers.get('content-type');
			const storedHash = response.headers.get('x-epicenter-sha256');
			if (
				storedHash !== sha256 ||
				!Number.isSafeInteger(size) ||
				size < 1 ||
				!mediaType
			) {
				return ClientError.RequestFailed({
					operation: `HEAD /blobs/${sha256}`,
					status: response.status,
					detail: 'invalid blob metadata',
				});
			}
			return Ok({ hash: sha256, size, mediaType });
		},
	};

	return {
		blobs,
	};
}

export type EpicenterClient = ReturnType<typeof createEpicenterClient>;
