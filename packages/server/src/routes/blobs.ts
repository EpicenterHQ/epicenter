/**
 * Blobs sub-app: a content-addressed object store where S3 IS the index.
 *
 * Uniform principal-partitioned URL shape:
 *   POST   /api/blobs              authed: request an upload ticket
 *   GET    /api/blobs              authed: list the principal's blobs
 *   HEAD   /api/blobs/:sha256      authed: read durable blob metadata
 *   GET    /api/blobs/:sha256      authed: read (302 to presigned GET)
 *
 * There is NO database row, NO queue, and NO event notification. The blob's
 * key IS its sha256 content address, so the store itself answers "what is at
 * this address" (HEAD) and "what do I have" (list). Rich metadata (source URL,
 * references) lives in the documents that cite the blob, not here.
 *
 * The store is a PORTABLE S3 client (`s3-blob-store.ts`): plain S3-over-HTTPS
 * via aws4fetch, no Cloudflare Workers R2 binding, so the identical route runs
 * on the hosted Worker (against R2) and in a self-hosted Node binary (against
 * Garage/S3). Uploads never pass through the server: POST mints a
 * presigned PUT and the client streams bytes straight to the store, which
 * enforces the sha256 checksum and rejects a mismatch. That removes the ~100 MB
 * Worker request-body ceiling and the in-server hashing cost. The object
 * appearing under its hash IS the record of a successful upload; no confirm
 * step.
 *
 * v1 is all-private: every route is auth gated (R2 public access is
 * bucket-level, so a public tier is a separate bucket, deferred). See
 * `docs/adr/0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md`.
 */

import { API_ROUTES, SHA256_HEX_REGEX } from '@epicenter/constants/api-routes';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { MAX_BLOB_BYTES } from '../constants.js';
import { blobKey, blobPrincipalPrefix } from '../principal.js';
import {
	createS3BlobStore,
	type S3BlobStore,
	type S3BlobStoreConfig,
} from '../s3-blob-store.js';
import type { Env } from '../types.js';
import { BlobError } from './blob-errors.js';

/** Anchored lowercase-hex sha256, built from the SAME {@link SHA256_HEX_REGEX}
 * the `:sha256` route param is constrained to. The route param is constrained by
 * Hono; the POST body's `sha256` is a plain field, so it is validated against
 * this here. One source of truth for the digest shape. */
const SHA256_HEX = new RegExp(`^${SHA256_HEX_REGEX}$`);

/** Presigned-URL lifetimes. Short: a presigned URL is a bearer token. */
const PUT_TTL_SECONDS = 300;
const GET_TTL_SECONDS = 120;

/**
 * Body of an upload-ticket request. Shape is validated here; the domain
 * checks (hex format, positive integer size, ceiling) run in the handler so
 * they return structured `BlobError`s.
 */
const TicketBody = type({
	sha256: 'string',
	sizeBytes: 'number',
	contentType: 'string',
});

/**
 * Blob-local context: the resolved store, stamped by {@link requireBlobStore}.
 * Kept off the shared library `Env` because only the blob routes use it.
 */
type BlobEnv = {
	Bindings: Env['Bindings'];
	Variables: Env['Variables'] & { blobStore: S3BlobStore };
};

/**
 * Map a deployment's `BLOBS_S3_*` env to a portable store config, or `null`
 * when object storage is not configured. The parameter is structural and
 * all-optional on purpose: it accepts any deployment's `c.env` regardless of
 * which optional vars that deployment's generated `Cloudflare.Env` actually
 * declares (apps/api's `wrangler types` lists only the required secrets).
 * `bucket` and `region` fall back to the R2 conventions so a hosted deploy
 * only sets the endpoint + credentials.
 */
function resolveBlobStoreConfig(env: {
	BLOBS_S3_ENDPOINT?: string;
	BLOBS_S3_ACCESS_KEY_ID?: string;
	BLOBS_S3_SECRET_ACCESS_KEY?: string;
	BLOBS_S3_BUCKET?: string;
	BLOBS_S3_REGION?: string;
}): S3BlobStoreConfig | null {
	if (
		!env.BLOBS_S3_ENDPOINT ||
		!env.BLOBS_S3_ACCESS_KEY_ID ||
		!env.BLOBS_S3_SECRET_ACCESS_KEY
	) {
		return null;
	}
	return {
		endpoint: env.BLOBS_S3_ENDPOINT.replace(/\/+$/, ''),
		region: env.BLOBS_S3_REGION ?? 'auto',
		accessKeyId: env.BLOBS_S3_ACCESS_KEY_ID,
		secretAccessKey: env.BLOBS_S3_SECRET_ACCESS_KEY,
		bucket: env.BLOBS_S3_BUCKET ?? 'epicenter-blobs',
	};
}

/**
 * Build this deployment's S3 blob store onto `c.var.blobStore`, or answer 503
 * when object storage is not configured. One owner for the "store is configured"
 * invariant, so every handler can assume the store is present. Typed as a bare
 * `MiddlewareHandler` so it slots into the `Hono<Env>` parent mount beside auth; it sets a
 * `BlobEnv` variable the sub-app reads.
 */
const requireBlobStore: MiddlewareHandler = createMiddleware<BlobEnv>(
	async (c, next) => {
		const config = resolveBlobStoreConfig(c.env);
		if (!config) {
			const err = BlobError.StorageNotConfigured();
			return c.json(err, err.error.status);
		}
		c.set('blobStore', createS3BlobStore(config));
		await next();
	},
);

const blobsApp = new Hono<BlobEnv>()
	// POST: request an upload ticket (presigned PUT, or a duplicate hit).
	.post(
		API_ROUTES.blobs.list.pattern,
		describeRoute({
			description:
				'Request an upload ticket for a content-addressed blob (presigned S3 PUT).',
			tags: ['blobs'],
		}),
		sValidator('json', TicketBody),
		async (c) => {
			const principalId = c.var.principal.id;
			const { sha256, sizeBytes, contentType } = c.req.valid('json');

			if (!SHA256_HEX.test(sha256)) {
				const err = BlobError.InvalidSha256({ value: sha256 });
				return c.json(err, err.error.status);
			}
			if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
				const err = BlobError.InvalidSize({ value: sizeBytes });
				return c.json(err, err.error.status);
			}
			if (sizeBytes > MAX_BLOB_BYTES) {
				const err = BlobError.BlobTooLarge({
					size: sizeBytes,
					maxBytes: MAX_BLOB_BYTES,
				});
				return c.json(err, err.error.status);
			}

			const key = blobKey(principalId, sha256);
			const url = API_ROUTES.blobs.byHash.url(c.var.authBaseURL, sha256);

			// Dedup within the principal boundary: if the object already exists, the
			// upload is a no-op. Content addressing makes this safe and cheap (one
			// HEAD).
			const existing = await c.var.blobStore.head(key);
			if (existing) {
				if (existing.size !== sizeBytes) {
					throw new Error(
						`Stored blob '${sha256}' size does not match its content address`,
					);
				}
				return c.json({
					status: 'duplicate' as const,
					url,
					size: existing.size,
					mediaType: existing.mediaType,
				});
			}

			const { url: uploadUrl, requiredHeaders } =
				await c.var.blobStore.presignPut({
					key,
					contentType: contentType || 'application/octet-stream',
					sha256Hex: sha256,
					expiresInSeconds: PUT_TTL_SECONDS,
				});

			// The ticket carries only what the uploader acts on: the read URL (which
			// ends in the sha256 the caller sent), the presigned PUT, and the signed
			// headers to echo. The PUT's TTL rides inside `uploadUrl` as the standard
			// `X-Amz-Expires` query param.
			return c.json({
				status: 'upload' as const,
				url,
				uploadUrl,
				requiredHeaders,
			});
		},
	)
	// GET: list the principal's blobs (S3 is the index).
	.get(
		API_ROUTES.blobs.list.pattern,
		describeRoute({
			description: "List the current principal's blobs.",
			tags: ['blobs'],
		}),
		async (c) => {
			const principalId = c.var.principal.id;
			const blobs = await listPrincipalBlobs(c.var.blobStore, principalId);
			return c.json(blobs);
		},
	)
	// HEAD by hash: exact durable BlobRef metadata without transferring bytes.
	.on('HEAD', API_ROUTES.blobs.byHash.pattern, async (c) => {
		const principalId = c.var.principal.id;
		const sha256 = c.req.param('sha256');
		const stored = await c.var.blobStore.head(blobKey(principalId, sha256));
		if (!stored) {
			const err = BlobError.NotFound();
			return c.json(err, err.error.status);
		}
		return new Response(null, {
			status: 200,
			headers: {
				'content-length': String(stored.size),
				'content-type': stored.mediaType,
				'x-epicenter-sha256': sha256,
			},
		});
	})
	// GET by hash: read (302 to short-TTL presigned GET).
	.get(
		API_ROUTES.blobs.byHash.pattern,
		describeRoute({
			description:
				'Read a blob: 302-redirect to a short-lived presigned GET URL.',
			tags: ['blobs'],
		}),
		async (c) => {
			const principalId = c.var.principal.id;
			const sha256 = c.req.param('sha256');
			const key = blobKey(principalId, sha256);
			if (!(await c.var.blobStore.head(key))) {
				const err = BlobError.NotFound();
				return c.json(err, err.error.status);
			}
			const presignedGet = await c.var.blobStore.presignGet({
				key,
				expiresInSeconds: GET_TTL_SECONDS,
			});
			return c.redirect(presignedGet, 302);
		},
	);

/**
 * Enumerate one principal's blobs by listing the store prefix. The sha256 is the
 * key minus the `principals/<principalId>/blobs/` prefix.
 */
async function listPrincipalBlobs(
	store: S3BlobStore,
	principalId: Env['Variables']['principal']['id'],
): Promise<{ sha256: string; size: number; uploaded: string }[]> {
	const prefix = blobPrincipalPrefix(principalId);
	const objects = await store.list(prefix);
	return objects.map((obj) => ({
		sha256: obj.key.slice(prefix.length),
		size: obj.size,
		uploaded: obj.uploaded,
	}));
}

/**
 * Mount the blobs surface on a deployment's server app.
 *
 * There is no public-read bypass in v1, so every route is
 * uniformly gated by the same chain: the deployment's auth (the cloud passes
 * `requireCookieOrBearerPrincipal`), then {@link requireBlobStore}
 * (which 503s a deployment with no object storage and otherwise stamps
 * `c.var.blobStore`). Unlike inference and transcription, blobs takes no
 * `policies`: no deployment gates storage today (the cloud is unmetered until
 * Autumn is wired, and a self-host's bucket is the operator's own, so there is
 * no house key to cap). The first real storage policy adds the seam back in
 * the same change that adds the policy.
 */
export function mountBlobsApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { auth: MiddlewareHandler<E> },
): void {
	// Every blob route runs the same chain: authenticate, then ensure object
	// storage is configured. The chain is bare-typed because it mixes the
	// deployment's `E`-typed auth with the blob-local `BlobEnv` middleware
	// (`requireBlobStore` stamps `c.var.blobStore`); both run on the same app.
	const chain: [MiddlewareHandler, MiddlewareHandler] = [
		opts.auth,
		requireBlobStore,
	];

	app.use(API_ROUTES.blobs.list.pattern, ...chain);
	app.use(API_ROUTES.blobs.byHash.pattern, ...chain);
	app.route('/', blobsApp);
}
