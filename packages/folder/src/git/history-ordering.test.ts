/**
 * Request-owned history ordering and receipts.
 * Real Git objects and files expose branch races, partial publication, and
 * failures after acknowledged effects. Each mutation uses the history lock.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { LockingStorage } from '../boundary.js';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { GIT_ENV } from '../git-http.test-support.js';
import type { HistoryRequest } from '../history-wire.js';
import { holdingHistoryLock } from '../native/directory.js';
import { overwrite } from '../put.test-support.js';
import type { GitBackend } from './backend.js';
import { executeHistoryRequest } from './history.js';
import { writeCommitObject, writeFilesTree } from './objects.js';

const author = { name: 'History', email: 'history@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
function gate() {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { opened: promise, open: resolve };
}
async function setup(
	overrides: (real: GitBackend) => Partial<GitBackend> = () => ({}),
	wrap: (base: LockingStorage) => LockingStorage = (base) => base,
) {
	const raw = await rawDirectoryFolder('history-request-');
	const real = await raw.backend({
		remote: { url: 'https://unused.test/r.git', branch: 'main' },
	});
	let pushes = 0;
	const backend: GitBackend = {
		...real,
		async push() {
			pushes++;
			return { status: 'pushed', trackingWarning: undefined };
		},
		...overrides(real),
	};
	const { sink, events } = memorySink();
	const boundary = wrap(raw.boundary);
	function request<TRequest extends HistoryRequest>(
		request: TRequest,
		signal?: AbortSignal,
	) {
		const execute = () =>
			executeHistoryRequest(
				{
					backend,
					boundary,
					getAuthor: () => author,
					signal,
					log: createLogger('test/history', sink),
				},
				request,
			);
		return request.op === 'status' || request.op === 'log'
			? execute()
			: holdingHistoryLock(raw.root, execute);
	}
	async function commitOf(
		parent: string | undefined,
		files: Record<string, string>,
	) {
		return real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(files).map(([p, text]) => [
							p,
							new TextEncoder().encode(text),
						]),
					),
				),
				parents: parent === undefined ? [] : [parent],
				message: 'Other owner',
				author,
			}),
		);
	}
	return {
		raw,
		real,
		request,
		commitOf,
		events,
		pushes: () => pushes,
		write: (path: string, text: string | null) =>
			overwrite(raw.boundary, path, text),
	};
}

test('a waiting request pins its parent and captures after the history lock is acquired', async () => {
	const { raw, real, request, write, commitOf } = await setup();
	await write('a.txt', 'one');
	expect((await request({ op: 'saveVersion' })).result.status).toBe(
		'committed',
	);
	const held = gate();
	const entered = gate();
	const owner = holdingHistoryLock(raw.root, async () => {
		entered.open();
		await held.opened;
		await write('a.txt', 'two');
		const parent = await real.readBranch();
		const incoming = await commitOf(parent, { 'a.txt': 'two' });
		expect((await real.casBranch(parent, incoming)).ok).toBe(true);
		return incoming;
	});
	await entered.opened;
	const pending = request({ op: 'saveVersion' });
	held.open();
	const incoming = await owner;
	expect((await pending).result).toMatchObject({
		status: 'unchanged',
		head: incoming,
	});
	expect(await real.readBranch()).toBe(incoming);
});

test('an external branch move after capture is retried from a fresh capture', async () => {
	let arm = false;
	let competitor: string | undefined;
	const { real, request, write, commitOf } = await setup(
		() => ({}),
		(base) => ({
			...base,
			async list() {
				const captured = await base.list();
				if (arm) {
					arm = false;
					const parent = await real.readBranch();
					competitor = await commitOf(parent, { 'elsewhere.txt': 'x' });
					expect((await real.casBranch(parent, competitor)).ok).toBe(true);
				}
				return captured;
			},
		}),
	);
	await write('a.txt', 'one');
	await request({ op: 'saveVersion' });
	await write('b.txt', 'local');
	arm = true;
	const { result } = await request({ op: 'saveVersion' });
	expect(result).toMatchObject({ status: 'committed', parent: competitor });
	if (result.status === 'committed')
		expect(await real.readBranch()).toBe(result.oid);
});

test('files that landed before a failed branch CAS remain visible in the reply', async () => {
	let incoming: string | undefined;
	const { real, request, write, commitOf } = await setup((base) => ({
		fetch: async () => incoming,
		casBranch: (expected, next) =>
			next === incoming
				? Promise.resolve({ ok: false, actual: 'f'.repeat(40) })
				: base.casBranch(expected, next),
	}));
	await write('a.txt', 'one');
	await request({ op: 'saveVersion' });
	const parent = await real.readBranch();
	incoming = await commitOf(parent, { 'a.txt': 'two' });
	const reply = await request({ op: 'sync' });
	expect(expectErr(reply.result).name).toBe('Blocked');
	expect(await real.readBranch()).toBe(parent);
	expect(reply.state.files?.changes).toEqual([
		{ path: 'a.txt', kind: 'modify' },
	]);
	expect(reply.state.lastCommit?.status).toBe('unchanged');
	expect(reply.landed).toEqual(['a.txt']);
});

test('save-version stays local and requests waiting behind it capture their own files', async () => {
	const held = gate(),
		entered = gate();
	let hold = false;
	const { request, write, pushes } = await setup((base) => ({
		fetch: async () => undefined,
		async casBranch(expected, next) {
			if (hold) {
				hold = false;
				entered.open();
				await held.opened;
			}
			return base.casBranch(expected, next);
		},
	}));
	await write('a.txt', 'one');
	await request({ op: 'saveVersion' });
	expect(pushes()).toBe(0);
	await write('a.txt', 'three');
	hold = true;
	const first = request({ op: 'saveVersion' });
	await entered.opened;
	await write('a.txt', 'four');
	const second = request({ op: 'saveVersion' });
	held.open();
	expect((await first).result.status).toBe('committed');
	expect((await second).result).toMatchObject({
		status: 'committed',
		message: 'Update a.txt',
	});
	expect(pushes()).toBe(0);
	expect(expectOk((await request({ op: 'sync' })).result).kind).toBe('synced');
	expect(pushes()).toBe(1);
});

test('a committed receipt survives final inspection failure without reporting clean files', async () => {
	let failRead = false,
		publications = 0;
	const { real, request, write } = await setup((base) => ({
		async casBranch(expected, next) {
			const moved = await base.casBranch(expected, next);
			if (moved.ok) {
				publications++;
				failRead = true;
			}
			return moved;
		},
		readBranch: () =>
			failRead
				? Promise.reject(new Error('inspection unavailable'))
				: base.readBranch(),
	}));
	await write('saved.md', 'saved');
	const reply = await request({ op: 'saveVersion' });
	expect(reply.result.status).toBe('committed');
	if (reply.result.status !== 'committed')
		throw new Error('Expected a receipt');
	expect(await real.readBranch()).toBe(reply.result.oid);
	expect(reply.state.lastCommit).toMatchObject(reply.result);
	expect(reply.state.files).toBeUndefined();
	expect(reply.state.sync).toBeUndefined();
	failRead = false;
	expect(expectOk((await request({ op: 'status' })).result).changes).toEqual(
		[],
	);
	expect((await request({ op: 'saveVersion' })).result.status).toBe(
		'unchanged',
	);
	expect(publications).toBe(1);
});

test('a published fast-forward survives failed observation and index reconciliation', async () => {
	let incoming: string | undefined,
		failRead = false;
	const { real, raw, request, write, commitOf } = await setup((base) => ({
		fetch: async () => incoming,
		async casBranch(expected, next) {
			const moved = await base.casBranch(expected, next);
			if (moved.ok && next === incoming) failRead = true;
			return moved;
		},
		readBranch: () =>
			failRead
				? Promise.reject(new Error('post-pull inspection failed'))
				: base.readBranch(),
		reconcileIndex: (commit) =>
			commit === incoming
				? Promise.reject(new Error('index.lock exists'))
				: base.reconcileIndex(commit),
	}));
	await write('saved.md', 'before');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), { 'saved.md': 'after' });
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result)).toEqual({ kind: 'synced', head: incoming });
	expect(await real.readBranch()).toBe(incoming);
	expect(
		new TextDecoder().decode(
			expectOk(await raw.boundary.read('saved.md')).bytes,
		),
	).toBe('after');
	expect(reply.state.files).toBeUndefined();
	expect(reply.state.sync).toBeUndefined();
	expect(reply.landed).toEqual(['saved.md']);
});

test('a branch read failure before publication remains a failed checkpoint', async () => {
	let publications = 0;
	const { real, request, write } = await setup((base) => ({
		readBranch: async () => {
			throw new Error('pre-publication branch unavailable');
		},
		async casBranch(expected, next) {
			publications++;
			return base.casBranch(expected, next);
		},
	}));
	await write('saved.md', 'saved without commit');
	expect((await request({ op: 'saveVersion' })).result).toEqual({
		status: 'failed',
		error: 'pre-publication branch unavailable',
	});
	expect(await real.readBranch()).toBeUndefined();
	expect(publications).toBe(0);
});

test.each(['edit', 'delete'] as const)(
	'a stale removal records the intervening %s even when no path lands and inspection fails',
	async (mode) => {
		let incoming: string | undefined,
			arm = false,
			failRead = false;
		const { real, raw, request, write, commitOf } = await setup(
			(base) => ({
				fetch: async () => incoming,
				async casBranch(expected, next) {
					const moved = await base.casBranch(expected, next);
					if (moved.ok && next === incoming) failRead = true;
					return moved;
				},
				readBranch: () =>
					failRead
						? Promise.reject(new Error('inspection failed'))
						: base.readBranch(),
			}),
			(base) => ({
				...base,
				lock: (work) =>
					base.lock((held) =>
						work({
							...held,
							async put(path, bytes, expected) {
								if (arm && bytes === null) {
									arm = false;
									await overwrite(
										base,
										path,
										mode === 'edit' ? 'new local edit' : null,
									);
								}
								return held.put(path, bytes, expected);
							},
						}),
					),
			}),
		);
		await write('a.md', 'before');
		await request({ op: 'saveVersion' });
		incoming = await commitOf(await real.readBranch(), {});
		arm = true;
		const reply = await request({ op: 'sync' });
		expect(expectOk(reply.result)).toMatchObject({
			kind: 'saved',
			changedSince: true,
			head: incoming,
		});
		expect(reply.landed).toEqual([]);
		expect(reply.state.files).toBeUndefined();
		const live = await raw.boundary.read('a.md');
		if (mode === 'edit')
			expect(new TextDecoder().decode(expectOk(live).bytes)).toBe(
				'new local edit',
			);
		else expect(expectErr(live).name).toBe('NotFound');
	},
);

test('a kept edit remains changedSince when the final inspection succeeds', async () => {
	let incoming: string | undefined,
		arm = false;
	const { real, request, write, commitOf } = await setup(
		() => ({ fetch: async () => incoming }),
		(base) => ({
			...base,
			lock: (work) =>
				base.lock(async (held) => {
					if (arm) {
						arm = false;
						await overwrite(base, 'a.md', 'local');
					}
					return work(held);
				}),
		}),
	);
	await write('a.md', 'before');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), { 'a.md': 'remote' });
	arm = true;
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result)).toMatchObject({
		kind: 'saved',
		changedSince: true,
	});
	expect(reply.state.files?.changes).toEqual([
		{ path: 'a.md', kind: 'modify' },
	]);
});

test('a stale deletion keeps changedSince when the preserved local file is ignored by final inspection', async () => {
	let incoming: string | undefined,
		arm = false;
	const { real, raw, request, write, commitOf } = await setup(
		() => ({ fetch: async () => incoming }),
		(base) => ({
			...base,
			lock: (work) =>
				base.lock((held) =>
					work({
						...held,
						async put(path, bytes, expected) {
							if (arm && path === 'audio.wav' && bytes === null) {
								arm = false;
								await overwrite(base, path, 'new local recording');
							}
							return held.put(path, bytes, expected);
						},
					}),
				),
		}),
	);
	await write('audio.wav', 'original recording');
	await request({ op: 'saveVersion' });
	await write('.gitignore', '*.wav\n');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), {
		'.gitignore': '*.wav\n',
	});
	arm = true;
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result)).toMatchObject({
		kind: 'saved',
		head: incoming,
		changedSince: true,
	});
	expect(reply.state.files).toEqual({ head: incoming, changes: [] });
	expect(reply.landed).toEqual([]);
	expect(
		new TextDecoder().decode(
			expectOk(await raw.boundary.read('audio.wav')).bytes,
		),
	).toBe('new local recording');
});

test('recording an edit found before deletion resets changedSince and sends that edit', async () => {
	let incoming: string | undefined,
		arm = false;
	const { real, request, write, commitOf, pushes } = await setup(() => ({
		async fetch() {
			if (arm) {
				arm = false;
				await write('a.md', 'local edit');
			}
			return incoming;
		},
	}));
	await write('a.md', 'base');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), {
		'remote.md': 'remote addition',
	});
	arm = true;
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result).kind).toBe('synced');
	expect(reply.state.files?.changes).toEqual([]);
	expect(pushes()).toBe(1);
	expect(reply.landed).toEqual(['remote.md']);
});

test('failed marker cleanup preserves publication and the next checkpoint repairs it', async () => {
	let incoming: string | undefined,
		failCleanup = false;
	const { real, request, write, commitOf, events } = await setup((base) => ({
		fetch: async () => incoming,
		writePublishing: (oid) =>
			failCleanup && oid === undefined
				? Promise.reject(new Error('marker cleanup failed'))
				: base.writePublishing(oid),
	}));
	await write('a.md', 'base');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), { 'a.md': 'incoming' });
	failCleanup = true;
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result)).toEqual({ kind: 'synced', head: incoming });
	expect(await real.readBranch()).toBe(incoming);
	expect(await real.readPublishing()).toBeDefined();
	expect(events.some((event) => event.level === 'warn')).toBe(true);
	failCleanup = false;
	expect((await request({ op: 'saveVersion' })).result.status).toBe(
		'unchanged',
	);
	expect(await real.readPublishing()).toBeUndefined();
});

test('an acknowledged push with failed tracking repair keeps its receipt and omits sync metadata', async () => {
	const { request, write } = await setup(() => ({
		fetch: async () => undefined,
		push: async () => ({
			status: 'pushed',
			trackingWarning: 'tracking ref unavailable',
		}),
	}));
	await write('a.md', 'saved');
	const reply = await request({ op: 'sync' });
	expect(expectOk(reply.result).kind).toBe('synced');
	expect(reply.state.lastPush?.status).toBe('pushed');
	expect(reply.state.sync).toBeUndefined();
});

test('a mutation waits for final inspection and returns the published head', async () => {
	const entered = gate(),
		released = gate();
	let inspect = false;
	const { request, write } = await setup(
		(base) => ({
			async casBranch(expected, next) {
				const moved = await base.casBranch(expected, next);
				if (moved.ok) inspect = true;
				return moved;
			},
		}),
		(base) => ({
			...base,
			async list() {
				if (inspect) {
					entered.open();
					await released.opened;
				}
				return base.list();
			},
		}),
	);
	await write('a.md', 'saved');
	let settled = false;
	const pending = request({ op: 'saveVersion' }).then((reply) => {
		settled = true;
		return reply;
	});
	await entered.opened;
	expect(settled).toBe(false);
	released.open();
	const reply = await pending;
	expect(reply.result.status).toBe('committed');
	if (reply.result.status !== 'committed')
		throw new Error('Expected committed receipt');
	expect(reply.state.files).toEqual({ head: reply.result.oid, changes: [] });
});

test('a later fetch restores tracking observations after a pushed merge finds another edit', async () => {
	let incoming: string | undefined,
		tracking: string | undefined,
		remote: string | undefined;
	let fetches = 0,
		pushes = 0;
	const { real, request, write, commitOf } = await setup(() => ({
		async fetch() {
			fetches++;
			if (fetches === 2)
				await write(
					'remote-dir',
					'a newer local file blocks the incoming directory',
				);
			tracking = fetches === 1 ? incoming : remote;
			return tracking;
		},
		readRemoteTracking: async () => tracking,
		async push(oid) {
			pushes++;
			remote = oid;
			// This edit lands after the merge's preflight and before local publication.
			await write('a.md', 'local edit during push');
			return { status: 'pushed', trackingWarning: 'tracking ref unavailable' };
		},
	}));
	await write('a.md', 'base');
	await write('b.md', 'base');
	await request({ op: 'saveVersion' });
	incoming = await commitOf(await real.readBranch(), {
		'b.md': 'remote',
		'remote-dir/file.md': 'incoming',
	});
	await write('b.md', 'local');
	const reply = await request({ op: 'sync' });
	expect(expectErr(reply.result).name).toBe('Blocked');
	expect(fetches).toBe(2);
	expect(pushes).toBe(1);
	// The successful fetch restored the tracking basis before publication was blocked.
	expect(reply.state.sync).toMatchObject({
		head: await real.readBranch(),
		remote: tracking,
	});
	expect(tracking).toBe(remote);
});
