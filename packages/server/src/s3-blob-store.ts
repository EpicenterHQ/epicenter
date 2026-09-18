/**
 * Portable S3 client for the opaque-id blob store.
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

/** One object returned by {@link createS3BlobStore.list}. */
export type S3Object = { key: string; size: number; uploaded: string };

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

	async function list(prefix: string): Promise<S3Object[]> {
		const out: S3Object[] = [];
		let continuationToken: string | undefined;
		do {
			const url = new URL(`${config.endpoint}/${config.bucket}`);
			url.searchParams.set('list-type', '2');
			url.searchParams.set('prefix', prefix);
			url.searchParams.set('max-keys', '1000');
			if (continuationToken) {
				url.searchParams.set('continuation-token', continuationToken);
			}
			const res = await client.fetch(url.toString(), { method: 'GET' });
			if (!res.ok) {
				throw new Error(`S3 LIST ${prefix} failed: ${res.status}`);
			}
			const { objects, nextToken } = parseListObjectsV2(await res.text());
			out.push(...objects);
			continuationToken = nextToken;
		} while (continuationToken);
		return out;
	}

	async function deleteObject(
		key: string,
		signal?: AbortSignal,
	): Promise<void> {
		const res = await client.fetch(objectUrl(key).toString(), {
			method: 'DELETE',
			signal,
		});
		if (!res.ok && res.status !== 404) {
			throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
		}
	}

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
			if (!response.ok) throw new Error(`S3 PUT failed: ${response.status}`);
		},
		/** Read through the server; no signed URL leaves the storage boundary. */
		get(key: string, signal?: AbortSignal) {
			return client.fetch(objectUrl(key).toString(), { signal });
		},
		/**
		 * HeadObject existence check: does this key already exist? Used as the
		 * existence gate before a read. Size and upload time are the
		 * `list` path's job, so this answers only the boolean the callers need.
		 */
		async exists(key: string): Promise<boolean> {
			const res = await client.fetch(objectUrl(key).toString(), {
				method: 'HEAD',
			});
			if (res.status === 404) return false;
			if (!res.ok) {
				throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
			}
			return true;
		},

		/**
		 * ListObjectsV2 under `prefix`, following `IsTruncated` +
		 * `NextContinuationToken` to completion (max 1000/page). Returns every
		 * object's key, size, and upload time. The S3 list API is XML-only, so
		 * the body is parsed by {@link parseListObjectsV2}.
		 */
		list,

		/** DeleteObject. Idempotent: a missing key is not an error. */
		delete: deleteObject,

		/**
		 * Delete every object under `prefix` (list-then-delete; idempotent, so an
		 * account-deletion coordinator can re-run it after a partial failure). Not
		 * atomic: an in-flight PUT can land after this sweep completes.
		 */
		async deletePrefix(prefix: string): Promise<void> {
			for (const object of await list(prefix)) {
				await deleteObject(object.key);
			}
		},
	};
}

/** Extract the first `<Tag>…</Tag>` text from an XML fragment. */
function xmlTag(xml: string, name: string): string | undefined {
	const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return match?.[1];
}

/**
 * Parse the fields we need out of an S3 ListObjectsV2 XML response.
 *
 * Direct extraction (not a full XML parse) is safe here because blob keys are
 * `principals/<principalId>/blobs/<BlobId>`: only `[a-z0-9_/]`, never an
 * XML-special character, so no entity-unescaping is required. The continuation
 * token is opaque base64 and likewise carries no `<`, `>`, or `&`.
 */
function parseListObjectsV2(xml: string): {
	objects: S3Object[];
	nextToken: string | undefined;
} {
	const objects: S3Object[] = [];
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const block = match[1];
		if (block === undefined) continue;
		const key = xmlTag(block, 'Key');
		if (key === undefined) continue;
		objects.push({
			key,
			size: Number(xmlTag(block, 'Size') ?? '0'),
			uploaded: xmlTag(block, 'LastModified') ?? '',
		});
	}
	const truncated = xmlTag(xml, 'IsTruncated') === 'true';
	const nextToken = truncated
		? xmlTag(xml, 'NextContinuationToken')
		: undefined;
	return { objects, nextToken };
}
