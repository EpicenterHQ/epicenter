/**
 * Portable S3 client for hosted blob objects.
 *
 * The module talks S3 over HTTPS via `aws4fetch` (SigV4). It uses `fetch` and
 * `SubtleCrypto` in both Cloudflare Workers and Bun, with no R2 binding.
 * The same code reaches R2 or a self-hosted S3-compatible service through
 * deployment configuration.
 *
 * Blob uploads and reads use authenticated server requests signed with SigV4.
 * PUT sends `Content-Type` and uses `If-None-Match: *`; the first PUT wins and a
 * repeated PUT receives 412 Precondition Failed.
 */

import { AwsClient } from 'aws4fetch';
import type { ServerBindings } from './server-bindings.js';

/**
 * Resolve deployment object storage per request. Routes return 503 when the
 * endpoint or credentials are unconfigured; `AwsClient` is cheap to construct.
 *
 * Set service and region explicitly so every S3-compatible endpoint uses
 * the configured signature scope without relying on host-name parsing.
 */
export function resolveDeploymentBlobStore(env: ServerBindings) {
	const endpoint = env.BLOBS_S3_ENDPOINT;
	const accessKeyId = env.BLOBS_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.BLOBS_S3_SECRET_ACCESS_KEY;
	if (!endpoint || !accessKeyId || !secretAccessKey) return null;
	// `auto` is R2's region; AWS S3 needs the bucket's region.
	const region = env.BLOBS_S3_REGION ?? 'auto';
	const bucket = env.BLOBS_S3_BUCKET ?? 'epicenter-blobs';
	const origin = endpoint.replace(/\/+$/, '');
	const client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region,
	});
	const objectUrl = (key: string) => new URL(`${origin}/${bucket}/${key}`);

	return {
		/** Publish one immutable object through the authenticated server. */
		async put(key: string, body: Blob, signal?: AbortSignal) {
			const response = await client.fetch(objectUrl(key).toString(), {
				method: 'PUT',
				headers: {
					'content-type': body.type || 'application/octet-stream',
					'if-none-match': '*',
					'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
				},
				body,
				signal,
			});
			await response.body?.cancel();
			if (response.ok) return 'created' as const;
			if (response.status === 409) return 'uncertain' as const;
			if (response.status !== 412)
				throw new Error(`S3 PUT failed: ${response.status}`);
			return 'conflict' as const;
		},
		/** Read through the server; no signed URL leaves the storage boundary. */
		get(
			key: string,
			signal?: AbortSignal,
			options?: { method: 'GET' | 'HEAD'; headers: Headers },
		) {
			return client.fetch(objectUrl(key).toString(), { ...options, signal });
		},
		/** DeleteObject. Idempotent: a missing key is not an error. */
		async delete(key: string, signal?: AbortSignal): Promise<void> {
			const response = await client.fetch(objectUrl(key).toString(), {
				method: 'DELETE',
				signal,
			});
			if (!response.ok && response.status !== 404)
				throw new Error(`S3 DELETE ${key} failed: ${response.status}`);
		},
	};
}
