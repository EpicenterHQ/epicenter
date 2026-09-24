/** S3 adapter wire lifecycle with a disposable HTTP endpoint and signed requests. */
import { expect, test } from 'bun:test';
import { resolveDeploymentBlobStore } from './s3-blob-store.js';

test('signed S3 calls create once, read exact ranges, and delete idempotently', async () => {
	const objects = new Map<string, { bytes: Uint8Array; type: string }>();
	const methods: string[] = [];
	const endpoint = Bun.serve({
		port: 0,
		async fetch(request) {
			methods.push(request.method);
			expect(request.headers.get('authorization')).toStartWith(
				'AWS4-HMAC-SHA256 ',
			);
			const key = new URL(request.url).pathname;
			const object = objects.get(key);
			if (request.method === 'PUT') {
				expect(request.headers.get('if-none-match')).toBe('*');
				if (object) return new Response(null, { status: 412 });
				objects.set(key, {
					bytes: new Uint8Array(await request.arrayBuffer()),
					type: request.headers.get('content-type')!,
				});
				return new Response(null, { status: 200 });
			}
			if (request.method === 'DELETE') {
				objects.delete(key);
				return new Response(null, { status: 204 });
			}
			if (!object) return new Response(null, { status: 404 });
			const headers = {
				'content-type': object.type,
				'content-length': String(object.bytes.length),
				etag: '"v1"',
				'last-modified': new Date(0).toUTCString(),
			};
			if (request.method === 'HEAD') return new Response(null, { headers });
			expect(request.headers.get('if-match')).toBe('"v1"');
			const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(
				request.headers.get('range')!,
			)!;
			return new Response(object.bytes.slice(Number(start), Number(end) + 1), {
				status: 206,
				headers,
			});
		},
	});
	try {
		const store = resolveDeploymentBlobStore({
			BLOBS_S3_ENDPOINT: endpoint.url.origin,
			BLOBS_S3_ACCESS_KEY_ID: 'test',
			BLOBS_S3_SECRET_ACCESS_KEY: 'test',
		})!;
		const key = 'personal/alice/public/object';
		expect(
			await store.put(
				key,
				new Blob([new Uint8Array([0, 1, 255])], { type: 'audio/wav' }),
			),
		).toBe('created');
		expect(await store.put(key, new Blob(['replacement']))).toBe('conflict');
		const metadata = await store.head(key);
		expect(metadata).toMatchObject({
			size: 3,
			contentType: 'audio/wav',
			etag: '"v1"',
		});
		expect(await store.read(key, 1, 2, metadata!.etag)).toEqual(
			new Uint8Array([1, 255]),
		);
		await store.delete(key);
		expect(await store.head(key)).toBeNull();
		await store.delete(key);
		expect(methods).toEqual([
			'PUT',
			'PUT',
			'HEAD',
			'GET',
			'DELETE',
			'HEAD',
			'DELETE',
		]);
	} finally {
		endpoint.stop(true);
	}
});
