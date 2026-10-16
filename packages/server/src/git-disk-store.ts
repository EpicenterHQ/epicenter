/**
 * Hosted repositories on disk, for a Bun host (ADR-0546): each a bare
 * repository at `<root>/<repository id>.git`, served through
 * `git http-backend`, Git's own smart-HTTP CGI program.
 *
 * Every `git` here runs under the rules ADR-0559 gives the CLI's runner,
 * adapted to a server: no hook, from the repository or anywhere else
 * (`core.hooksPath` names an empty directory the store owns); no fsmonitor;
 * no system or global configuration; an environment with nothing inherited
 * but `PATH`; and `git` found once, by absolute path. The routes authorized
 * the request before this store sees it, so `http-backend` enables
 * receive-pack only for a push, and every repository refuses a push that is
 * not a fast-forward or deletes a branch: unrelated history to an existing
 * name is refused here, whatever the client was told to force.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import type { GitHost } from './routes/git.js';

/** Where `id`'s bare repository lives under `root`. */
export function repositoryPath(root: string, id: string): string {
	if (!/^[a-z0-9]{16}$/.test(id))
		throw new Error(`'${id}' is not a repository id`);
	return join(root, `${id}.git`);
}

/** The first `git` on `PATH` that runs, by absolute path. */
function findGit(): string {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (directory === '') continue;
		const candidate = join(directory, 'git');
		try {
			if (
				statSync(candidate).isFile() &&
				spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0
			)
				return candidate;
		} catch {}
	}
	throw new Error('git is not installed on this server');
}

/** Git configuration every command here runs with. */
function safety(noHooks: string): string[] {
	return [
		'-c',
		`core.hooksPath=${noHooks}`,
		'-c',
		'core.fsmonitor=false',
		'-c',
		'receive.denyNonFastForwards=true',
		'-c',
		'receive.denyDeletes=true',
	];
}

/** An environment that inherits nothing from this process but `PATH`. */
function cleanEnvironment(extra: Record<string, string> = {}) {
	// Cast: a deployment may augment `ProcessEnv` with its own required keys.
	return {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_TERMINAL_PROMPT: '0',
		HOME: '/nonexistent',
		LC_ALL: 'C',
		...extra,
	} as unknown as NodeJS.ProcessEnv;
}

function run(git: string, args: string[], noHooks: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...safety(noHooks), ...args], {
			env: cleanEnvironment(),
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`)),
		);
	});
}

/** Read CGI headers off the front of `stdout`, then stream the rest as the body. */
async function cgiResponse(
	stdout: Readable,
	signal: AbortSignal,
): Promise<Response> {
	const reader = Readable.toWeb(
		stdout,
	).getReader() as ReadableStreamDefaultReader<Uint8Array>;
	let buffered = new Uint8Array(0);
	let end = -1;
	while (end === -1) {
		const { done, value } = await reader.read();
		if (done) throw new Error('git http-backend ended before its headers');
		const next = new Uint8Array(buffered.length + value.length);
		next.set(buffered);
		next.set(value, buffered.length);
		buffered = next;
		for (let i = 0; i + 3 < buffered.length; i++)
			if (
				buffered[i] === 13 &&
				buffered[i + 1] === 10 &&
				buffered[i + 2] === 13 &&
				buffered[i + 3] === 10
			) {
				end = i;
				break;
			}
		if (end === -1 && buffered.length > 64 * 1024)
			throw new Error('git http-backend sent no end to its headers');
	}
	const head = new TextDecoder().decode(buffered.subarray(0, end));
	const rest = buffered.subarray(end + 4);
	const headers = new Headers();
	let status = 200;
	for (const line of head.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status')
			status = Number.parseInt(value, 10) || 500;
		else headers.append(name, value);
	}
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (rest.length > 0) controller.enqueue(rest);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	signal.throwIfAborted();
	return new Response(status === 204 || status === 304 ? null : body, {
		status,
		headers,
	});
}

/**
 * The disk store over `root`, which it creates when missing. Throws when
 * this server has no `git`.
 */
export function createDiskGitHost({
	root,
	git = findGit(),
}: {
	root: string;
	git?: string;
}): GitHost {
	const noHooks = join(root, '.no-hooks');
	let ready: Promise<void> | undefined;
	const prepare = () => {
		ready ??= (async () => {
			await mkdir(noHooks, { recursive: true });
			if ((await readdir(noHooks)).length > 0)
				throw new Error(
					`'${noHooks}' must be an empty directory, because every Git command looks for hooks there`,
				);
		})();
		return ready;
	};
	return {
		async create(id) {
			await prepare();
			const path = repositoryPath(root, id);
			if (existsSync(join(path, 'HEAD'))) return;
			await run(
				git,
				['init', '--quiet', '--bare', '--initial-branch=main', path],
				noHooks,
			);
		},
		async delete(id) {
			await rm(repositoryPath(root, id), { recursive: true, force: true });
		},
		async serve(id, request) {
			await prepare();
			const path = repositoryPath(root, id);
			if (!existsSync(join(path, 'HEAD')))
				throw new Error(`repository ${id} has no storage`);
			const pathInfo = `/${id}.git/${request.advertisement ? 'info/refs' : request.service}`;
			const push = request.service === 'git-receive-pack';
			const env: Record<string, string> = {
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: '1',
				PATH_INFO: pathInfo,
				REQUEST_METHOD: request.advertisement ? 'GET' : 'POST',
				QUERY_STRING: request.advertisement ? `service=${request.service}` : '',
				REMOTE_USER: request.accountId,
				REMOTE_ADDR: '127.0.0.1',
			};
			const contentType = request.headers.get('content-type');
			if (contentType) env.CONTENT_TYPE = contentType;
			const encoding = request.headers.get('content-encoding');
			if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
			const protocol = request.headers.get('git-protocol');
			if (protocol) env.GIT_PROTOCOL = protocol;
			const child = spawn(
				git,
				[
					...safety(noHooks),
					'-c',
					`http.receivepack=${push}`,
					'-c',
					'http.uploadpack=true',
					'-c',
					'http.getanyfile=false',
					'http-backend',
				],
				{
					env: cleanEnvironment(env),
					stdio: ['pipe', 'pipe', 'pipe'],
				},
			);
			const abort = () => child.kill('SIGKILL');
			request.signal.addEventListener('abort', abort, { once: true });
			child.on('close', () =>
				request.signal.removeEventListener('abort', abort),
			);
			child.stderr.resume();
			child.stdin.on('error', () => {});
			if (request.body === null) child.stdin.end();
			else
				Readable.fromWeb(
					request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
				)
					.on('error', () => child.stdin.end())
					.pipe(child.stdin);
			const spawned = new Promise<void>((resolve, reject) => {
				child.once('spawn', resolve);
				child.once('error', reject);
			});
			await spawned;
			return cgiResponse(child.stdout, request.signal);
		},
	};
}
