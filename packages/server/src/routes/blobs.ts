/** Direct, bounded byte uploads and owner-pinned authenticated reads. */
import {
	generateBlobId,
	MAX_REMOTE_BLOB_BYTES,
	parseBlobId,
	REMOTE_BLOB_ROUTES,
	selectBlobFormat,
} from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
	createS3BlobStore,
	type S3BlobStore,
	type S3BlobStoreConfig,
} from '../s3-blob-store.js';
import type { Env } from '../types.js';

type BlobEnv = {
	Bindings: Env['Bindings'];
	Variables: Env['Variables'] & { blobStore: S3BlobStore; blobPrefix: string };
};

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

export function mountBlobsApp<E extends Env = Env>(
	app: Hono<E>,
	{ auth }: { auth: MiddlewareHandler<E> },
): void {
	const admit = createMiddleware<BlobEnv>(async (c, next) => {
		const appId = c.req.param('appId');
		const owner = c.req.param('principalId');
		if (
			!appId ||
			!isAppId(appId) ||
			new URL(c.req.url).search !== '' ||
			(owner !== undefined && owner !== c.var.principal.id)
		)
			return c.text('Blob access refused', 403);
		const store = resolveDeploymentBlobStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		c.set('blobStore', store);
		c.set(
			'blobPrefix',
			`principals/${encodeURIComponent(c.var.principal.id)}/apps/${encodeURIComponent(appId)}/blobs/`,
		);
		await next();
	});
	app.post(REMOTE_BLOB_ROUTES.collection, auth, admit, async (c) => {
		// This header is a private desktop control request, never a remote upload.
		if (c.req.header('x-epicenter-local-blob-id') !== undefined)
			return c.text('Native blob source is unavailable', 400);
		const declared = c.req.header('content-length');
		if (
			declared !== undefined &&
			(!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
		)
			return c.text('Invalid content length', 400);
		if (Number(declared) > MAX_REMOTE_BLOB_BYTES)
			return c.text('Blob is too large', 413);
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		const reader = c.req.raw.body?.getReader();
		let size = 0;
		try {
			if (reader)
				while (true) {
					c.req.raw.signal.throwIfAborted();
					const next = await reader.read();
					if (next.done) break;
					size += next.value.byteLength;
					if (size > MAX_REMOTE_BLOB_BYTES) {
						await reader.cancel();
						return c.text('Blob is too large', 413);
					}
					chunks.push(new Uint8Array(next.value));
				}
		} catch {
			await reader?.cancel().catch(() => {});
			return c.text('Could not read blob body', 400);
		} finally {
			reader?.releaseLock();
		}
		if (declared !== undefined && Number(declared) !== size)
			return c.text('Incorrect content length', 400);
		const contentType =
			c.req.header('content-type') || 'application/octet-stream';
		const blobId = generateBlobId(
			selectBlobFormat({ type: contentType }).extension,
		);
		const outcome = await c.var.blobStore.put(
			c.var.blobPrefix + blobId,
			new Blob(chunks, {
				type: contentType,
			}),
			c.req.raw.signal,
		);
		if (outcome === 'conflict')
			return c.text('Could not allocate blob storage', 503);
		if (outcome === 'uncertain')
			return c.text('Publication could not be confirmed', 503);
		return c.json({ id: blobId }, 201);
	});
	app.on(['GET', 'HEAD'], REMOTE_BLOB_ROUTES.object, auth, admit, async (c) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (!id) return c.notFound();
		if (c.req.header('x-epicenter-copy-destination-app') !== undefined)
			return c.text('Native copy requires the desktop broker', 400);
		const forwarded = new Headers();
		for (const name of ['range', 'if-match', 'if-range']) {
			const value = c.req.header(name);
			if (value !== undefined) forwarded.set(name, value);
		}
		const range = forwarded.get('range');
		if (range !== null && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
			return c.text('A single byte range is required', 400);
		const response = await c.var.blobStore.get(
			c.var.blobPrefix + id,
			c.req.raw.signal,
			{ method: c.req.method === 'HEAD' ? 'HEAD' : 'GET', headers: forwarded },
		);
		if (response.status === 404) {
			await response.body?.cancel();
			return c.notFound();
		}
		if (![200, 206, 412, 416].includes(response.status)) {
			await response.body?.cancel();
			return c.text('Blob storage read failed', 502);
		}
		const headers = new Headers({
			'content-type':
				response.headers.get('content-type') || 'application/octet-stream',
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
			'content-disposition': 'attachment',
			'content-security-policy': "sandbox; default-src 'none'",
		});
		for (const name of [
			'content-length',
			'content-range',
			'accept-ranges',
			'etag',
		]) {
			const value = response.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		if (c.req.method === 'HEAD' || !response.ok) {
			await response.body?.cancel();
			if (!response.ok) headers.delete('content-length');
			return new Response(null, { status: response.status, headers });
		}
		return new Response(response.body, { status: response.status, headers });
	});
	app.delete(REMOTE_BLOB_ROUTES.object, auth, admit, async (c) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (!id) return c.notFound();
		await c.var.blobStore.delete(c.var.blobPrefix + id, c.req.raw.signal);
		return c.body(null, 204);
	});
}
