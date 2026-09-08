/**
 * Scoped SQL storage tests.
 *
 * The device validates names and converts owner failures without acquiring a
 * document lifetime. Standalone callers retain the owner's actual SQL methods.
 */
import { expect, test } from 'bun:test';
import { type AccountIdentity, asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DeviceError, type AppSqliteDatabase } from './index.js';
import {
	answerDevice,
	createAppSqlite,
	type DeviceSqliteOwner,
} from './owner.js';

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

test('standalone SQL returns the owner database directly under the supplied account', async () => {
	const { owner, database, calls } = setup();
	const account: AccountIdentity = {
		authorityId: 'authority',
		principalId: asPrincipalId('alice'),
	};
	const sqlite = createAppSqlite(owner, 'so.epicenter.test', account);
	expect(expectOk(await sqlite.open('search'))).toBe(database);
	expectOk(await sqlite.delete('search'));
	expectOk(await database.run('select 1'));
	expectOk(await database.all('select 1'));
	expectOk(await database.batch([{ sql: 'select 1' }]));
	expect(calls).toEqual([
		['open', 'so.epicenter.test', account, 'search'],
		['delete', 'so.epicenter.test', account, 'search'],
	]);
});

test.each([
	'',
	'../escape',
	'nested/name',
	'search.sqlite',
])('invalid database name %s never reaches the owner', async (name) => {
	const { owner, calls } = setup();
	const sqlite = createAppSqlite(owner, 'so.epicenter.test', null);
	expect(expectErr(await sqlite.open(name)).name).toBe('InvalidDatabaseName');
	expect(expectErr(await sqlite.delete(name)).name).toBe('InvalidDatabaseName');
	expect(calls).toEqual([]);
});

test('standalone SQL captures identity before later opens and deletes', async () => {
	const { owner, calls } = setup();
	const account = { authorityId: 'cloud', principalId: asPrincipalId('alice') };
	const sqlite = createAppSqlite(owner, 'so.epicenter.test', account);
	account.authorityId = 'replacement';
	account.principalId = asPrincipalId('bob');
	expectOk(await sqlite.open('search'));
	expectOk(await sqlite.delete('search'));
	expect(calls).toEqual([
		[
			'open',
			'so.epicenter.test',
			{ authorityId: 'cloud', principalId: 'alice' },
			'search',
		],
		[
			'delete',
			'so.epicenter.test',
			{ authorityId: 'cloud', principalId: 'alice' },
			'search',
		],
	]);
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
	const sqlite = createAppSqlite(
		{ open: fail, delete: fail },
		'so.epicenter.test',
		null,
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
	const sqlite = createAppSqlite(owner, 'so.epicenter.test', null);
	const opened = expectOk(await sqlite.open('search'));
	expect(await opened.run('select 1')).toBe(refusal);
	await expect(opened.batch([])).rejects.toBe(cause);
});

test('an omitted SQL account is rejected before the owner opens or deletes a file', async () => {
	const { owner, calls } = setup();
	const request = { appId: 'so.epicenter.test', name: 'search' };
	await expect(
		// @ts-expect-error: SQL requests require an explicit account, including local null.
		answerDevice(owner, { kind: 'sqlite-delete', ...request }),
	).rejects.toThrow('Invalid SQLite account.');
	expect(calls).toEqual([]);
});

test.each([
	'sqlite-run',
	'sqlite-all',
	'sqlite-batch',
	'sqlite-delete',
] as const)('%s refuses a malformed account before reaching the owner', async (kind) => {
	const { owner, calls } = setup();
	await expect(
		answerDevice(owner, {
			kind,
			appId: 'so.epicenter.test',
			name: 'search',
			// @ts-expect-error: an old local scope is not an account identity.
			account: { kind: 'local' },
			statement: { sql: 'SELECT 1' },
			statements: [],
		}),
	).rejects.toThrow('Invalid SQLite account.');
	expect(calls).toEqual([]);
});
