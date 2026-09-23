import {
	mintPersonalBlobUrl,
	MAX_HOSTED_BLOB_BYTES,
	PERSONAL_BLOB_COLLECTION,
	PERSONAL_BLOB_OBJECT,
	parsePersonalBlobPath,
	personalBlobCollectionUrl,
} from '@epicenter/blobs';
import type { Handler, Hono, MiddlewareHandler } from 'hono';
import { resolveDeploymentBlobStore } from '../s3-blob-store.js';
import type { Env } from '../types.js';

const inlineMedia = new Set([
	'audio/mpeg',
	'audio/mp4',
	'audio/wav',
	'audio/webm',
	'audio/ogg',
	'video/mp4',
	'video/webm',
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
]);

/** Personal objects have no application or row namespace in their identity. */
export function mountPersonalAuthorityBlobs<E extends Env>(
	app: Hono<E>,
	{ auth }: { auth: MiddlewareHandler<E> },
): void {
	const read: Handler<Env> = async (c) => {
		const request = new URL(c.req.url);
		if (request.search) return c.notFound();
		const address = parsePersonalBlobPath(request.pathname);
		if (!address) return c.notFound();
		if (
			address.visibility === 'private' &&
			c.var.principal?.id !== address.principalId
		)
			return c.text('Blob access refused', 403);
		const store = resolveDeploymentBlobStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		const forwarded = new Headers();
		for (const name of ['range', 'if-match']) {
			const value = c.req.header(name);
			if (value !== undefined) forwarded.set(name, value);
		}
		const range = forwarded.get('range');
		if (range !== null && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
			return c.text('A single byte range is required', 400);
		if (c.req.method === 'HEAD') forwarded.delete('range');
		const ifRange = c.req.header('if-range');
		if (c.req.method === 'GET' && range !== null && ifRange !== undefined) {
			const metadata = await store.get(address.storageKey, c.req.raw.signal, {
				method: 'HEAD',
				headers: new Headers(),
			});
			if (metadata.status === 404) {
				await metadata.body?.cancel();
				return c.notFound();
			}
			if (metadata.status !== 200) {
				await metadata.body?.cancel();
				return c.text('Blob storage read failed', 502);
			}
			const etag = metadata.headers.get('etag');
			const lastModified = metadata.headers.get('last-modified');
			await metadata.body?.cancel();
			const matches =
				(ifRange.startsWith('"') && etag === ifRange) ||
				(lastModified !== null && lastModified === ifRange);
			if (!matches) forwarded.delete('range');
		}
		const response = await store.get(address.storageKey, c.req.raw.signal, {
			method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
			headers: forwarded,
		});
		if (response.status === 404) {
			await response.body?.cancel();
			return c.notFound();
		}
		if (![200, 206, 412, 416].includes(response.status)) {
			await response.body?.cancel();
			return c.text('Blob storage read failed', 502);
		}
		const contentType =
			response.headers.get('content-type') || 'application/octet-stream';
		const safeMedia = inlineMedia.has(
			(contentType.split(';', 1)[0] ?? '').trim().toLowerCase(),
		);
		const headers = new Headers({
			'content-type': contentType,
			'cache-control':
				address.visibility === 'public'
					? 'public, max-age=60'
					: 'private, no-store',
			'x-content-type-options': 'nosniff',
			'content-disposition':
				address.visibility === 'public' && safeMedia ? 'inline' : 'attachment',
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
	};

	const publicObject = PERSONAL_BLOB_OBJECT.replace(':visibility', 'public');
	const privateObject = PERSONAL_BLOB_OBJECT.replace(':visibility', 'private');
	app.on(['GET', 'HEAD'], publicObject, read);
	app.on(['GET', 'HEAD'], privateObject, auth, read);

	const publish: Handler<Env> = async (c) => {
		const principalId = c.req.param('principalId');
		const visibility = c.req.param('visibility');
		if (!principalId || (visibility !== 'private' && visibility !== 'public'))
			return c.notFound();
		let collectionPath: string;
		try {
			collectionPath = new URL(personalBlobCollectionUrl(
				c.var.authBaseURL,
				principalId,
				visibility,
			)).pathname;
		} catch {
			return c.notFound();
		}
		const request = new URL(c.req.url);
		if (request.pathname !== collectionPath || request.search) return c.notFound();
		if (c.var.principal.id !== principalId)
			return c.text('Blob access refused', 403);
		const store = resolveDeploymentBlobStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		const declared = c.req.header('content-length');
		if (
			declared !== undefined &&
			(!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
		)
			return c.text('Invalid content length', 400);
		if (Number(declared) > MAX_HOSTED_BLOB_BYTES)
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
					if (size > MAX_HOSTED_BLOB_BYTES) {
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
		const url = mintPersonalBlobUrl(c.var.authBaseURL, principalId, visibility);
		const address = parsePersonalBlobPath(new URL(url).pathname);
		if (!address) throw new Error('Minted Personal blob URL was invalid');
		const outcome = await store.put(
			address.storageKey,
			new Blob(chunks, { type: contentType }),
			c.req.raw.signal,
		);
		if (outcome === 'conflict')
			return c.text('Could not allocate blob storage', 503);
		if (outcome === 'uncertain')
			return c.text('Publication could not be confirmed', 503);
		return c.json({ url }, 201);
	};
	app.post(PERSONAL_BLOB_COLLECTION, auth, publish);

	const remove: Handler<Env> = async (c) => {
		const request = new URL(c.req.url);
		if (request.search) return c.notFound();
		const address = parsePersonalBlobPath(request.pathname);
		if (!address) return c.notFound();
		if (c.var.principal.id !== address.principalId)
			return c.text('Blob access refused', 403);
		const store = resolveDeploymentBlobStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		await store.delete(address.storageKey, c.req.raw.signal);
		return c.body(null, 204);
	};
	app.delete(PERSONAL_BLOB_OBJECT, auth, remove);
}
