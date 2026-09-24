import {
	MAX_HOSTED_BLOB_BYTES,
	mintPersonalBlobUrl,
	PERSONAL_BLOB_COLLECTION,
	PERSONAL_BLOB_OBJECT,
	parsePersonalBlobPath,
	personalBlobCollectionUrl,
} from '@epicenter/blobs';
import type { Handler, Hono, MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';

export type HostedBlobStore = {
	put(
		key: string,
		body: Blob,
		signal?: AbortSignal,
	): Promise<'created' | 'conflict' | 'uncertain'>;
	head(
		key: string,
		signal?: AbortSignal,
	): Promise<{
		size: number;
		contentType: string;
		etag: string;
		lastModified: string;
	} | null>;
	read(
		key: string,
		start: number,
		end: number,
		etag: string,
		signal?: AbortSignal,
	): Promise<Uint8Array | null>;
	delete(key: string, signal?: AbortSignal): Promise<void>;
};

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
	{
		auth,
		resolveStore,
	}: {
		auth: MiddlewareHandler<E>;
		resolveStore: (env: E['Bindings']) => HostedBlobStore | null;
	},
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
		const store = resolveStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		const range = c.req.header('range') ?? null;
		if (range !== null && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
			return c.text('A single byte range is required', 400);
		let metadata: Awaited<ReturnType<HostedBlobStore['head']>>;
		try {
			metadata = await store.head(address.storageKey, c.req.raw.signal);
		} catch {
			return c.text('Blob storage read failed', 502);
		}
		if (!metadata) return c.notFound();
		const headers = new Headers({
			'content-type': metadata.contentType,
			'content-length': String(metadata.size),
			'accept-ranges': 'bytes',
			etag: metadata.etag,
			'last-modified': metadata.lastModified,
			'cache-control':
				address.visibility === 'public'
					? 'public, max-age=60'
					: 'private, no-store',
			'x-content-type-options': 'nosniff',
			'content-disposition':
				address.visibility === 'public' &&
				inlineMedia.has(
					(metadata.contentType.split(';', 1)[0] ?? '').trim().toLowerCase(),
				)
					? 'inline'
					: 'attachment',
			'content-security-policy': "sandbox; default-src 'none'",
		});
		const ifMatch = c.req.header('if-match');
		if (
			ifMatch &&
			ifMatch !== '*' &&
			!ifMatch.split(',').some((tag) => tag.trim() === metadata.etag)
		) {
			headers.delete('content-length');
			return new Response(null, { status: 412, headers });
		}
		if (c.req.method === 'HEAD') return new Response(null, { headers });
		const ifRange = c.req.header('if-range');
		const requestedRange =
			range &&
			(!ifRange ||
				(ifRange.startsWith('"') && ifRange === metadata.etag) ||
				ifRange === metadata.lastModified)
				? range
				: null;
		let start = 0;
		let end = metadata.size - 1;
		if (requestedRange) {
			const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(requestedRange)!;
			start = first ? Number(first) : Math.max(0, metadata.size - Number(last));
			end = first ? (last ? Math.min(Number(last), end) : end) : end;
			if (
				!metadata.size ||
				start >= metadata.size ||
				end < start ||
				(!first && Number(last) === 0)
			) {
				headers.delete('content-length');
				headers.set('content-range', `bytes */${metadata.size}`);
				return new Response(null, { status: 416, headers });
			}
			headers.set('content-range', `bytes ${start}-${end}/${metadata.size}`);
			headers.set('content-length', String(end - start + 1));
		}
		if (metadata.size === 0)
			return new Response(new Uint8Array(0), { headers });
		let bytes: Uint8Array | null;
		try {
			bytes = await store.read(
				address.storageKey,
				start,
				end,
				metadata.etag,
				c.req.raw.signal,
			);
		} catch {
			return c.text('Blob storage read failed', 502);
		}
		if (!bytes) return c.notFound();
		return new Response(Uint8Array.from(bytes), {
			status: requestedRange ? 206 : 200,
			headers,
		});
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
			collectionPath = new URL(
				personalBlobCollectionUrl(c.var.authBaseURL, principalId, visibility),
			).pathname;
		} catch {
			return c.notFound();
		}
		const request = new URL(c.req.url);
		if (request.pathname !== collectionPath || request.search)
			return c.notFound();
		if (c.var.principal.id !== principalId)
			return c.text('Blob access refused', 403);
		const store = resolveStore(c.env);
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
		const store = resolveStore(c.env);
		if (!store) return c.text('Blob storage is unavailable', 503);
		await store.delete(address.storageKey, c.req.raw.signal);
		return c.body(null, 204);
	};
	app.delete(PERSONAL_BLOB_OBJECT, auth, remove);
}
