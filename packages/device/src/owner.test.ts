/**
 * Scoped SQL storage tests.
 *
 * The device validates names and converts owner failures without acquiring a
 * document lifetime. Standalone callers retain the owner's actual SQL methods.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DeviceError, type AppSqliteDatabase } from './index.js';
import { createScopedSqlite, type DeviceSqliteOwner } from './owner.js';
import type { StorageScope } from './protocol.js';

function setup() {
	const calls: unknown[] = [];
	const database: AppSqliteDatabase = {
		run: async () => Ok({ changes: 1 }),
		all: async () => Ok([]),
		batch: async () => Ok({ changes: [1] }),
	};
	const owner: DeviceSqliteOwner = {
		async open(...args) {
			calls.push(['open', ...args]);
			return database;
		},
		async delete(...args) {
			calls.push(['delete', ...args]);
		},
	};
	return { owner, database, calls };
}

test('standalone SQL returns the owner database directly under the supplied scope', async () => {
	const { owner, database, calls } = setup();
	const scope: StorageScope = {
		kind: 'account',
		authorityId: 'authority',
		principalId: 'alice',
	};
	const sqlite = createScopedSqlite(owner, 'so.epicenter.test', scope);
	expect(expectOk(await sqlite.open('search'))).toBe(database);
	expectOk(await sqlite.delete('search'));
	expectOk(await database.run('select 1'));
	expectOk(await database.all('select 1'));
	expectOk(await database.batch([{ sql: 'select 1' }]));
	expect(calls).toEqual([
		['open', 'so.epicenter.test', scope, 'search'],
		['delete', 'so.epicenter.test', scope, 'search'],
	]);
});

test.each([
	'',
	'../escape',
	'nested/name',
	'search.sqlite',
])('invalid database name %s never reaches the owner', async (name) => {
	const { owner, calls } = setup();
	const sqlite = createScopedSqlite(owner, 'so.epicenter.test', {
		kind: 'local',
	});
	expect(expectErr(await sqlite.open(name)).name).toBe('InvalidDatabaseName');
	expect(expectErr(await sqlite.delete(name)).name).toBe('InvalidDatabaseName');
	expect(calls).toEqual([]);
});

test.each([
	'throw',
	'reject',
] as const)('owner %s becomes a storage Result for open and delete', async (failure) => {
	const cause = new Error('storage unavailable');
	const fail = () => {
		if (failure === 'throw') throw cause;
		return Promise.reject(cause);
	};
	const sqlite = createScopedSqlite(
		{ open: fail, delete: fail },
		'so.epicenter.test',
		{ kind: 'local' },
	);
	for (const result of [
		await sqlite.open('search'),
		await sqlite.delete('search'),
	]) {
		expect(expectErr(result)).toMatchObject({ name: 'StorageFailed', cause });
	}
});

test('statement failures retain their original Result or rejection', async () => {
	const { owner, database } = setup();
	const refusal = DeviceError.InvalidResponse();
	const cause = new Error('statement rejected');
	database.run = async () => refusal;
	database.batch = async () => {
		throw cause;
	};
	const sqlite = createScopedSqlite(owner, 'so.epicenter.test', {
		kind: 'local',
	});
	const opened = expectOk(await sqlite.open('search'));
	expect(await opened.run('select 1')).toBe(refusal);
	await expect(opened.batch([])).rejects.toBe(cause);
});
