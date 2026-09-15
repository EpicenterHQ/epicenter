/** Disk-backed HTTP evidence fixture, not an S3 provider conformance test. */
import { createHash } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function recordingObjectFixture(directory, browserOrigin) {
	const objects = new Map();
	const requests = [];
	let missingGets = 0;
	const server = Bun.serve({
		hostname: 'localhost',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const headers = {
				'access-control-allow-origin': browserOrigin,
				'access-control-allow-methods': 'GET, PUT, HEAD, OPTIONS',
				'access-control-allow-headers':
					'content-type, if-none-match, x-amz-checksum-sha256',
			};
			const response = (body, status, extra = {}) =>
				new Response(body, { status, headers: { ...headers, ...extra } });
			if (request.method === 'OPTIONS') return response(null, 204);
			requests.push({ method: request.method, path: url.pathname });
			if (
				!url.searchParams.has('X-Amz-Signature') &&
				!request.headers.has('authorization')
			)
				return response(null, 403);
			const key = createHash('sha256').update(url.pathname).digest('hex');
			const path = join(directory, key);
			if (request.method === 'PUT') {
				if (request.headers.get('if-none-match') !== '*')
					return response(null, 400);
				const temporary = join(directory, crypto.randomUUID());
				const writer = Bun.file(temporary).writer();
				const hash = createHash('sha256');
				const reader = request.body.getReader();
				try {
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						hash.update(part.value);
						writer.write(part.value);
						await writer.flush();
					}
					await writer.end();
					if (
						hash.digest('base64') !==
						request.headers.get('x-amz-checksum-sha256')
					)
						return response(null, 400);
					try {
						await link(temporary, path);
					} catch (error) {
						if (error.code === 'EEXIST') return response(null, 412);
						throw error;
					}
					objects.set(key, request.headers.get('content-type'));
					return response(null, 200);
				} finally {
					reader.releaseLock();
					await unlink(temporary).catch(() => {});
				}
			}
			if (!objects.has(key)) return response(null, 404);
			if (request.method === 'GET' && missingGets > 0) {
				missingGets--;
				return response(null, 404);
			}
			return response(request.method === 'HEAD' ? null : Bun.file(path), 200, {
				'content-type': objects.get(key),
				'content-length': String(Bun.file(path).size),
			});
		},
	});
	return {
		server,
		requests,
		delayGets(count) {
			missingGets = count;
		},
	};
}
