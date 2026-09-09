/**
 * Physical SQLite lifetime tests.
 * Verifies exclusive acquisition, admitted-operation drain, failed cleanup,
 * identity isolation, and delayed transport requests after file replacement.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createAppSqlite,
	createDeviceDispatcher,
	createSqliteOwner,
	createTransportSqliteOwner,
	type SqliteBackend,
} from './owner.js';
import { DeviceError } from './index.js';
import type { DeviceResponse } from './protocol.js';

import { installTestLocks } from './test-locks.js';
installTestLocks();

const appId = 'so.epicenter.test';
function setup() {
	const calls: unknown[] = [];
	const backend: SqliteBackend = {
		async open(...args) {
			calls.push(['open', ...args]);
			return {
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

test('SQL-only acquisition reserves identity even before a database is opened', async () => {
	const { owner, calls } = setup();
	const storage = createAppSqlite(owner, appId, null);
	expectOk(await storage.acquire());
	await expect(owner.acquire(appId, null)).rejects.toThrow('already acquired');
	expect(calls).toEqual([]);
	await storage.close();
	const replacement = await owner.acquire(appId, null);
	await replacement.close();
	expectErr(await storage.open('search'));
});

test('delete closes the physical database and retires every retained handle', async () => {
	const { owner, calls } = setup();
	const lifetime = await owner.acquire(appId, null);
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
		['open', appId, null, 'search'],
		['close', appId, null, 'search'],
		['delete', appId, null, 'search'],
		['open', appId, null, 'search'],
		['run'],
		['close', appId, null, 'search'],
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
	const lifetime = await owner.acquire(appId, null);
	const database = lifetime.open('search');
	await started.promise;
	const closing = lifetime.close();
	expect(lifetime.close()).toBe(closing);
	await expect(lifetime.open('other')).rejects.toThrow('closed');
	await expect(owner.acquire(appId, null)).rejects.toThrow('already acquired');
	opening.resolve();
	await closing;
	expectErr(await (await database).run('SELECT 1'));
	expect(calls).toEqual([
		['open', appId, null, 'search'],
		['close', appId, null, 'search'],
	]);
	await (await owner.acquire(appId, null)).close();
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
	const lifetime = await owner.acquire(appId, null);
	const database = await lifetime.open('search');
	const statement = database.run('SELECT 1');
	await started.promise;
	const closing = lifetime.close();
	running.resolve();
	expectOk(await statement);
	await closing;
	expect(calls.slice(-2)).toEqual([
		['finished'],
		['close', appId, null, 'search'],
	]);
});

test('failed cleanup attempts every close and keeps the lifetime reserved', async () => {
	const { owner, backend, calls } = setup();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async close() {
			calls.push(['close', args[2]]);
			if (args[2] === 'search') throw new Error('disk failure');
		},
	});
	const lifetime = await owner.acquire(appId, null);
	await lifetime.open('search');
	await lifetime.open('mail');
	await expect(lifetime.close()).rejects.toThrow('cleanup failed');
	expect(calls.slice(-2)).toEqual([
		['close', 'search'],
		['close', 'mail'],
	]);
	await expect(owner.acquire(appId, null)).rejects.toThrow('already acquired');
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
	const lifetime = await owner.acquire(appId, null);
	const database = await lifetime.open('search');
	await expect(lifetime.delete('search')).rejects.toThrow('disk failure');
	await expect(lifetime.open('search')).rejects.toThrow('cleanup failed');
	expectErr(await database.run('SELECT 1'));
	expect(calls).toEqual([['open', appId, null, 'search']]);
});

test('captured identities and other applications have independent lifetimes', async () => {
	const { owner, calls } = setup();
	const account = { authorityId: 'cloud', principalId: asPrincipalId('alice') };
	const storage = createAppSqlite(owner, appId, account);
	account.principalId = asPrincipalId('bob');
	const other = await owner.acquire(appId, account);
	const local = await owner.acquire(appId, null);
	const anotherApp = await owner.acquire('so.epicenter.other', null);
	expectOk(await storage.open('search'));
	await storage.close();
	expectOk(await (await other.open('search')).run('SELECT 1'));
	await Promise.all([other.close(), local.close(), anotherApp.close()]);
	expect(calls[0]).toEqual([
		'open',
		appId,
		{ authorityId: 'cloud', principalId: 'alice' },
		'search',
	]);
});

test.each([
	'',
	'../escape',
	'nested/name',
	'search.sqlite',
])('invalid name %s does not acquire storage', async (name) => {
	const { owner, calls } = setup();
	const storage = createAppSqlite(owner, appId, null);
	expect(expectErr(await storage.open(name)).name).toBe('InvalidDatabaseName');
	expect(expectErr(await storage.delete(name)).name).toBe(
		'InvalidDatabaseName',
	);
	expect(calls).toEqual([]);
	await (await owner.acquire(appId, null)).close();
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
	const lifetime = await remote.acquire(appId, null);
	const old = await lifetime.open('search');
	await lifetime.delete('search');
	const replacement = await lifetime.open('search');
	expectErr(await old.run('SELECT 1'));
	expectOk(await replacement.run('SELECT 1'));
	await lifetime.close();
	const next = await remote.acquire(appId, null);
	expectErr(await replacement.run('SELECT 1'));
	await next.close();
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'open'),
	).toHaveLength(2);
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'run'),
	).toHaveLength(1);
});

test('dispatcher checks account and app identity before resolving a lifetime token', async () => {
	const { owner } = setup();
	const dispatch = createDeviceDispatcher(owner);
	const response = (await dispatch.request({
		kind: 'sqlite-acquire',
		appId,
		account: null,
	})) as Extract<DeviceResponse, { kind: 'sqlite-acquire' }>;
	await expect(
		dispatch.request({
			kind: 'sqlite-open',
			appId: 'so.epicenter.other',
			account: null,
			lifetimeId: response.lifetimeId,
			name: 'search',
		}),
	).rejects.toThrow('Unknown SQLite lifetime');
	await expect(
		// @ts-expect-error Explicit account identity is required on every request.
		dispatch.request({ kind: 'sqlite-acquire', appId }),
	).rejects.toThrow('Invalid SQLite account');
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
	const lifetime = await remote.acquire(appId, null);
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
	const first = await remote.acquire(appId, null);
	const second = await remote.acquire('so.epicenter.other', null);
	await first.open('search');
	await second.open('search');
	const closing = dispatch.close();
	expect(dispatch.close()).toBe(closing);
	await expect(
		dispatch.request({
			kind: 'sqlite-acquire',
			appId: 'so.epicenter.third',
			account: null,
		}),
	).rejects.toThrow('dispatcher is closed');
	await closing;
	expect(
		calls.filter((call) => Array.isArray(call) && call[0] === 'close'),
	).toHaveLength(2);
	await (await owner.acquire(appId, null)).close();
	await (await owner.acquire('so.epicenter.other', null)).close();
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
	const lifetime = await remote.acquire(appId, null);
	await lifetime.open('search');
	await expect(lifetime.close()).rejects.toMatchObject({
		name: 'StorageFailed',
	});
	await expect(dispatch.close()).rejects.toThrow('dispatcher cleanup failed');
	await expect(owner.acquire(appId, null)).rejects.toThrow('already acquired');
});
