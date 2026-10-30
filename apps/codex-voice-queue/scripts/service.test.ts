/**
 * Service release tests exercise update and rollback against a temporary install
 * and an authenticated in-process gateway. They cover pinned static files, migration,
 * fail-closed idle checks, interrupted runs, and recovery after a failed restart.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	assessIdle,
	migrateWrapper,
	rollback,
	type ServiceDeps,
	update,
	wrapperState,
} from './service.js';

const token = 'a'.repeat(64);
const legacyWrapper = `#!/bin/zsh
set -euo pipefail

app_data_dir="$HOME/Library/Application Support/CodexVoiceQueue"
export PATH="/Users/braden/.local/bin:/Users/braden/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin"
export CODEX_VOICE_QUEUE_TOKEN="$(<"$app_data_dir/token")"
export CODEX_BIN="/Users/braden/.local/bin/codex"
export WHISPER_CLI="/opt/homebrew/bin/whisper-cli"
export FFMPEG="/opt/homebrew/bin/ffmpeg"
export WHISPER_MODEL="$HOME/Library/Application Support/com.bradenwong.whispering/models/whisper/ggml-small.bin"
export STATIC_DIR="$app_data_dir/build"
export PORT=5190

exec /Users/braden/.bun/bin/bun "$app_data_dir/server.js"
`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function files(directory: string, marker: string) {
	await fs.mkdir(join(directory, 'build/_app/immutable'), { recursive: true });
	await fs.writeFile(join(directory, 'server.js'), `// ${marker}\n`);
	await fs.writeFile(
		join(directory, 'build/index.html'),
		`<html>${marker}<script src="/_app/immutable/entry.js"></script></html>`,
	);
	await fs.writeFile(
		join(directory, 'build/_app/immutable/entry.js'),
		`// ${marker}\n`,
	);
}

async function fixture() {
	const home = await fs.mkdtemp(join(tmpdir(), 'voice-service-'));
	cleanups.push(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});
	const control = {
		checks: 0,
		checkError: false,
		restarts: 0,
		builds: 0,
		stateReads: 0,
		state: { bootId: 'boot-0', live: {}, approvals: [] } as unknown,
		stateStatus: 200,
		healthState: 'ready',
		failNew: false,
		failAll: false,
		failRestart: false,
		unchangedBoot: false,
		wrongHtml: false,
		assetStatus: 200,
		busyAfterBuild: false,
		badJson: false,
		buildError: false,
		nestedBuild: false,
	};
	let bootId = 'boot-0';
	let pinned = join(home, 'build');
	await files(home, 'legacy');
	await fs.writeFile(join(home, 'token'), token + '\n', { mode: 0o600 });
	const handler = async (request: Request) => {
		const path = new URL(request.url).pathname;
		if (
			path.startsWith('/api/') &&
			request.headers.get('authorization') !== `Bearer ${token}`
		)
			return new Response('', { status: 401 });
		if (path === '/api/state') {
			control.stateReads++;
			if (control.badJson) return new Response('not JSON');
			const state =
				control.busyAfterBuild && control.builds > 0
					? {
							bootId,
							live: { secret: { status: 'inProgress' } },
							approvals: [],
						}
					: control.state;
			return Response.json(state, { status: control.stateStatus });
		}
		if (path === '/api/health')
			return Response.json({
				bootId,
				appServer: {
					state:
						control.failAll ||
						(control.failNew &&
							(await fs.readFile(join(pinned, 'index.html'), 'utf8')).includes(
								`>release-${control.builds}<`,
							))
							? 'starting'
							: control.healthState,
				},
			});
		if (path === '/')
			return new Response(
				control.wrongHtml
					? 'wrong release'
					: await fs.readFile(join(pinned, 'index.html')),
				{ headers: { 'content-type': 'text/html' } },
			);
		if (path === '/_app/immutable/entry.js')
			return new Response(
				await fs.readFile(join(pinned, '_app/immutable/entry.js')),
				{ status: control.assetStatus },
			);
		return new Response('', { status: 404 });
	};
	const original = legacyWrapper;
	await fs.writeFile(join(home, 'run-gateway.sh'), original, { mode: 0o700 });
	const logs: string[] = [];
	const deps: ServiceDeps = {
		home,
		async check() {
			control.checks++;
			if (control.checkError) throw new Error('source checks failed');
		},
		async build(staging) {
			control.builds++;
			await files(staging, `release-${control.builds}`);
			if (control.nestedBuild) await fs.mkdir(join(staging, 'build/build'));
			if (control.buildError) throw new Error('build failed');
		},
		async restart() {
			control.restarts++;
			if (control.failRestart && control.restarts === 1)
				throw new Error('restart failed');
			if (!control.unchangedBoot) bootId = `boot-${control.restarts}`;
			const text = await fs.readFile(join(home, 'run-gateway.sh'), 'utf8');
			pinned =
				wrapperState(text) === 'migrated'
					? join(await fs.realpath(join(home, 'current')), 'build')
					: join(home, 'build');
			control.state = { bootId, live: {}, approvals: [] };
		},
		async checkJob() {},
		fetch: ((input, init) =>
			handler(
				input instanceof Request
					? new Request(input, init)
					: new Request(String(input), init),
			)) as typeof fetch,
		log: (message) => {
			logs.push(message);
		},
		healthTimeoutMs: 100,
		pollMs: 5,
	};
	return {
		home,
		deps,
		control,
		logs,
		original,
		readIndex: () => handler(new Request('http://127.0.0.1:5190/')),
	};
}

async function target(home: string, link = 'current') {
	return await fs.readlink(join(home, link));
}

async function releases(home: string) {
	try {
		return (await fs.readdir(join(home, 'releases'))).sort();
	} catch {
		return [];
	}
}

// Migration and release retention

test('first update migrates the wrapper and keeps the original install and token', async () => {
	const f = await fixture();
	await update(f.deps);
	expect(f.control.checks).toBe(1);
	const current = await target(f.home);
	expect(current).toMatch(/^releases\/\d{8}T\d{6}Z-[a-f0-9]{6}$/);
	expect(await target(f.home, 'previous')).toBe('releases/legacy');
	expect(
		await fs.readFile(join(f.home, 'releases/legacy/server.js'), 'utf8'),
	).toBe('// legacy\n');
	expect(await fs.readFile(join(f.home, 'server.js'), 'utf8')).toBe(
		'// legacy\n',
	);
	expect(await fs.readFile(join(f.home, 'build/index.html'), 'utf8')).toContain(
		'legacy',
	);
	expect(
		await fs.readFile(join(f.home, 'run-gateway.sh.pre-releases'), 'utf8'),
	).toBe(f.original);
	const migrated = await fs.readFile(join(f.home, 'run-gateway.sh'), 'utf8');
	expect(wrapperState(migrated)).toBe('migrated');
	expect((await fs.stat(join(f.home, 'run-gateway.sh'))).mode & 0o777).toBe(
		0o700,
	);
	expect(
		(await fs.stat(join(f.home, 'run-gateway.sh.pre-releases'))).mode & 0o777,
	).toBe(0o700);
	const syntax = Bun.spawn(['zsh', '-n', join(f.home, 'run-gateway.sh')], {
		stdout: 'ignore',
		stderr: 'ignore',
	});
	expect(await syntax.exited).toBe(0);
	expect(await (await f.readIndex()).text()).toContain('release-1');
	expect(await fs.readFile(join(f.home, 'token'), 'utf8')).toBe(token + '\n');
	expect(f.logs.join('\n')).not.toContain(token);
	expect(f.control.restarts).toBe(1);
	const metadata = await Bun.file(join(f.home, current, 'release.json')).json();
	expect(metadata.id).toBe(basename(current));
	expect(metadata.builtAt).toBeString();
});

test('second update keeps only current and previous and never nests build directories', async () => {
	const f = await fixture();
	await update(f.deps);
	const first = await target(f.home);
	await update(f.deps);
	expect(await target(f.home, 'previous')).toBe(first);
	expect(await releases(f.home)).toEqual(
		[basename(first), basename(await target(f.home))].sort(),
	);
	for (const name of await releases(f.home))
		expect(await fs.exists(join(f.home, 'releases', name, 'build/build'))).toBe(
			false,
		);
	expect(await (await f.readIndex()).text()).toContain('release-2');
});

// Idle checks and staging failures

test('failed source checks reject update before touching the install or service', async () => {
	const f = await fixture();
	f.control.checkError = true;
	await expect(update(f.deps)).rejects.toThrow('source checks failed');
	expect(f.control.checks).toBe(1);
	expect(f.control.stateReads).toBe(0);
	expect(f.control.builds).toBe(0);
	expect(f.control.restarts).toBe(0);
	expect(await fs.exists(join(f.home, '.update.lock'))).toBe(false);
	expect(await fs.exists(join(f.home, 'releases'))).toBe(false);
	expect(await fs.readFile(join(f.home, 'run-gateway.sh'), 'utf8')).toBe(
		f.original,
	);
});

test('update refuses an unrecognized status before building', async () => {
	const f = await fixture();
	f.control.state = {
		bootId: 'b',
		live: { private: { status: 'queued' } },
		approvals: [],
	};
	await expect(update(f.deps)).rejects.toThrow(
		'unrecognized turn or thread status',
	);
	expect(f.control.builds).toBe(0);
	expect(f.control.restarts).toBe(0);
	expect(await fs.exists(join(f.home, 'releases'))).toBe(false);
});

for (const [name, state] of [
	[
		'in-progress turn',
		{ bootId: 'b', live: { secret: { status: 'inProgress' } }, approvals: [] },
	],
	[
		'pending approval',
		{ bootId: 'b', live: {}, approvals: [{ command: 'secret' }] },
	],
	[
		'active thread',
		{
			bootId: 'b',
			live: {
				secret: { status: 'completed', threadStatus: { type: 'active' } },
			},
			approvals: [],
		},
	],
] as const) {
	test(`update refuses ${name} before building`, async () => {
		const f = await fixture();
		await update(f.deps);
		const before = await target(f.home);
		const count = await releases(f.home);
		f.control.state = state;
		await expect(update(f.deps)).rejects.toThrow(
			'The running service was not changed',
		);
		expect(f.control.restarts).toBe(1);
		expect(f.control.builds).toBe(1);
		expect(await target(f.home)).toBe(before);
		expect(await releases(f.home)).toEqual(count);
	});
}

for (const kind of ['missing live', 'HTTP 500', 'non-JSON'] as const) {
	test(`update fails closed on ${kind}`, async () => {
		const f = await fixture();
		if (kind === 'missing live')
			f.control.state = { bootId: 'b', approvals: [] };
		if (kind === 'HTTP 500') f.control.stateStatus = 500;
		if (kind === 'non-JSON') f.control.badJson = true;
		await expect(update(f.deps)).rejects.toThrow();
		expect(f.control.restarts).toBe(0);
		expect(f.control.builds).toBe(0);
		expect(await releases(f.home)).toEqual([]);
	});
}

test('authoritative idle check removes the unused release and preserves the running process', async () => {
	const f = await fixture();
	f.control.busyAfterBuild = true;
	await expect(update(f.deps)).rejects.toThrow(
		'1 active turns, 0 pending approvals',
	);
	expect(f.control.stateReads).toBe(2);
	expect(f.control.restarts).toBe(0);
	expect(await target(f.home)).toBe('releases/legacy');
	expect(await releases(f.home)).toEqual(['legacy']);
	expect(
		wrapperState(await fs.readFile(join(f.home, 'run-gateway.sh'), 'utf8')),
	).toBe('migrated');
	expect(await (await f.readIndex()).text()).toContain('legacy');
});

for (const kind of ['buildError', 'nestedBuild'] as const) {
	test(`${kind} cleans staging without restarting or changing current`, async () => {
		const f = await fixture();
		await update(f.deps);
		const before = await target(f.home);
		const count = await releases(f.home);
		f.control[kind] = true;
		await expect(update(f.deps)).rejects.toThrow();
		expect(await target(f.home)).toBe(before);
		expect(await releases(f.home)).toEqual(count);
		expect(f.control.restarts).toBe(1);
	});
}

test('migration failure removes the new release without restarting', async () => {
	const f = await fixture();
	await fs.unlink(join(f.home, 'server.js'));
	await expect(update(f.deps)).rejects.toThrow();
	expect(await releases(f.home)).toEqual([]);
	expect(await fs.readFile(join(f.home, 'run-gateway.sh'), 'utf8')).toBe(
		f.original,
	);
	expect(f.control.restarts).toBe(0);
});

test('interrupted staging, wrapper, temporary links and stale lock are cleaned', async () => {
	const f = await fixture();
	await fs.mkdir(join(f.home, 'releases/.staging-x'), { recursive: true });
	await fs.writeFile(join(f.home, 'run-gateway.sh.new'), 'partial');
	await fs.writeFile(join(f.home, '.update.lock'), 'invalid pid');
	await fs.symlink('missing', join(f.home, '.current.tmp-stale'));
	await fs.symlink('missing', join(f.home, '.previous.tmp-stale'));
	await update(f.deps);
	expect((await releases(f.home)).some((name) => name.startsWith('.'))).toBe(
		false,
	);
	expect(await fs.readdir(f.home)).not.toContain('run-gateway.sh.new');
	expect(
		(await fs.readdir(f.home)).filter((name) => name.startsWith('.')),
	).toEqual([]);
});

test('live pid lock rejects the update without touching leftovers', async () => {
	const f = await fixture();
	await fs.writeFile(join(f.home, '.update.lock'), String(process.pid));
	await fs.writeFile(join(f.home, 'run-gateway.sh.new'), 'keep');
	await expect(update(f.deps)).rejects.toThrow('another update is running');
	expect(await fs.readFile(join(f.home, '.update.lock'), 'utf8')).toBe(
		String(process.pid),
	);
	expect(await fs.readFile(join(f.home, 'run-gateway.sh.new'), 'utf8')).toBe(
		'keep',
	);
	expect(f.control.builds).toBe(0);
});

test('broken current and unrecognized wrappers fail before building', async () => {
	const f = await fixture();
	await fs.writeFile(
		join(f.home, 'run-gateway.sh'),
		migrateWrapper(f.original),
	);
	await fs.symlink('releases/missing', join(f.home, 'current'));
	await expect(update(f.deps)).rejects.toThrow('Invalid current');
	await fs.writeFile(join(f.home, 'run-gateway.sh'), 'unknown');
	await expect(update(f.deps)).rejects.toThrow('unrecognized');
	expect(f.control.builds).toBe(0);
	expect(f.control.restarts).toBe(0);
});

// Verification and rollback

for (const failure of ['failNew', 'failRestart'] as const) {
	test(`${failure} on the migration run restores the legacy wrapper and verifies rollback`, async () => {
		const f = await fixture();
		f.control[failure] = true;
		await expect(update(f.deps)).rejects.toThrow('rollback verified');
		expect(f.control.restarts).toBe(2);
		expect(await target(f.home)).toBe('releases/legacy');
		expect(await fs.readdir(f.home)).not.toContain('previous');
		expect(await fs.readFile(join(f.home, 'run-gateway.sh'), 'utf8')).toBe(
			f.original,
		);
		expect(await (await f.readIndex()).text()).toContain('legacy');
		expect(await releases(f.home)).toHaveLength(2);
	});
}

test('failed later update restores both current and previous targets', async () => {
	const f = await fixture();
	await update(f.deps);
	const current = await target(f.home);
	const previous = await target(f.home, 'previous');
	f.control.failNew = true;
	await expect(update(f.deps)).rejects.toThrow('rollback verified');
	expect(await target(f.home)).toBe(current);
	expect(await target(f.home, 'previous')).toBe(previous);
	expect(f.control.restarts).toBe(3);
});

test('automatic rollback reports when recovery also fails verification', async () => {
	const f = await fixture();
	f.control.failAll = true;
	await expect(update(f.deps)).rejects.toThrow('rollback did not verify');
	expect(f.control.restarts).toBe(2);
});

test('rollback swaps current and previous and refuses busy state unless forced', async () => {
	const f = await fixture();
	await update(f.deps);
	await update(f.deps);
	f.control.checks = 0;
	f.control.checkError = true;
	const current = await target(f.home);
	const previous = await target(f.home, 'previous');
	f.control.state = { bootId: 'busy', live: {}, approvals: [{}] };
	await expect(rollback(f.deps)).rejects.toThrow('pending approvals');
	expect(f.control.restarts).toBe(2);
	expect(await target(f.home)).toBe(current);
	await rollback(f.deps, { force: true });
	expect(await target(f.home)).toBe(previous);
	expect(await target(f.home, 'previous')).toBe(current);
	expect(await (await f.readIndex()).text()).toContain('release-1');
	await rollback(f.deps);
	expect(await target(f.home)).toBe(current);
	expect(f.control.checks).toBe(0);
});

test('forced rollback recovers when state is unreachable', async () => {
	const f = await fixture();
	await update(f.deps);
	const realFetch = f.deps.fetch;
	f.deps.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith('/api/state')) throw new Error('unreachable');
			return realFetch(input, init);
		},
		realFetch,
	);
	await rollback(f.deps, { force: true });
	expect(await target(f.home)).toBe('releases/legacy');
	expect(f.control.restarts).toBe(2);
});

for (const kind of ['wrongHtml', 'assetStatus', 'unchangedBoot'] as const) {
	test(`rollback reports ${kind} verification failure and leaves the selected release in place`, async () => {
		const f = await fixture();
		await update(f.deps);
		const previous = await target(f.home, 'previous');
		if (kind === 'assetStatus') f.control.assetStatus = 404;
		else f.control[kind] = true;
		await expect(rollback(f.deps)).rejects.toThrow(
			'Rollback failed verification',
		);
		expect(await target(f.home)).toBe(previous);
		expect(f.control.restarts).toBe(2);
	});
}

test('rollback without migrated wrapper or previous points to the manual procedure', async () => {
	const f = await fixture();
	await expect(rollback(f.deps)).rejects.toThrow('README rollback section');
	await update(f.deps);
	await fs.unlink(join(f.home, 'previous'));
	await expect(rollback(f.deps)).rejects.toThrow('README rollback section');
});

// Pure input boundaries

test('wrapper migration is exact, idempotent and rejects unknown input', () => {
	expect(wrapperState(legacyWrapper)).toBe('legacy');
	const migrated = migrateWrapper(legacyWrapper);
	expect(wrapperState(migrated)).toBe('migrated');
	expect(migrateWrapper(migrated)).toBe(migrated);
	expect(migrated).toContain(
		'exec /Users/braden/.bun/bin/bun "$release_dir/server.js"',
	);
	expect(migrated).toContain('export STATIC_DIR="$release_dir/build"');
	for (const text of [
		'unknown',
		legacyWrapper + 'export STATIC_DIR="$app_data_dir/build"\n',
		legacyWrapper.replace('exec ', 'other '),
	]) {
		expect(() => migrateWrapper(text)).toThrow('unrecognized');
		expect(() => wrapperState(text)).toThrow('nothing was changed');
	}
});

test('idle assessment validates every live turn and reports counts without private contents', () => {
	expect(assessIdle({ bootId: 'b', live: {}, approvals: [] })).toEqual({
		ok: true,
		bootId: 'b',
	});
	expect(
		assessIdle({
			bootId: 'b',
			live: {
				a: { status: 'completed', threadStatus: null },
				b: { status: 'failed' },
			},
			approvals: [],
		}).ok,
	).toBe(true);
	for (const state of [
		null,
		[],
		{},
		{ bootId: '', live: {}, approvals: [] },
		{ bootId: 'b', live: [], approvals: [] },
		{ bootId: 'b', live: { a: null }, approvals: [] },
		{ bootId: 'b', live: { a: { status: 1 } }, approvals: [] },
		{
			bootId: 'b',
			live: { a: { status: 'completed', threadStatus: [] } },
			approvals: [],
		},
	])
		expect(assessIdle(state).ok).toBe(false);
	for (const live of [
		{ private: { status: 'queued' } },
		{ private: { status: 'completed', threadStatus: { type: 'paused' } } },
		{
			idle: { status: 'completed', threadStatus: { type: 'idle' } },
			private: { status: 'queued' },
		},
	]) {
		const result = assessIdle({ bootId: 'b', live, approvals: [] });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('Expected unrecognized status rejection');
		expect(result.reason).toBe('unrecognized turn or thread status');
		expect(result.reason).not.toContain('queued');
		expect(result.reason).not.toContain('paused');
		expect(result.reason).not.toContain('private');
	}
	expect(
		assessIdle({
			bootId: 'b',
			live: {
				private: { status: 'inProgress', threadStatus: { type: 'active' } },
			},
			approvals: [{ command: 'secret' }, {}],
		}),
	).toEqual({ ok: false, reason: '1 active turns, 2 pending approvals' });
});
