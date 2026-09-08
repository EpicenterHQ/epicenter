/**
 * Blob routes: an address-only opaque-id object store.
 *
 * Uniform principal-partitioned URL shape:
 *   POST   /api/blobs              authed: request an upload ticket
 *   GET    /api/blobs/:blobId      authed: read (302 to presigned GET)
 *   DELETE /api/blobs/:blobId      authed: delete
 *
 * There is NO database row, NO queue, NO event notification, and NO public
 * enumeration: every route acts on a BlobId the caller already knows, and the
 * application data citing a blob supplies its meaning (ADR-0154). Rich
 * metadata (source URL, references) lives in the documents that cite the
 * blob, not here.
 *
 * The store is a PORTABLE S3 client (`s3-blob-store.ts`): plain S3-over-HTTPS
 * via aws4fetch, no Cloudflare Workers R2 binding, so the identical route runs
 * on the hosted Worker (against R2) and in a self-hosted Node binary (against
 * Garage/S3). Uploads never pass through the server: POST mints a
 * presigned create-only PUT and the client streams bytes straight to the store.
 * That removes the ~100 MB Worker request-body ceiling and all hashing cost.
 * The object appearing under its BlobId is the successful upload record; no
 * confirm step.
 *
 * v1 is all-private: every route is auth gated (R2 public access is
 * bucket-level, so a public tier is a separate bucket, deferred). See
 * ADR-0089 (presigned S3 kernel) as amended by ADR-0148 (opaque BlobId).
 */

import { parseBlobId } from '@epicenter/blobs';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { MAX_BLOB_BYTES } from '../constants.js';
import { blobKey } from '../principal.js';
import {
	createS3BlobStore,
	type S3BlobStore,
	type S3BlobStoreConfig,
} from '../s3-blob-store.js';
import type { Env } from '../types.js';
import { BlobError } from './blob-errors.js';

/** Presigned-URL lifetimes. Short: a presigned URL is a bearer token. */
const PUT_TTL_SECONDS = 300;
const GET_TTL_SECONDS = 120;

/**
 * Body of an upload-ticket request. Shape is validated here; the domain
 * checks (BlobId format, non-negative declared size, ceiling) run in the
 * handler so they return structured `BlobError`s. `sizeBytes` is an early
 * convenience refusal, not an integrity claim: S3 remains authoritative for
 * the actual uploaded object size.
 */
const TicketBody = type({
	blobId: 'string',
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
 * Build this deployment's blob store from its `BLOBS_S3_*` env, or `null` when
 * object storage is not configured. The routes below wrap this in a 503; a
 * deployment operation (account deletion's prefix sweep) treats `null` as
 * nothing to delete.
 */
export function resolveDeploymentBlobStore(
	env: Parameters<typeof resolveBlobStoreConfig>[0],
): S3BlobStore | null {
	const config = resolveBlobStoreConfig(env);
	return config === null ? null : createS3BlobStore(config);
}

/**
 * Build this deployment's S3 blob store onto `c.var.blobStore`, or answer 503
 * when object storage is not configured. One owner for the "store is configured"
 * invariant, so every handler can assume the store is present. Hono carries
 * the middleware's BlobEnv into the following handler, including upload-body
 * validation, without putting blobStore on the portable Env.
 */
const requireBlobStore = createMiddleware<BlobEnv>(async (c, next) => {
	const store = resolveDeploymentBlobStore(c.env);
	if (!store) {
		const err = BlobError.StorageNotConfigured();
		return c.json(err, err.error.status);
	}
	c.set('blobStore', store);
	await next();
});

/**
 * Mount the blobs surface on a deployment's server app.
 *
 * There is no public-read bypass in v1, so every route is
 * uniformly gated by the same chain: the deployment's bearer auth,
 * then {@link requireBlobStore}
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
	app
		// POST: request a create-only presigned PUT.
		.post(
			API_ROUTES.blobs.collection.pattern,
			opts.auth,
			requireBlobStore,
			describeRoute({
				description: 'Request an upload ticket for an opaque-id blob.',
				tags: ['blobs'],
			}),
			sValidator('json', TicketBody),
			async (c) => {
				const principalId = c.var.principal.id;
				const {
					blobId: rawBlobId,
					sizeBytes,
					contentType,
				} = c.req.valid('json');
				const blobId = parseBlobId(rawBlobId);

				if (!blobId) {
					const err = BlobError.InvalidBlobId({ value: rawBlobId });
					return c.json(err, err.error.status);
				}
				if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
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

				const key = blobKey(principalId, blobId);
				const url = API_ROUTES.blobs.byId.url(c.var.authBaseURL, blobId);

				const { url: uploadUrl, requiredHeaders } =
					await c.var.blobStore.presignPut({
						key,
						contentType: contentType || 'application/octet-stream',
						expiresInSeconds: PUT_TTL_SECONDS,
					});

				// The ticket carries only what the uploader acts on. The PUT is
				// create-only; clients treat 412 as idempotent success for this BlobId.
				return c.json({
					url,
					uploadUrl,
					requiredHeaders,
				});
			},
		)
		// GET by id: read (302 to short-TTL presigned GET).
		.get(
			API_ROUTES.blobs.byId.pattern,
			opts.auth,
			requireBlobStore,
			describeRoute({
				description:
					'Read a blob: 302-redirect to a short-lived presigned GET URL.',
				tags: ['blobs'],
			}),
			async (c) => {
				const principalId = c.var.principal.id;
				const blobId = parseBlobId(c.req.param('blobId'));
				if (!blobId) return c.notFound();
				const key = blobKey(principalId, blobId);
				if (!(await c.var.blobStore.exists(key))) {
					const err = BlobError.NotFound();
					return c.json(err, err.error.status);
				}
				const presignedGet = await c.var.blobStore.presignGet({
					key,
					expiresInSeconds: GET_TTL_SECONDS,
				});
				return c.redirect(presignedGet, 302);
			},
		)
		// DELETE by id: principal-local, idempotent.
		.delete(
			API_ROUTES.blobs.byId.pattern,
			opts.auth,
			requireBlobStore,
			describeRoute({
				description: 'Delete a blob for the current principal.',
				tags: ['blobs'],
			}),
			async (c) => {
				const principalId = c.var.principal.id;
				const blobId = parseBlobId(c.req.param('blobId'));
				if (!blobId) return c.notFound();
				await c.var.blobStore.delete(blobKey(principalId, blobId));
				return c.body(null, 204);
			},
		);
}
