/**
 * Physical SQLite lifetime tests.
 * Verifies exclusive acquisition, admitted-operation drain, failed cleanup,
 * identity isolation, and delayed transport requests after file replacement.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DeviceError } from './index.js';
import {
	createAppSqlite,
	createDeviceDispatcher,
	createSqliteOwner,
	createTransportSqliteOwner,
	type SqliteBackend,
} from './owner.js';
import type { DeviceResponse } from './protocol.js';

const appId = 'so.epicenter.test';
function setup() {
	const calls: unknown[] = [];
	const backend: SqliteBackend = {
		async open(...args) {
			calls.push(['open', ...args]);
			return {
				async query() {
					return Ok({ columns: [], rows: [], truncated: false });
				},
				async run() {
					calls.push(['run']);
					return Ok({ changes: 1 });
				},
				async all() {
					return Ok([]);
				},
				async batch() {
					return Ok({ changes: [] });
				},
				async close() {
					calls.push(['close', ...args]);
				},
			};
		},
		async delete(...args) {
			calls.push(['delete', ...args]);
		},
	};
	const owner = createSqliteOwner(backend);
	return { owner, backend, calls };
}

test('SQL acquires on first use and holds its identity until close', async () => {
	const { owner, calls } = setup();
	const storage = createAppSqlite(owner, appId);
	expect(calls).toEqual([]);
	const unused = await owner.acquire(appId);
	await unused.close();
	expectOk(await storage.value.open('search'));
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
	expect(calls).toEqual([['open', appId, 'search']]);
	await storage.close();
	const replacement = await owner.acquire(appId);
	await replacement.close();
	expectErr(await storage.value.open('search'));
});

test('physical pool release follows connection close and retains exclusion until completion', async () => {
	const { owner, backend, calls } = setup();
	const releasing = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	backend.release = async (...args) => {
		calls.push(['release', ...args]);
		releasing.resolve();
		await released.promise;
	};
	const lifetime = await owner.acquire(appId);
	const database = await lifetime.open('search');
	const closing = lifetime.close();
	await releasing.promise;
	expect(calls).toEqual([
		['open', appId, 'search'],
		['close', appId, 'search'],
		['release', appId, undefined],
	]);
	expectErr(await database.run('SELECT 1'));
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
	released.resolve();
	await closing;
	await (await owner.acquire(appId)).close();
});

test('failed physical pool release is terminal and retains backend ownership', async () => {
	const { owner, backend } = setup();
	let releases = 0;
	backend.release = async () => {
		releases++;
		throw new Error('Pool release failed');
	};
	const storage = createAppSqlite(owner, 'so.epicenter.failed-pool');
	expectOk(await storage.value.open('search'));
	const closing = storage.close();
	await expect(closing).rejects.toThrow('Pool release failed');
	expect(storage.close()).toBe(closing);
	expect(releases).toBe(1);
	await expect(owner.acquire('so.epicenter.failed-pool')).rejects.toThrow(
		'already acquired',
	);
	const competitor = createAppSqlite(owner, 'so.epicenter.failed-pool');
	expect(expectErr(await competitor.value.open('search')).name).toBe(
		'StorageFailed',
	);
	await competitor.close();
});

test('a failed connection close does not release its pool', async () => {
	const { owner, backend } = setup();
	const open = backend.open;
	let released = false;
	backend.open = async (...args) => ({
		...(await open(...args)),
		async close() {
			throw new Error('Connection still open');
		},
	});
	backend.release = async () => {
		released = true;
	};
	const lifetime = await owner.acquire(appId);
	await lifetime.open('search');
	await expect(lifetime.close()).rejects.toThrow(
		'SQLite lifetime cleanup failed',
	);
	expect(released).toBe(false);
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
});

test('delete closes the physical database and retires every retained handle', async () => {
	const { owner, calls } = setup();
	const lifetime = await owner.acquire(appId);
	const database = await lifetime.open('search');
	expect(await lifetime.open('search')).toBe(database);
	await lifetime.delete('search');
	const reopened = await lifetime.open('search');
	expect(reopened).not.toBe(database);
	expectErr(await database.run('SELECT 1'));
	expectOk(await reopened.run('SELECT 1'));
	await lifetime.close();
	expectErr(await reopened.all('SELECT 1'));
	expect(calls).toEqual([
		['open', appId, 'search'],
		['close', appId, 'search'],
		['delete', appId, 'search'],
		['open', appId, 'search'],
		['run'],
		['close', appId, 'search'],
	]);
});

test('close waits for an admitted open and refuses new work immediately', async () => {
	const { owner, backend, calls } = setup();
	const opening = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => {
		started.resolve();
		await opening.promise;
		return original(...args);
	};
	const lifetime = await owner.acquire(appId);
	const database = lifetime.open('search');
	await started.promise;
	const closing = lifetime.close();
	expect(lifetime.close()).toBe(closing);
	await expect(lifetime.open('other')).rejects.toThrow('closed');
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
	opening.resolve();
	await closing;
	expectErr(await (await database).run('SELECT 1'));
	expect(calls).toEqual([
		['open', appId, 'search'],
		['close', appId, 'search'],
	]);
	await (await owner.acquire(appId)).close();
});

test('close drains an admitted statement before physically closing', async () => {
	const { owner, backend, calls } = setup();
	const running = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			started.resolve();
			await running.promise;
			calls.push(['finished']);
			return Ok({ changes: 1 });
		},
	});
	const lifetime = await owner.acquire(appId);
	const database = await lifetime.open('search');
	const statement = database.run('SELECT 1');
	await started.promise;
	const closing = lifetime.close();
	running.resolve();
	expectOk(await statement);
	await closing;
	expect(calls.slice(-2)).toEqual([['finished'], ['close', appId, 'search']]);
});

test('failed cleanup attempts every close and keeps the lifetime reserved', async () => {
	const { owner, backend, calls } = setup();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async close() {
			calls.push(['close', args[1]]);
			if (args[1] === 'search') throw new Error('disk failure');
		},
	});
	const lifetime = await owner.acquire(appId);
	await lifetime.open('search');
	await lifetime.open('mail');
	await expect(lifetime.close()).rejects.toThrow('cleanup failed');
	expect(calls.slice(-2)).toEqual([
		['close', 'search'],
		['close', 'mail'],
	]);
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
});

test('failed close during delete prevents unlink and replacement open', async () => {
	const { owner, backend, calls } = setup();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async close() {
			throw new Error('disk failure');
		},
	});
	const lifetime = await owner.acquire(appId);
	const database = await lifetime.open('search');
	await expect(lifetime.delete('search')).rejects.toThrow('disk failure');
	await expect(lifetime.open('search')).rejects.toThrow('cleanup failed');
	expectErr(await database.run('SELECT 1'));
	expect(calls).toEqual([['open', appId, 'search']]);
});

test('each application has one independent SQLite lifetime', async () => {
	const { owner } = setup();
	const first = await owner.acquire(appId);
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
	const other = await owner.acquire('so.epicenter.other');
	await Promise.all([first.close(), other.close()]);
	await (await owner.acquire(appId)).close();
});

test.each([
	'',
	'../escape',
	'nested/name',
	'search.sqlite',
])('invalid name %s does not acquire storage', async (name) => {
	const { owner, calls } = setup();
	const storage = createAppSqlite(owner, appId);
	expect(expectErr(await storage.value.open(name)).name).toBe(
		'InvalidDatabaseName',
	);
	expect(expectErr(await storage.value.delete(name)).name).toBe(
		'InvalidDatabaseName',
	);
	expect(calls).toEqual([]);
	await (await owner.acquire(appId)).close();
});

test('a delayed statement cannot reopen a deleted filename or reach its replacement', async () => {
	const { owner, calls } = setup();
	const dispatch = createDeviceDispatcher(owner);
	const remote = createTransportSqliteOwner(async (message) => {
		try {
			return Ok(await dispatch.request(message));
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	});
	const lifetime = await remote.acquire(appId);
	const old = await lifetime.open('search');
	await lifetime.delete('search');
	const replacement = await lifetime.open('search');
	expectErr(await old.run('SELECT 1'));
	expectOk(await replacement.run('SELECT 1'));
	await lifetime.close();
	const next = await remote.acquire(appId);
	expectErr(await replacement.run('SELECT 1'));
	await next.close();
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'open'),
	).toHaveLength(2);
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'run'),
	).toHaveLength(1);
});

test('dispatcher checks app identity before resolving a lifetime token', async () => {
	const { owner } = setup();
	const dispatch = createDeviceDispatcher(owner);
	const response = (await dispatch.request({
		kind: 'sqlite-acquire',
		appId,
	})) as Extract<DeviceResponse, { kind: 'sqlite-acquire' }>;
	await expect(
		dispatch.request({
			kind: 'sqlite-open',
			appId: 'so.epicenter.other',
			lifetimeId: response.lifetimeId,
			name: 'search',
		}),
	).rejects.toThrow('Unknown SQLite lifetime');
	await expect(
		dispatch.request({ kind: 'sqlite-acquire', appId: '../escape' }),
	).rejects.toThrow();
	await dispatch.close();
});

test('concurrent open, delete, and reopen preserve the replacement connection token', async () => {
	const { owner, backend } = setup();
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => {
		started.resolve();
		await gate.promise;
		return original(...args);
	};
	const dispatch = createDeviceDispatcher(owner);
	const remote = createTransportSqliteOwner(async (request) => {
		try {
			return Ok(await dispatch.request(request));
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	});
	const lifetime = await remote.acquire(appId);
	const old = lifetime.open('search');
	await started.promise;
	const deleted = lifetime.delete('search');
	const replacement = lifetime.open('search');
	gate.resolve();
	await deleted;
	expectErr(await (await old).run('SELECT 1'));
	expectOk(await (await replacement).run('SELECT 1'));
	await lifetime.close();
});

test('dispatcher close refuses new admission and releases every surviving lifetime', async () => {
	const { owner, calls } = setup();
	const dispatch = createDeviceDispatcher(owner);
	const remote = createTransportSqliteOwner(async (request) => {
		try {
			return Ok(await dispatch.request(request));
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	});
	const first = await remote.acquire(appId);
	const second = await remote.acquire('so.epicenter.other');
	await first.open('search');
	await second.open('search');
	const closing = dispatch.close();
	expect(dispatch.close()).toBe(closing);
	await expect(
		dispatch.request({
			kind: 'sqlite-acquire',
			appId: 'so.epicenter.third',
		}),
	).rejects.toThrow('dispatcher is closed');
	await closing;
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'close'),
	).toHaveLength(2);
	await (await owner.acquire(appId)).close();
	await (await owner.acquire('so.epicenter.other')).close();
});

test('dispatcher cleanup reports failed physical close and preserves exclusion', async () => {
	const { owner, backend } = setup();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async close() {
			throw new Error('close failed');
		},
	});
	const dispatch = createDeviceDispatcher(owner);
	const remote = createTransportSqliteOwner(async (request) => {
		try {
			return Ok(await dispatch.request(request));
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	});
	const lifetime = await remote.acquire(appId);
	await lifetime.open('search');
	await expect(lifetime.close()).rejects.toMatchObject({
		name: 'StorageFailed',
	});
	await expect(dispatch.close()).rejects.toThrow('dispatcher cleanup failed');
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
});

test('query cancellation bypasses the statement queue but waits for engine cleanup', async () => {
	const { owner, backend, calls } = setup();
	const started = Promise.withResolvers<void>();
	const interrupted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async query(_sql, options) {
			options.signal?.addEventListener('abort', () => interrupted.resolve(), {
				once: true,
			});
			started.resolve();
			await release.promise;
			calls.push(['query-cleaned']);
			return DeviceError.StorageFailed({
				cause: new Error('Query cancelled.'),
			});
		},
	});
	const dispatcher = createDeviceDispatcher(owner);
	const remote = createTransportSqliteOwner(async (message) => {
		try {
			return Ok(await dispatcher.request(message));
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	});
	const lifetime = await remote.acquire(appId);
	const database = await lifetime.open('search');
	const controller = new AbortController();
	let settled = false;
	const query = database
		.query('SELECT 1', { tables: ['messages'], signal: controller.signal })
		.finally(() => {
			settled = true;
		});
	await started.promise;
	const next = database.run('INSERT INTO messages VALUES (1)');
	controller.abort();
	await interrupted.promise;
	expect(settled).toBe(false);
	expect(calls).not.toContainEqual(['run']);
	const closing = lifetime.close();
	expect(calls).not.toContainEqual([
		'close',
		appId,
		{ library: 'local' },
		'search',
	]);
	release.resolve();
	expectErr(await query);
	expectOk(await next);
	await closing;
	expect(calls.slice(-3)).toEqual([
		['query-cleaned'],
		['run'],
		['close', appId, 'search'],
	]);
});

test('a query aborted while queued never reaches the engine', async () => {
	const { owner, backend } = setup();
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let queried = false;
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			started.resolve();
			await release.promise;
			return Ok({ changes: 0 });
		},
		async query() {
			queried = true;
			return Ok({ columns: [], rows: [], truncated: false });
		},
	});
	const lifetime = await owner.acquire(appId);
	const database = await lifetime.open('search');
	const writer = database.run('SELECT 1');
	await started.promise;
	const controller = new AbortController();
	const query = database.query('SELECT 1', {
		tables: [],
		signal: controller.signal,
	});
	controller.abort();
	release.resolve();
	expectOk(await writer);
	expectErr(await query);
	expect(queried).toBe(false);
	await lifetime.close();
});

test('every public SQL verb checks the borrowed gate synchronously', async () => {
	const { owner, calls } = setup();
	let ready = false;
	const storage = createAppSqlite(owner, appId, {
		assertUsable() {
			if (!ready) throw new Error('App is not ready.');
		},
	});
	const { open, delete: remove } = storage.value;
	expect(() => open('search')).toThrow('not ready');
	expect(() => remove('search')).toThrow('not ready');
	expect(calls).toEqual([]);
	ready = true;
	const database = expectOk(await open('search'));
	expect(expectOk(await open('search'))).toBe(database);
	const { run, all, batch, query } = database;
	ready = false;
	for (const invoke of [
		() => run('SELECT 1'),
		() => all('SELECT 1'),
		() => batch([]),
		() => query('SELECT 1', { tables: [] }),
	])
		expect(invoke).toThrow('not ready');
	expect(calls).toEqual([['open', appId, 'search']]);
	await storage.close();
});

test('app close drains an admitted open and refuses late publication after the app retires', async () => {
	const { owner, backend, calls } = setup();
	const opening = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => {
		started.resolve();
		await opening.promise;
		return original(...args);
	};
	let retired = false;
	const storage = createAppSqlite(owner, appId, {
		assertUsable() {
			if (retired) throw new Error('App is closed.');
		},
	});
	const pending = storage.value.open('search');
	await started.promise;
	retired = true;
	const closing = storage.close();
	expect(closing).toBe(storage.close());
	await expect(owner.acquire(appId)).rejects.toThrow('already acquired');
	opening.resolve();
	await expect(pending).rejects.toThrow('App is closed');
	await closing;
	expect(calls).toEqual([
		['open', appId, 'search'],
		['close', appId, 'search'],
	]);
	await (await owner.acquire(appId)).close();
});

test('app SQL close waits for a reentrant accepted write before releasing its lifetime', async () => {
	const { owner, backend, calls } = setup();
	const writing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	let closing: Promise<void> | undefined;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			closing = storage.close();
			started.resolve();
			await writing.promise;
			calls.push(['written']);
			return Ok({ changes: 7 });
		},
	});
	const storage = createAppSqlite(owner, appId);
	const database = expectOk(await storage.value.open('search'));
	const result = database.run('INSERT INTO messages VALUES (1)');
	await started.promise;
	expect(closing).toBe(storage.close());
	expectErr(await database.run('SELECT 1'));
	expect(calls).toEqual([['open', appId, 'search']]);
	writing.resolve();
	expect(expectOk(await result)).toEqual({ changes: 7 });
	await closing;
	expect(calls.slice(-2)).toEqual([['written'], ['close', appId, 'search']]);
});

test('app SQL forwards owner statement failures as the original Result', async () => {
	const { owner, backend } = setup();
	const failure = DeviceError.StorageFailed({
		cause: new Error('disk is full'),
	});
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			return failure;
		},
	});
	const storage = createAppSqlite(owner, appId);
	const database = expectOk(await storage.value.open('search'));
	expect(await database.run('INSERT INTO messages VALUES (1)')).toBe(failure);
	await storage.close();
});

test('SQL drain settles accepted work while retaining connections and backend ownership', async () => {
	const { owner, backend, calls } = setup();
	const writing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			started.resolve();
			await writing.promise;
			calls.push(['written']);
			return Ok({ changes: 1 });
		},
	});
	const storage = createAppSqlite(owner, appId);
	const database = expectOk(await storage.value.open('search'));
	const result = database.run('INSERT INTO messages VALUES (1)');
	await started.promise;
	let drained = false;
	const draining = storage.drain();
	void draining.then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBe(false);
	writing.resolve();
	expectOk(await result);
	await draining;
	expect(calls).toEqual([['open', appId, 'search'], ['written']]);
	const replacement = createAppSqlite(owner, appId);
	expect(expectErr(await replacement.value.open('search')).name).toBe(
		'StorageFailed',
	);
	await replacement.close();
	expect(Object.keys(storage.value).sort()).toEqual(['delete', 'open']);
	await storage.close();
	const released = createAppSqlite(owner, appId);
	expectOk(await released.value.open('search'));
	await released.close();
});
