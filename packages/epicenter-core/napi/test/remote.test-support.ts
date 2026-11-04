/**
 * A Git remote over HTTP, served by `Bun.serve` in the test's own process:
 * smart HTTP through stock `git http-backend` (CGI), and the Git LFS batch
 * API with the basic transfer, both under `<origin>/<name>.git`, both
 * requiring `Authorization: Bearer <token>`. Every request is recorded with
 * whether it carried the token. The Rust suite's `tests/common/http.rs` is
 * the same server.
 *
 * It runs on the JavaScript thread a round's caller awaits on, so a round
 * that blocked that thread could never be answered.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LFS = { 'content-type': 'application/vnd.git-lfs+json' };
const OID = /^[0-9a-f]{64}$/;

export type TestRemote = {
	readonly url: string;
	readonly objects: string;
	readonly requests: { line: string; authorized: boolean }[];
	stop(): void;
};

export function startRemote(root: string, token: string): TestRemote {
	const objects = join(root, 'lfs-objects');
	mkdirSync(objects, { recursive: true });
	const requests: TestRemote['requests'] = [];

	async function lfs(request: Request, url: URL, repo: string) {
		if (url.pathname.endsWith('/info/lfs/objects/batch')) {
			const body = (await request.json()) as {
				operation: 'upload' | 'download';
				objects: { oid: string; size: number }[];
			};
			const answered = body.objects.map(({ oid, size }) => {
				if (!OID.test(oid))
					return { oid, size, error: { code: 422, message: 'bad oid' } };
				const href = `${url.origin}/${repo}/info/lfs/objects/${oid}`;
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
		const oid = /\/info\/lfs\/objects\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
		if (oid === undefined) return new Response('not found', { status: 404 });
		const path = join(objects, oid);
		if (request.method === 'PUT') {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
			if (actual !== oid) return new Response('oid mismatch', { status: 422 });
			writeFileSync(path, bytes);
			return new Response(null, { status: 200 });
		}
		return existsSync(path)
			? new Response(Bun.file(path))
			: new Response('not found', { status: 404 });
	}

	/** Smart HTTP through `git http-backend`, as CGI. */
	async function git(request: Request, url: URL) {
		const body = new Uint8Array(await request.arrayBuffer());
		const proc = Bun.spawn(['git', 'http-backend'], {
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: '1',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				// A signed-in user: http-backend enables receive-pack for one.
				REMOTE_USER: 'tester',
				REMOTE_ADDR: '127.0.0.1',
				REQUEST_METHOD: request.method,
				PATH_INFO: decodeURIComponent(url.pathname),
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: request.headers.get('content-type') ?? '',
				CONTENT_LENGTH: String(body.length),
			},
			stdin: body,
			stdout: 'pipe',
			stderr: 'ignore',
		});
		const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
		await proc.exited;
		let split = -1;
		for (let i = 0; i + 3 < out.length; i++)
			if (
				out[i] === 13 &&
				out[i + 1] === 10 &&
				out[i + 2] === 13 &&
				out[i + 3] === 10
			) {
				split = i;
				break;
			}
		const head = new TextDecoder().decode(out.slice(0, split));
		const headers = new Headers();
		let status = 200;
		for (const line of head.split('\r\n')) {
			const colon = line.indexOf(':');
			const [name, value] = [
				line.slice(0, colon),
				line.slice(colon + 1).trim(),
			];
			if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
			else headers.set(name, value);
		}
		return new Response(out.slice(split + 4), { status, headers });
	}

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const authorized =
				request.headers.get('authorization') === `Bearer ${token}`;
			requests.push({
				line: `${request.method} ${url.pathname}${url.search}`,
				authorized,
			});
			if (!authorized)
				return new Response('a bearer token is required', { status: 403 });
			const repo = url.pathname.split('/')[1] ?? '';
			if (url.pathname.includes('/info/lfs/')) return lfs(request, url, repo);
			return git(request, url);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		objects,
		requests,
		stop: () => server.stop(true),
	};
}
