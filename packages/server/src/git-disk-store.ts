/**
 * Hosted repositories on disk, for a Bun host (ADR-0546): each a bare
 * repository at `<root>/<repository id>.git`.
 *
 * Clone and fetch go through `git http-backend`, Git's own smart-HTTP CGI
 * program, which never serves receive-pack here: every push goes to the
 * receiver (`routes/receive.ts`), and every web write to the translator
 * (`routes/files.ts`), both through this store's `GitObjects`
 * (`createDiskObjects`). Capture receipts (`refs/epicenter/captures/*`)
 * are hidden from every client's ref advertisement (decision 50).
 *
 * Every `git` here runs under the rules ADR-0559 gives the CLI's runner,
 * adapted to a server: no hook, from the repository or anywhere else
 * (`core.hooksPath` names an empty directory the store owns); no fsmonitor;
 * no system or global configuration; an environment with nothing inherited
 * but `PATH`; and `git` found once, by absolute path. The routes authorized
 * the request before this store sees it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import {
	type GitObjects,
	type ObjectKind,
	OID,
	ZERO_OID,
} from './git/objects.js';
import { packCount } from './git/pack.js';
import type { GitHost } from './routes/git.js';

/** The refs no client is shown: capture receipts, read only by the translator. */
export const HIDDEN_REFS = 'refs/epicenter/captures';

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
		`transfer.hideRefs=${HIDDEN_REFS}`,
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

type Captured = { code: number; stdout: Buffer; stderr: string };

/** Run `git` in repository `gitDir` with `input` on stdin, capturing its output. */
function capture(
	git: string,
	gitDir: string,
	args: string[],
	noHooks: string,
	input?: Uint8Array | string,
): Promise<Captured> {
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...safety(noHooks), ...args], {
			env: cleanEnvironment({ GIT_DIR: gitDir }),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const out: Buffer[] = [];
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', reject);
		child.on('close', (code) =>
			resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }),
		);
		child.stdin.on('error', () => {});
		child.stdin.end(input ?? '');
	});
}

/**
 * One long-lived `git cat-file --batch-command` for a handle's reads: `info`
 * for an object's kind and size, then `contents` only when it is small
 * enough. Reads run one at a time, in order.
 */
function createObjectReader(git: string, gitDir: string, noHooks: string) {
	let child: ReturnType<typeof spawn> | undefined;
	let buffered = Buffer.alloc(0);
	let wake: (() => void) | undefined;
	let ended = false;
	let queue: Promise<unknown> = Promise.resolve();

	const start = () => {
		if (child) return;
		ended = false;
		child = spawn(git, [...safety(noHooks), 'cat-file', '--batch-command'], {
			env: cleanEnvironment({ GIT_DIR: gitDir }),
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		child.stdout?.on('data', (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			wake?.();
		});
		const stop = () => {
			ended = true;
			wake?.();
		};
		child.stdout?.on('close', stop);
		child.on('error', stop);
		child.stdin?.on('error', () => {});
	};
	const more = () =>
		new Promise<void>((resolve, reject) => {
			if (ended) return reject(new Error('git cat-file ended'));
			wake = () => {
				wake = undefined;
				if (ended) reject(new Error('git cat-file ended'));
				else resolve();
			};
		});
	const line = async () => {
		for (;;) {
			const newline = buffered.indexOf(10);
			if (newline >= 0) {
				const text = buffered.toString('utf8', 0, newline);
				buffered = buffered.subarray(newline + 1);
				return text;
			}
			await more();
		}
	};
	const bytes = async (count: number) => {
		while (buffered.length < count) await more();
		const out = buffered.subarray(0, count);
		buffered = buffered.subarray(count);
		return out;
	};
	const ask = async (command: string) => {
		start();
		child?.stdin?.write(`${command}\n`);
		const match = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(await line());
		if (!match) return null;
		return { kind: match[2] as ObjectKind, size: Number(match[3]) };
	};
	const read = async (oid: string, maxBytes: number) => {
		if (!OID.test(oid)) return null;
		const info = await ask(`info ${oid}`);
		if (info === null) return null;
		if (info.size > maxBytes) return { ...info, bytes: null };
		await ask(`contents ${oid}`);
		const content = new Uint8Array(await bytes(info.size));
		await bytes(1);
		return { ...info, bytes: content };
	};
	return {
		read(oid: string, maxBytes = Number.POSITIVE_INFINITY) {
			const result = queue.then(() => read(oid, maxBytes));
			queue = result.catch(() => {});
			return result;
		},
		close() {
			child?.stdin?.end();
			child?.kill();
			child = undefined;
		},
	};
}

/** A failed `update-ref --stdin` that lost a compare-and-swap, rather than failed. */
const LOST_SWAP =
	/cannot lock ref|but expected|reference already exists|unable to resolve reference/;

/**
 * The `GitObjects` port over the bare repository at `gitDir`. A write goes
 * through `index-pack` into the object store, a connectivity check
 * (`rev-list --objects --missing=error`, as receive-pack runs), then one
 * `update-ref --stdin` transaction naming every ref's old value, which Git
 * checks under the ref locks: every ref moves, or none. A pack whose refs
 * lose the race leaves only unreachable objects, which `git gc` removes.
 */
export function createDiskObjects({
	git,
	gitDir,
	noHooks,
}: {
	git: string;
	gitDir: string;
	noHooks: string;
}): GitObjects {
	const reader = createObjectReader(git, gitDir, noHooks);
	const inRepository = (args: string[], input?: Uint8Array | string) =>
		capture(git, gitDir, args, noHooks, input);
	const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';
	return {
		async refs() {
			const done = await inRepository([
				'for-each-ref',
				'--format=%(objectname) %(refname)',
			]);
			if (done.code !== 0)
				throw new Error(`git for-each-ref: ${lastLine(done.stderr)}`);
			const refs = new Map<string, string>();
			for (const row of done.stdout.toString('utf8').split('\n')) {
				const space = row.indexOf(' ');
				if (space > 0) refs.set(row.slice(space + 1), row.slice(0, space));
			}
			return refs;
		},
		read(oid, options) {
			return reader.read(oid, options?.maxBytes);
		},
		async isAncestor(ancestor, descendant) {
			if (ancestor === descendant) return true;
			const done = await inRepository([
				'merge-base',
				'--is-ancestor',
				ancestor,
				descendant,
			]);
			return done.code === 0;
		},
		async apply(updates, pack) {
			if (pack !== null && packCount(pack) > 0) {
				const indexed = await inRepository(['index-pack', '--stdin'], pack);
				if (indexed.code !== 0)
					return {
						ok: false,
						stale: false,
						reason: `pack refused: ${lastLine(indexed.stderr)}`,
					};
			}
			const tips = updates
				.map((update) => update.next)
				.filter((next) => next !== ZERO_OID);
			if (tips.length > 0) {
				const connected = await inRepository([
					'rev-list',
					'--objects',
					'--missing=error',
					'--quiet',
					...tips,
					'--not',
					'--all',
				]);
				if (connected.code !== 0)
					return {
						ok: false,
						stale: false,
						reason: `missing objects: ${lastLine(connected.stderr)}`,
					};
			}
			const script = [
				'start',
				...updates.map((u) =>
					u.next === ZERO_OID
						? `delete ${u.ref} ${u.old}`
						: `update ${u.ref} ${u.next} ${u.old}`,
				),
				'prepare',
				'commit',
				'',
			].join('\n');
			const moved = await inRepository(['update-ref', '--stdin'], script);
			if (moved.code === 0) return { ok: true };
			const reason = lastLine(moved.stderr);
			return { ok: false, stale: LOST_SWAP.test(reason), reason };
		},
		close() {
			reader.close();
		},
	};
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
export function createDiskGitHost({ root }: { root: string }): GitHost {
	const git = findGit();
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
					'http.receivepack=false',
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
		objects(id) {
			return createDiskObjects({
				git,
				gitDir: repositoryPath(root, id),
				noHooks,
			});
		},
	};
}
