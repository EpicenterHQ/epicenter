/**
 * A minimal Git LFS server for the sync tests (spike 7's `lfs-server.ts`):
 * the batch API with basic transfer on 127.0.0.1, objects kept on disk by
 * oid, and a PUT refused unless its bytes hash to the oid. It answers no
 * locking endpoint, so git-lfs never suggests enabling locks. Every request
 * is recorded, for assertions.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LFS = { 'Content-Type': 'application/vnd.git-lfs+json' };
const OID = /^[0-9a-f]{64}$/;

export type LfsServer = {
	readonly url: string;
	readonly objects: string;
	readonly requests: string[];
	stop(): void;
};

/**
 * Answer one LFS request under any prefix (`<prefix>/objects/batch`,
 * `<prefix>/objects/<oid>`), its actions pointing back under the same prefix,
 * with objects kept in `<store>/objects`.
 */
export function lfsHandler(store: string) {
	const objects = join(store, 'objects');
	mkdirSync(objects, { recursive: true });
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const batch = /^(.*)\/objects\/batch$/.exec(url.pathname);
		if (request.method === 'POST' && batch !== null) {
			const body = (await request.json()) as {
				operation: 'upload' | 'download';
				objects: { oid: string; size: number }[];
			};
			const answered = body.objects.map(({ oid, size }) => {
				if (!OID.test(oid))
					return { oid, size, error: { code: 422, message: 'bad oid' } };
				const href = `${url.origin}${batch[1]}/objects/${oid}`;
				const stored = existsSync(join(objects, oid));
				if (body.operation === 'upload')
					return stored
						? { oid, size }
						: { oid, size, actions: { upload: { href } } };
				return stored
					? { oid, size, actions: { download: { href } } }
					: { oid, size, error: { code: 404, message: 'not found' } };
			});
			return Response.json(
				{ transfer: 'basic', objects: answered },
				{ headers: LFS },
			);
		}
		const oid = /\/objects\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
		if (oid !== undefined) {
			const path = join(objects, oid);
			if (request.method === 'PUT') {
				const bytes = new Uint8Array(await request.arrayBuffer());
				const actual = new Bun.CryptoHasher('sha256')
					.update(bytes)
					.digest('hex');
				if (actual !== oid)
					return new Response('oid mismatch', { status: 422 });
				writeFileSync(path, bytes);
				return new Response(null, { status: 200 });
			}
			if (request.method === 'GET')
				return existsSync(path)
					? new Response(Bun.file(path))
					: new Response('not found', { status: 404 });
		}
		return new Response('not found', { status: 404 });
	};
}

export function startLfsServer(store: string): LfsServer {
	const answer = lfsHandler(store);
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return answer(request);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		objects: join(store, 'objects'),
		requests,
		stop: () => server.stop(true),
	};
}
