/**
 * Real Git smart HTTP for tests without binding a port: requests are answered
 * by the system `git http-backend` CGI against bare repositories on disk.
 */
import { mkdtemp } from 'node:fs/promises';
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
 * A `fetch` that serves `http://git.test/<repo>.git/...` from `projectRoot`
 * through `git http-backend`, and delegates every other URL.
 */
export async function gitHttpFetch(projectRoot: string): Promise<typeof fetch> {
	const backend = join(
		await git(projectRoot, '--exec-path'),
		'git-http-backend',
	);
	const original = globalThis.fetch;
	const handler = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.host !== 'git.test') return original(input, init);
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
				PATH_INFO: url.pathname,
				REQUEST_METHOD: request.method,
				QUERY_STRING: url.search.slice(1),
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
		if (code !== 0) return new Response(err, { status: 500 });
		const bytes = new Uint8Array(out);
		const split = Buffer.from(bytes).indexOf('\r\n\r\n');
		const headers = new Headers();
		let status = 200;
		for (const line of Buffer.from(bytes.subarray(0, split))
			.toString()
			.split('\r\n')) {
			const colon = line.indexOf(':');
			const key = line.slice(0, colon);
			const value = line.slice(colon + 1).trim();
			if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
			else headers.append(key, value);
		}
		return new Response(bytes.subarray(split + 4), { status, headers });
	};
	return handler as typeof fetch;
}
