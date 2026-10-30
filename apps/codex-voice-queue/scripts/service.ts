import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { GatewayState } from '../src/lib/api-types.js';

export type ServiceDeps = {
	home: string;
	check(): Promise<void>;
	build(stagingDir: string): Promise<void>;
	restart(): Promise<void>;
	checkJob(): Promise<void>;
	fetch: typeof fetch;
	log(message: string): void;
	healthTimeoutMs: number;
	pollMs: number;
};

const appDir = resolve(import.meta.dir, '..');
const releaseLine = 'release_dir="$(cd "$app_data_dir/current" && pwd -P)"';
const staticLine = 'export STATIC_DIR="$app_data_dir/build"';
const legacyExec = /^exec (\S+) "\$app_data_dir\/server\.js"$/gm;
const manual = 'See the README rollback section for the manual procedure.';

export function wrapperState(text: string): 'legacy' | 'migrated' {
	if (
		text.split('\n').includes(releaseLine) &&
		text.includes('"$release_dir/server.js"')
	)
		return 'migrated';
	if (
		text.split('\n').filter((line) => line === staticLine).length === 1 &&
		[...text.matchAll(legacyExec)].length === 1
	)
		return 'legacy';
	throw new Error('The wrapper is unrecognized; nothing was changed.');
}

export function migrateWrapper(text: string): string {
	if (wrapperState(text) === 'migrated') return text;
	return text
		.replace(
			staticLine,
			[
				'# Resolve current once so the gateway and its static files come from one release.',
				releaseLine,
				'export STATIC_DIR="$release_dir/build"',
			].join('\n'),
		)
		.replace(legacyExec, 'exec $1 "$release_dir/server.js"');
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assessIdle(
	value: unknown,
):
	| { ok: true; bootId: GatewayState['bootId'] }
	| { ok: false; reason: string } {
	const invalid = { ok: false, reason: 'invalid state shape' } as const;
	if (
		!isObject(value) ||
		typeof value.bootId !== 'string' ||
		!value.bootId.trim() ||
		!Array.isArray(value.approvals) ||
		!isObject(value.live)
	)
		return invalid;
	let active = 0;
	for (const turn of Object.values(value.live)) {
		if (!isObject(turn) || typeof turn.status !== 'string') return invalid;
		const thread = turn.threadStatus;
		if (
			thread != null &&
			(!isObject(thread) || typeof thread.type !== 'string')
		)
			return invalid;
		if (
			(turn.status !== 'completed' &&
				turn.status !== 'interrupted' &&
				turn.status !== 'failed' &&
				turn.status !== 'inProgress') ||
			(isObject(thread) &&
				thread.type !== 'notLoaded' &&
				thread.type !== 'idle' &&
				thread.type !== 'systemError' &&
				thread.type !== 'active')
		)
			return { ok: false, reason: 'unrecognized turn or thread status' };
		if (
			turn.status === 'inProgress' ||
			(isObject(thread) && thread.type === 'active')
		)
			active++;
	}
	if (active || value.approvals.length)
		return {
			ok: false,
			reason: `${active} active turns, ${value.approvals.length} pending approvals`,
		};
	return { ok: true, bootId: value.bootId };
}

async function exists(path: string) {
	try {
		await fs.lstat(path);
		return true;
	} catch (error) {
		if (isObject(error) && error.code === 'ENOENT') return false;
		throw error;
	}
}

async function requireRelease(path: string) {
	if (
		!(await fs.stat(path)).isDirectory() ||
		!(await fs.stat(join(path, 'server.js'))).isFile() ||
		!(await fs.stat(join(path, 'build/index.html'))).isFile()
	)
		throw new Error('Release is missing server.js or build/index.html.');
}

async function releaseTarget(home: string, name: string) {
	try {
		const link = join(home, name);
		if (!(await fs.lstat(link)).isSymbolicLink()) throw new Error();
		const target = await fs.readlink(link);
		const path = await fs.realpath(link);
		const releases = await fs.realpath(join(home, 'releases'));
		if (dirname(path) !== releases || basename(path).startsWith('.'))
			throw new Error();
		await requireRelease(path);
		return { target, path };
	} catch {
		throw new Error(`Invalid ${name} release; nothing was switched. ${manual}`);
	}
}

async function setLink(home: string, name: string, target: string) {
	const temporary = join(
		home,
		`.${name}.tmp-${randomBytes(6).toString('hex')}`,
	);
	try {
		await fs.symlink(target, temporary);
		await fs.rename(temporary, join(home, name));
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function cleanLeftovers(home: string) {
	for (const name of await fs.readdir(home)) {
		if (
			/^\.(current|previous)\.tmp/.test(name) &&
			(await fs.lstat(join(home, name))).isSymbolicLink()
		)
			await fs.unlink(join(home, name));
	}
	await fs.rm(join(home, 'run-gateway.sh.new'), { force: true });
	const releases = join(home, 'releases');
	if (await exists(releases)) {
		for (const name of await fs.readdir(releases)) {
			if (name.startsWith('.staging-'))
				await fs.rm(join(releases, name), { recursive: true, force: true });
		}
	}
}

async function locked<T>(home: string, action: () => Promise<T>) {
	const path = join(home, '.update.lock');
	let lock;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			lock = await fs.open(path, 'wx', 0o600);
			break;
		} catch (error) {
			if (!isObject(error) || error.code !== 'EEXIST') throw error;
			const contents = await fs.readFile(path, 'utf8');
			const pid = /^\d+$/.test(contents.trim()) ? Number(contents.trim()) : 0;
			if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
				let alive = false;
				try {
					process.kill(pid, 0);
					alive = true;
				} catch (error) {
					alive = !isObject(error) || error.code !== 'ESRCH';
				}
				if (alive) throw new Error('another update is running');
			}
			if (attempt === 1) throw new Error('another update is running');
			await fs.unlink(path);
		}
	}
	if (!lock) throw new Error('another update is running');
	try {
		await lock.writeFile(String(process.pid));
		await cleanLeftovers(home);
		return await action();
	} finally {
		await lock.close();
		await fs.unlink(path);
	}
}

async function connection(deps: ServiceDeps, wrapper: string) {
	const ports = [...wrapper.matchAll(/^export PORT=(\d+)$/gm)];
	if (ports.length !== 1)
		throw new Error(
			'Expected exactly one export PORT=<number> in run-gateway.sh.',
		);
	const port = Number(ports[0]![1]);
	if (port < 1 || port > 65535) throw new Error('Invalid gateway port.');
	const token = (await fs.readFile(join(deps.home, 'token'), 'utf8')).replace(
		/[\r\n]+$/,
		'',
	);
	if (!token) throw new Error('Token file is empty.');
	return async (path: string, timeoutMs = 5000) => {
		try {
			return await deps.fetch(`http://127.0.0.1:${port}${path}`, {
				headers: path.startsWith('/api/')
					? { Authorization: `Bearer ${token}` }
					: {},
				signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))),
				redirect: 'error',
			});
		} catch {
			throw new Error('connection refused or request timed out');
		}
	};
}

type Request = Awaited<ReturnType<typeof connection>>;

async function readState(request: Request) {
	const response = await request('/api/state');
	if (response.status !== 200) throw new Error(`State HTTP ${response.status}`);
	try {
		return (await response.json()) as unknown;
	} catch {
		throw new Error('State response is not JSON.');
	}
}

async function requireIdle(request: Request) {
	const result = assessIdle(await readState(request));
	if (!result.ok)
		throw new Error(
			`Not updated: ${result.reason}. The running service was not changed.`,
		);
	return result.bootId;
}

async function verify(
	deps: ServiceDeps,
	request: Request,
	indexPath: string,
	oldBootId: string | undefined,
	observed: (bootId: string) => void = () => {},
) {
	const expected = await fs.readFile(indexPath, 'utf8');
	const deadline = Date.now() + deps.healthTimeoutMs;
	let condition = 'health unavailable';
	while (Date.now() < deadline) {
		try {
			const health = await request('/api/health', deadline - Date.now());
			if (health.status !== 200)
				throw new Error(`Health HTTP ${health.status}`);
			let value: unknown;
			try {
				value = await health.json();
			} catch {
				throw new Error('Health response is not JSON');
			}
			if (!isObject(value) || typeof value.bootId !== 'string' || !value.bootId)
				throw new Error('invalid health shape');
			observed(value.bootId);
			if (value.bootId === oldBootId) throw new Error('bootId unchanged');
			if (!isObject(value.appServer) || value.appServer.state !== 'ready') {
				const state = isObject(value.appServer)
					? value.appServer.state
					: undefined;
				throw new Error(
					state === 'starting' || state === 'down'
						? `app-server state ${state}`
						: 'invalid app-server state',
				);
			}
			const html = await request('/', deadline - Date.now());
			if (html.status !== 200) throw new Error(`UI HTTP ${html.status}`);
			if (!html.headers.get('content-type')?.includes('text/html'))
				throw new Error('UI content-type is not text/html');
			if ((await html.text()) !== expected)
				throw new Error('UI does not match release');
			const asset = expected.match(/\/_app\/immutable\/[^"'\s]+/)?.[0];
			if (asset) {
				const response = await request(asset, deadline - Date.now());
				if (response.status !== 200)
					throw new Error(`UI asset HTTP ${response.status}`);
				await response.body?.cancel();
			}
			return;
		} catch (error) {
			condition =
				error instanceof Error ? error.message : 'verification failed';
		}
		await Bun.sleep(Math.min(deps.pollMs, Math.max(0, deadline - Date.now())));
	}
	throw new Error(`Verification timed out: ${condition}`);
}

function childEnv() {
	const { CODEX_VOICE_QUEUE_TOKEN: _token, ...env } = process.env;
	return env;
}

async function run(cmd: string[], cwd = appDir, inherit = false) {
	const child = Bun.spawn(cmd, {
		cwd,
		env: childEnv(),
		stdout: inherit ? 'inherit' : 'ignore',
		stderr: inherit ? 'inherit' : 'ignore',
	});
	if ((await child.exited) !== 0)
		throw new Error(`${basename(cmd[0]!)} command failed.`);
}

async function gitMetadata() {
	try {
		async function git(args: string[]) {
			const child = Bun.spawn(['git', ...args], {
				cwd: appDir,
				env: childEnv(),
				stdout: 'pipe',
				stderr: 'ignore',
			});
			const output = await new Response(child.stdout).text();
			if ((await child.exited) !== 0) throw new Error();
			return output.trim();
		}
		return {
			head: await git(['rev-parse', 'HEAD']),
			dirty: (await git(['status', '--porcelain', '--', '.'])).length > 0,
		};
	} catch {
		return null;
	}
}

async function restoreWrapper(home: string) {
	const temporary = join(home, 'run-gateway.sh.new');
	await fs.copyFile(join(home, 'run-gateway.sh.pre-releases'), temporary);
	await fs.chmod(temporary, 0o700);
	await fs.rename(temporary, join(home, 'run-gateway.sh'));
}

export async function update(deps: ServiceDeps) {
	await deps.check();
	return locked(deps.home, async () => {
		const { home } = deps;
		await deps.checkJob();
		const wrapper = await fs.readFile(join(home, 'run-gateway.sh'), 'utf8');
		const state = wrapperState(wrapper);
		if (state === 'migrated') await releaseTarget(home, 'current');
		const request = await connection(deps, wrapper);
		await requireIdle(request);
		const builtAt = new Date().toISOString();
		const id = `${builtAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
		const releases = join(home, 'releases');
		const staging = join(releases, `.staging-${id}`);
		const release = join(releases, id);
		await fs.mkdir(releases, { recursive: true, mode: 0o700 });
		await fs.mkdir(staging, { mode: 0o700 });
		try {
			await deps.build(staging);
			await requireRelease(staging);
			if (await exists(join(staging, 'build/build')))
				throw new Error('Nested build/build directory found.');
			await fs.writeFile(
				join(staging, 'release.json'),
				JSON.stringify({ id, builtAt, git: await gitMetadata() }, null, '\t') +
					'\n',
			);
			await fs.rename(staging, release);
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true });
			throw error;
		}
		let migratedThisRun = false;
		let oldBootId: string;
		try {
			if (state === 'legacy') {
				await requireRelease(home);
				const legacy = join(releases, 'legacy');
				if (!(await exists(legacy))) {
					const temporary = join(releases, '.staging-legacy');
					await fs.mkdir(temporary, { mode: 0o700 });
					await fs.copyFile(
						join(home, 'server.js'),
						join(temporary, 'server.js'),
					);
					await fs.cp(join(home, 'build'), join(temporary, 'build'), {
						recursive: true,
						errorOnExist: true,
						force: false,
					});
					await fs.rename(temporary, legacy);
				}
				await requireRelease(legacy);
				await setLink(home, 'current', 'releases/legacy');
				await fs.writeFile(join(home, 'run-gateway.sh.pre-releases'), wrapper, {
					mode: 0o700,
				});
				await fs.chmod(join(home, 'run-gateway.sh.pre-releases'), 0o700);
				const temporary = join(home, 'run-gateway.sh.new');
				await fs.writeFile(temporary, migrateWrapper(wrapper), { mode: 0o700 });
				await fs.chmod(temporary, 0o700);
				await run(['zsh', '-n', temporary]);
				await fs.rename(temporary, join(home, 'run-gateway.sh'));
				migratedThisRun = true;
			}
			oldBootId = await requireIdle(request);
		} catch (error) {
			await fs.rm(release, { recursive: true, force: true });
			throw error;
		}
		const old = await releaseTarget(home, 'current');
		const previousPath = join(home, 'previous');
		const priorPrevious = (await exists(previousPath))
			? await fs.readlink(previousPath)
			: undefined;
		await setLink(home, 'previous', old.target);
		await setLink(home, 'current', `releases/${id}`);
		let failedBootId: string | undefined;
		try {
			await deps.restart();
			await verify(
				deps,
				request,
				join(release, 'build/index.html'),
				oldBootId,
				(id) => {
					failedBootId = id;
				},
			);
		} catch (error) {
			let rollbackStatus: string;
			try {
				await setLink(home, 'current', old.target);
				if (priorPrevious === undefined) await fs.unlink(previousPath);
				else await setLink(home, 'previous', priorPrevious);
				if (migratedThisRun) await restoreWrapper(home);
				await deps.restart();
				await verify(
					deps,
					request,
					join(old.path, 'build/index.html'),
					failedBootId ?? oldBootId,
				);
				rollbackStatus = 'rollback verified';
			} catch {
				rollbackStatus = `rollback did not verify. ${manual}`;
			}
			throw new Error(
				`New release failed verification (${error instanceof Error ? error.message : 'restart failed'}); ${rollbackStatus}.`,
			);
		}
		const releaseRoot = await fs.realpath(releases);
		const keep = new Set([
			await fs.realpath(join(home, 'current')),
			await fs.realpath(join(home, 'previous')),
		]);
		for (const name of await fs.readdir(releases)) {
			if (!name.startsWith('.') && !keep.has(join(releaseRoot, name)))
				await fs.rm(join(releases, name), { recursive: true, force: true });
		}
		deps.log(`Updated to ${id}; previous release ${basename(old.path)}.`);
	});
}

export async function rollback(
	deps: ServiceDeps,
	{ force = false }: { force?: boolean } = {},
) {
	return locked(deps.home, async () => {
		const { home } = deps;
		const wrapper = await fs.readFile(join(home, 'run-gateway.sh'), 'utf8');
		if (wrapperState(wrapper) !== 'migrated')
			throw new Error(`Rollback requires a migrated wrapper. ${manual}`);
		const previous = await releaseTarget(home, 'previous');
		const current = await releaseTarget(home, 'current');
		await deps.checkJob();
		const request = await connection(deps, wrapper);
		let oldBootId: string | undefined;
		if (force) {
			try {
				const value = await readState(request);
				if (isObject(value) && typeof value.bootId === 'string')
					oldBootId = value.bootId;
			} catch {
				/* A forced rollback can recover an unreachable gateway. */
			}
		} else {
			oldBootId = await requireIdle(request);
		}
		await setLink(home, 'current', previous.target);
		await setLink(home, 'previous', current.target);
		try {
			await deps.restart();
			await verify(
				deps,
				request,
				join(previous.path, 'build/index.html'),
				oldBootId,
			);
		} catch (error) {
			throw new Error(
				`Rollback failed verification (${error instanceof Error ? error.message : 'restart failed'}); current remains ${basename(previous.path)}. ${manual}`,
			);
		}
		deps.log(
			`Rolled back to ${basename(previous.path)}; previous release ${basename(current.path)}.`,
		);
	});
}

if (import.meta.main) {
	try {
		const [command, ...args] = process.argv.slice(2);
		if (
			(command !== 'update' && command !== 'rollback') ||
			(command === 'update' && args.length) ||
			(command === 'rollback' &&
				(args.length > 1 || (args.length === 1 && args[0] !== '--force')))
		)
			throw new Error('Usage: service.ts update | rollback [--force]');
		const job = `gui/${process.getuid!()}/com.braden.codex-voice-queue`;
		const deps: ServiceDeps = {
			home: resolve(
				process.env.CODEX_VOICE_QUEUE_HOME ??
					join(homedir(), 'Library/Application Support/CodexVoiceQueue'),
			),
			async check() {
				try {
					await run([process.execPath, 'run', 'typecheck'], appDir, true);
				} catch {
					throw new Error('App typecheck failed; nothing was changed.');
				}
				try {
					await run([process.execPath, 'run', 'test'], appDir, true);
				} catch {
					throw new Error('App tests failed; nothing was changed.');
				}
			},
			async build(staging) {
				await run([process.execPath, 'run', 'build'], appDir, true);
				await run(
					[
						process.execPath,
						'build',
						'server/main.ts',
						'--target=bun',
						'--outfile',
						join(staging, 'server.js'),
					],
					appDir,
					true,
				);
				await fs.cp(join(appDir, 'build'), join(staging, 'build'), {
					recursive: true,
					errorOnExist: true,
					force: false,
				});
			},
			checkJob: () => run(['launchctl', 'print', job]),
			restart: () => run(['launchctl', 'kickstart', '-k', job]),
			fetch: globalThis.fetch,
			log: console.log,
			healthTimeoutMs: 90000,
			pollMs: 1000,
		};
		if (command === 'update') await update(deps);
		else await rollback(deps, { force: args.includes('--force') });
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : 'Service command failed.',
		);
		process.exitCode = 1;
	}
}
