/**
 * Real Git smart HTTP for tests without binding a port: requests are answered
 * by the system `git http-backend` CGI against bare repositories on disk.
 * `git-demo-server.test-support.ts` serves the same bridge over loopback.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Native',
	GIT_AUTHOR_EMAIL: 'native@example.test',
	GIT_COMMITTER_NAME: 'Native',
	GIT_COMMITTER_EMAIL: 'native@example.test',
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: GIT_ENV,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

export async function scratch(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

/** Create `<root>/remote.git` accepting pushes over HTTP. */
export async function createBareRemote(root: string): Promise<string> {
	const bare = join(root, 'remote.git');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	await git(bare, 'config', 'http.receivepack', 'true');
	await git(bare, 'config', 'receive.denyNonFastForwards', 'true');
	return bare;
}

/**
 * Resolve the system `git http-backend` once, and return a function that
 * answers one smart HTTP request for the repository `pathInfo` names under
 * `projectRoot` (`/remote.git/info/refs`, for example).
 */
export async function gitHttpBackend(
	projectRoot: string,
): Promise<(request: Request, pathInfo: string) => Promise<Response>> {
	const backend = join(
		await git(projectRoot, '--exec-path'),
		'git-http-backend',
	);
	return async (request, pathInfo) => {
		const body =
			request.method === 'GET'
				? undefined
				: new Uint8Array(await request.arrayBuffer());
		const child = Bun.spawn([backend], {
			cwd: projectRoot,
			env: {
				...GIT_ENV,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: '1',
				PATH_INFO: pathInfo,
				REQUEST_METHOD: request.method,
				QUERY_STRING: new URL(request.url).search.slice(1),
				CONTENT_TYPE: request.headers.get('content-type') ?? '',
				CONTENT_LENGTH: String(body?.byteLength ?? 0),
				REMOTE_USER: 'test',
				REMOTE_ADDR: '127.0.0.1',
				SERVER_PROTOCOL: 'HTTP/1.1',
				GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
			},
			stdin: body ?? 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).arrayBuffer(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			return new Response(`git http-backend failed: ${err}`, { status: 500 });
		const bytes = Buffer.from(out);
		const split = bytes.indexOf('\r\n\r\n');
		if (split < 0)
			return new Response('git http-backend returned no headers', {
				status: 502,
			});
		const headers = new Headers();
		let status = 200;
		for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
			const colon = line.indexOf(':');
			const key = line.slice(0, colon);
			const value = line.slice(colon + 1).trim();
			if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
			else headers.append(key, value);
		}
		return new Response(bytes.subarray(split + 4), { status, headers });
	};
}

/**
 * A `fetch` that serves `http://git.test/<repo>.git/...` from `projectRoot`
 * through `git http-backend`, and delegates every other URL.
 */
export async function gitHttpFetch(projectRoot: string): Promise<typeof fetch> {
	const answer = await gitHttpBackend(projectRoot);
	const original = globalThis.fetch;
	const handler = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.host !== 'git.test') return original(input, init);
		return answer(request, url.pathname);
	};
	return handler as typeof fetch;
}

/** Make `directory` a repository whose `origin` is `url`, as a person would. */
export async function initWithOrigin(directory: string, url: string) {
	await mkdir(directory, { recursive: true });
	await git(directory, 'init', '--quiet', '--initial-branch=main');
	await git(directory, 'remote', 'add', 'origin', url);
}
