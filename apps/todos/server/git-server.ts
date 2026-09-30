/**
 * Loopback Git smart HTTP for the Todos demo.
 *
 * Serves one bare repository through the system `git http-backend` CGI with
 * `receive-pack` enabled, and prepares an ordinary native checkout of it.
 * Nothing here is hosted Epicenter infrastructure: there is no account,
 * credential, or external service. It binds 127.0.0.1 only.
 *
 * Run alone with `bun server/git-server.ts`, or through `bun dev:todos`.
 * `TODOS_DEMO_ROOT` reopens a directory this server created earlier.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_GIT_PORT = 5187;
const MARKER = '.epicenter-todos-demo';

const gitEnv = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: gitEnv,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
	return stdout.trim();
}

export type GitSession = {
	readonly root: string;
	readonly bare: string;
	readonly nativeCheckout: string;
	/** The URL native Git uses, served by this process. */
	readonly remoteUrl: string;
	/** The path a browser uses same-origin through the UI's proxy. */
	readonly browserRemotePath: string;
	readonly port: number;
};

async function prepareRoot(port: number): Promise<Omit<GitSession, 'port'>> {
	const reused = process.env.TODOS_DEMO_ROOT;
	const root = reused ?? (await mkdtemp(join(tmpdir(), 'epicenter-todos-')));
	if (reused && !(await Bun.file(join(root, MARKER)).exists()))
		throw new Error(
			'TODOS_DEMO_ROOT must be a directory this server created earlier.',
		);
	await writeFile(join(root, MARKER), 'Disposable Epicenter Todos demo data\n');
	const repos = join(root, 'repos');
	const bare = join(repos, 'todos.git');
	const remoteUrl = `http://127.0.0.1:${port}/git/todos.git`;
	if (!(await Bun.file(join(bare, 'HEAD')).exists())) {
		await mkdir(repos, { recursive: true });
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		await git(bare, 'config', 'http.receivepack', 'true');
		await git(bare, 'config', 'receive.denyNonFastForwards', 'true');
	}
	const nativeCheckout = join(root, 'native');
	if (!(await Bun.file(join(nativeCheckout, '.git', 'HEAD')).exists())) {
		await git(root, 'init', '--quiet', '--initial-branch=main', nativeCheckout);
		await git(nativeCheckout, 'remote', 'add', 'origin', remoteUrl);
		await git(nativeCheckout, 'config', 'branch.main.remote', 'origin');
		await git(nativeCheckout, 'config', 'branch.main.merge', 'refs/heads/main');
		await git(nativeCheckout, 'config', 'user.name', 'Native checkout');
		await git(nativeCheckout, 'config', 'user.email', 'native@localhost');
	}
	return {
		root,
		bare,
		nativeCheckout,
		remoteUrl,
		browserRemotePath: '/git/todos.git',
	};
}

/** Answer one smart HTTP request with `git http-backend`. */
async function gitHttp(
	request: Request,
	url: URL,
	projectRoot: string,
	backend: string,
) {
	const body =
		request.method === 'GET'
			? undefined
			: new Uint8Array(await request.arrayBuffer());
	const child = Bun.spawn([backend], {
		cwd: projectRoot,
		env: {
			...gitEnv,
			GIT_PROJECT_ROOT: projectRoot,
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: url.pathname.slice('/git'.length),
			REQUEST_METHOD: request.method,
			QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: request.headers.get('content-type') ?? '',
			CONTENT_LENGTH: String(body?.byteLength ?? 0),
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
}

/** Prepare (or reopen) the demo root and its session description. */
export async function prepareGitSession(
	port = DEFAULT_GIT_PORT,
): Promise<GitSession> {
	return { ...(await prepareRoot(port)), port };
}

/** The request handler: `/git/*` smart HTTP and `/session` JSON. */
export async function createGitHandler(session: GitSession) {
	const projectRoot = join(session.root, 'repos');
	const backend = join(
		await git(session.root, '--exec-path'),
		'git-http-backend',
	);
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/session') return Response.json(session);
		if (url.pathname.startsWith('/git/'))
			return gitHttp(request, url, projectRoot, backend);
		return new Response('Not found', { status: 404 });
	};
}

export async function startGitServer({
	port = DEFAULT_GIT_PORT,
}: {
	port?: number;
} = {}) {
	const session = await prepareGitSession(port);
	const handle = await createGitHandler(session);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		idleTimeout: 120,
		async fetch(request) {
			const response = await handle(request);
			const url = new URL(request.url);
			if (url.pathname.startsWith('/git/'))
				console.error(
					`${request.method} ${url.pathname}${url.search} ${response.status}`,
				);
			return response;
		},
	});
	await writeFile(
		join(session.root, 'session.json'),
		`${JSON.stringify(session, null, 2)}\n`,
	);
	return { session, stop: () => server.stop(true) };
}

if (import.meta.main) {
	const { session, stop } = await startGitServer({
		port: Number(process.env.TODOS_GIT_PORT ?? DEFAULT_GIT_PORT),
	});
	console.log(JSON.stringify(session));
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		process.on(signal, () => {
			stop();
			process.exit(0);
		});
}
