/**
 * Portable S3 client for the content-addressed blob store.
 *
 * The whole module talks plain S3-over-HTTPS via `aws4fetch` (SigV4) — there is
 * NO Cloudflare Workers R2 binding here, by design. aws4fetch uses only `fetch`
 * and `SubtleCrypto`, both present on the Workers runtime AND on Node 18+, and
 * SigV4 is identical against any S3-compatible endpoint. So this exact module
 * runs unchanged on the hosted Cloudflare Worker (against R2) and in a
 * self-hosted Node binary (against Garage, AWS S3, ...). The endpoint is
 * configuration, not code: that is the blob store's answer to vendor lock-in.
 *
 * Blob bytes never pass through the server. PUT and GET are presigned and the
 * client talks to the store directly; only the cheap control-plane operations
 * (HEAD for dedup and durable metadata, list for the index, delete) are signed and made
 * server-side here. Grounded against the aws4fetch source and Cloudflare R2
 * docs; see
 * ADR-0089 (the blob store is a presigned-S3 kernel and the bucket is its only index).
 *
 * ── The two sha256 headers, which are easy to conflate ──────────────────────
 *
 *   x-amz-content-sha256  hex (or the literal `UNSIGNED-PAYLOAD`). The SigV4
 *                         *payload hash* in the canonical request. For a
 *                         presigned URL the body is unknown at sign time, so
 *                         aws4fetch uses `UNSIGNED-PAYLOAD` as the canonical
 *                         payload hash whenever `service === 's3' && signQuery`
 *                         (it does not emit a header). The client never resends
 *                         it. Pinning `service: 's3'` is what gates this AND the
 *                         single-encoded S3 canonical path, so it is required.
 *
 *   x-amz-checksum-sha256 base64 of the same 32-byte digest. The S3 *object
 *                         checksum*. R2 verifies the uploaded bytes against it
 *                         on a single PutObject and rejects a mismatch with
 *                         400 BadDigest. This is the integrity enforcement that
 *                         makes content addressing real: the object can only
 *                         appear under a key whose hash its bytes actually
 *                         match. It must be present BEFORE signing (so it enters
 *                         `X-Amz-SignedHeaders`) and resent verbatim by the
 *                         client.
 *
 * The blob's key uses the **hex** digest (the content address); the checksum
 * header uses the **base64** of that same digest. {@link hexToBase64} converts.
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

/** Result of presigning a PUT: the URL plus the headers the client must echo. */
export type PresignedPut = {
	url: string;
	/**
	 * Headers the client MUST send, byte-identical, on the actual PUT, or the
	 * store answers `403 SignatureDoesNotMatch`. They are signed headers, not
	 * query params, so aws4fetch leaves them for the client to replicate.
	 */
	requiredHeaders: Record<string, string>;
};

/** One object returned by {@link createS3BlobStore.list}. */
export type S3Object = { key: string; size: number; uploaded: string };
export type S3ObjectHead = { size: number; mediaType: string };

/** The store handle returned by {@link createS3BlobStore}. */
export type S3BlobStore = ReturnType<typeof createS3BlobStore>;

/**
 * Convert a 64-char lowercase-hex sha256 to the base64 form S3 wants for
 * `x-amz-checksum-sha256`. Both encode the same 32-byte digest.
 */
function hexToBase64(hex: string): string {
	if (hex.length !== 64) {
		throw new Error(`sha256 hex must be 64 chars, got ${hex.length}`);
	}
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Build a blob store bound to one S3 endpoint/bucket. Construct per request
 * from `c.env`; `AwsClient` is cheap.
 *
 * `service: 's3'` and the configured `region` are set explicitly rather than
 * left to aws4fetch's host parsing: the `UNSIGNED-PAYLOAD` default for
 * presigned PUTs is gated on `service === 's3'`, and a non-R2 endpoint would
 * not host-parse to the right service/region at all.
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
		/**
		 * Presign a PUT that the store will reject unless the uploaded bytes hash
		 * to `sha256Hex`. `contentType` is pinned into the signature (via
		 * `allHeaders`) so the stored object carries it; the client must echo
		 * both `content-type` and `x-amz-checksum-sha256`.
		 */
		async presignPut({
			key,
			contentType,
			sha256Hex,
			expiresInSeconds,
		}: {
			key: string;
			contentType: string;
			sha256Hex: string;
			expiresInSeconds: number;
		}): Promise<PresignedPut> {
			const checksumBase64 = hexToBase64(sha256Hex);
			const url = objectUrl(key);
			url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));

			const signed = await client.sign(
				new Request(url, {
					method: 'PUT',
					headers: {
						'content-type': contentType,
						'x-amz-checksum-sha256': checksumBase64,
					},
				}),
				// signQuery: signature in the query string (a presigned URL).
				// allHeaders: also pin `content-type` (otherwise unsignable, so
				// the client could upload any type). The checksum header signs
				// without it, but content-type needs it.
				{ aws: { signQuery: true, allHeaders: true } },
			);

			return {
				url: signed.url,
				requiredHeaders: {
					'content-type': contentType,
					'x-amz-checksum-sha256': checksumBase64,
				},
			};
		},

		/** Presign a short-lived GET. Redirect target for an auth-gated read. */
		async presignGet({
			key,
			expiresInSeconds,
		}: {
			key: string;
			expiresInSeconds: number;
		}): Promise<string> {
			const url = objectUrl(key);
			url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
			const signed = await client.sign(new Request(url, { method: 'GET' }), {
				aws: { signQuery: true },
			});
			return signed.url;
		},

		/** Read the immutable metadata pinned when the object was uploaded. */
		async head(key: string): Promise<S3ObjectHead | null> {
			const res = await client.fetch(objectUrl(key).toString(), {
				method: 'HEAD',
			});
			if (res.status === 404) return null;
			if (!res.ok) {
				throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
			}
			const size = Number(res.headers.get('content-length'));
			const mediaType = res.headers.get('content-type');
			if (!Number.isSafeInteger(size) || size < 1 || !mediaType) {
				throw new Error(`S3 HEAD ${key} returned invalid object metadata`);
			}
			return { size, mediaType };
		},

		/**
		 * ListObjectsV2 under `prefix`, following `IsTruncated` +
		 * `NextContinuationToken` to completion (max 1000/page). Returns every
		 * object's key, size, and upload time. The S3 list API is XML-only, so
		 * the body is parsed by {@link parseListObjectsV2}.
		 */
		async list(prefix: string): Promise<S3Object[]> {
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
		},

		/** DeleteObject. Idempotent: a missing key is not an error. */
		async delete(key: string): Promise<void> {
			const res = await client.fetch(objectUrl(key).toString(), {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
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
 * `principals/<principalId>/blobs/<sha256-hex>` — only `[a-z0-9/]`, never an
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
