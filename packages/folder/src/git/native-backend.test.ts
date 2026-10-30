/**
 * Native transfer receipts and credential cancellation.
 * A real remote acceptance survives local tracking failure. Cancellation
 * during credential acquisition must prevent the later Git transfer.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectOk } from 'wellcrafted/testing';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import { git } from '../git-http.test-support.js';
import { overwrite } from '../put.test-support.js';
import { executeHistoryRequest } from './history.js';
import { createNativeGitBackend } from './native-backend.js';
import { runNativeHistory } from './native-history.js';
import { createGitRunner } from './native-host.js';

const author = { name: 'Backend', email: 'backend@example.test' };

test('a real accepted push stays pushed when its tracking update fails', async () => {
	const raw = await rawDirectoryFolder('history-push-receipt-');
	await raw.backend();
	const bare = join(raw.root, '.git', 'probe-remote.git');
	await git(
		raw.root,
		'init',
		'--quiet',
		'--bare',
		'--initial-branch=main',
		bare,
	);
	const run = createGitRunner(raw.root);
	const backend = await createNativeGitBackend({
		root: raw.root,
		branch: 'main',
		host: {
			files: nodeDirectoryPrimitives,
			run: (args, options) => {
				if (args[0] === 'update-ref' && args[1] === 'refs/remotes/origin/main')
					return Promise.reject(new Error('local tracking ref unavailable'));
				return run(args, options);
			},
		},
	});
	await backend.setRemote(bare);
	await overwrite(raw.boundary, 'a.md', 'saved');
	const { sink, events } = memorySink();
	const reply = await executeHistoryRequest(
		{
			backend,
			boundary: raw.boundary,
			getAuthor: () => author,
			log: createLogger('test/history', sink),
		},
		{ op: 'sync' },
	);
	const outcome = expectOk(reply.result);
	expect(outcome.kind).toBe('synced');
	expect(await backend.readBranch()).toBe(await git(bare, 'rev-parse', 'main'));
	expect(reply.state.lastPush?.status).toBe('pushed');
	expect(reply.state.sync).toBeUndefined();
	expect(events.some((event) => event.level === 'warn')).toBe(true);
});

test.each(['fetch', 'push'] as const)(
	'abort during credentials prevents %s from starting after credentials return',
	async (transfer) => {
		const raw = await rawDirectoryFolder('history-credentials-abort-');
		await raw.backend();
		const run = createGitRunner(raw.root);
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const commands: string[] = [];
		const backend = await createNativeGitBackend({
			root: raw.root,
			branch: 'main',
			host: {
				files: nodeDirectoryPrimitives,
				run(args, options) {
					if (args[0] !== undefined) commands.push(args[0]);
					return run(args, options);
				},
			},
			credentials: async () => {
				started.resolve();
				await released.promise;
				return undefined;
			},
		});
		await backend.setRemote('https://unused.test/r.git');
		const controller = new AbortController();
		const reason = new Error(
			'request cancelled while credentials were acquired',
		);
		const pending =
			transfer === 'fetch'
				? backend.fetch(controller.signal)
				: backend.push('a'.repeat(40), controller.signal);
		// Attach before the controlled rejection, avoiding an unhandled rejection.
		const rejected = pending.then(
			() => undefined,
			(cause) => cause,
		);
		await started.promise;
		controller.abort(reason);
		released.resolve();
		expect(await rejected).toBe(reason);
		expect(commands).not.toContain(transfer);
	},
);

test('the native entry keeps the history lock until final inspection finishes', async () => {
	const raw = await rawDirectoryFolder('history-native-lock-');
	await raw.backend();
	const run = createGitRunner(raw.root);
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const secondInitialized = Promise.withResolvers<void>();
	let inspect = false,
		second = false,
		lists = 0;
	const host = {
		files: nodeDirectoryPrimitives,
		async run(args: readonly string[], options?: Parameters<typeof run>[1]) {
			const result = await run(args, options);
			if (args[0] === 'update-ref') inspect = true;
			if (second && args[0] === 'config' && args[2] === 'user.email')
				secondInitialized.resolve();
			return result;
		},
	};
	const boundary = {
		...raw.boundary,
		async list() {
			lists++;
			if (inspect) {
				entered.resolve();
				await released.promise;
			}
			return raw.boundary.list();
		},
	};
	await overwrite(raw.boundary, 'a.md', 'saved');
	const first = runNativeHistory({
		rootPath: raw.root,
		host,
		boundary,
		author,
		request: { op: 'saveVersion' },
	});
	try {
		await entered.promise;
		second = true;
		const next = runNativeHistory({
			rootPath: raw.root,
			host,
			boundary,
			author,
			request: { op: 'saveVersion' },
		});
		await secondInitialized.promise;
		await Bun.sleep(10);
		expect(lists).toBe(2); // First capture + first inspection; no second capture yet.
		released.resolve();
		expect((await first).result.status).toBe('committed');
		expect((await next).result.status).toBe('unchanged');
	} finally {
		released.resolve();
		await first;
	}
});

test('a native log request never scans files', async () => {
	const raw = await rawDirectoryFolder('history-native-log-');
	let lists = 0;
	const reply = await runNativeHistory({
		rootPath: raw.root,
		host: { run: createGitRunner(raw.root), files: nodeDirectoryPrimitives },
		boundary: {
			...raw.boundary,
			async list() {
				lists++;
				throw new Error('log must not scan');
			},
		},
		author,
		request: { op: 'log', depth: 5 },
	});
	expect(expectOk(reply.result)).toEqual([]);
	expect(lists).toBe(0);
	expect(reply.state.files).toBeUndefined();
	expect(reply.state.sync).toBeUndefined();
});

test('a failed remote connection keeps the existing thrown setup failure contract', async () => {
	const raw = await rawDirectoryFolder('history-connect-failure-');
	await raw.backend();
	const run = createGitRunner(raw.root);
	const reason = new Error('remote configuration unavailable');
	const pending = runNativeHistory({
		rootPath: raw.root,
		host: {
			files: nodeDirectoryPrimitives,
			run(args, options) {
				if (args[0] === 'config' && args[1] === 'remote.origin.url')
					return Promise.reject(reason);
				return run(args, options);
			},
		},
		boundary: raw.boundary,
		author,
		request: { op: 'sync', connect: 'https://unused.test/r.git' },
	});
	await expect(pending).rejects.toBe(reason);
});
