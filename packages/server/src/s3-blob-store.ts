/**
 * Portable S3 client for hosted blob objects.
 *
 * The whole module talks plain S3-over-HTTPS via `aws4fetch` (SigV4) — there is
 * NO Cloudflare Workers R2 binding here, by design. aws4fetch uses only `fetch`
 * and `SubtleCrypto`, both present on the Workers runtime AND on Node 18+, and
 * SigV4 is identical against any S3-compatible endpoint. So this exact module
 * runs unchanged on the hosted Cloudflare Worker (against R2) and in a
 * self-hosted Node binary (against Garage, AWS S3, ...). The endpoint is
 * configuration, not code: that is the blob store's answer to vendor lock-in.
 *
 * Blob uploads and reads use authenticated server requests signed with SigV4.
 * PUT sends `Content-Type` and uses `If-None-Match: *`; the first PUT wins and a
 * repeated PUT receives 412 Precondition Failed.
 */

import { AwsClient } from 'aws4fetch';

/** S3 endpoint, credentials, and target bucket for one store. */
export type S3BlobStoreConfig = {
	/** S3 origin, no trailing slash. R2: `https://<accountId>.r2.cloudflarestorage.com`. */
	endpoint: string;
	/** SigV4 credential-scope region. `auto` for R2; the bucket region for AWS S3. */
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
};

/** The store handle returned by {@link createS3BlobStore}. */
export type S3BlobStore = ReturnType<typeof createS3BlobStore>;

/**
 * Build a blob store bound to one S3 endpoint/bucket. Construct per request
 * from `c.env`; `AwsClient` is cheap.
 *
 * Set service and region explicitly so every S3-compatible endpoint uses
 * the configured signature scope without relying on host-name parsing.
 */
export function createS3BlobStore(config: S3BlobStoreConfig) {
	const client = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: 's3',
		region: config.region,
	});
	const objectUrl = (key: string) =>
		new URL(`${config.endpoint}/${config.bucket}/${key}`);

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
