/**
 * Bun SQLite lifetime tests.
 * Verifies physical close preserves files, delete invalidates old connections,
 * concurrent lifecycle operations serialize, and app/account files stay isolated.
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createBunDevice } from './test-sqlite.js';

const appId = 'so.epicenter.mail';

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	return { root, owner: createBunDevice(root) };
}

test('close retains file contents and refuses the retired lifetime', async () => {
	const { root, owner } = await setup();
	const lifetime = await owner.acquire(appId, null);
	const database = await lifetime.open('mail');
	expectOk(await database.run('CREATE TABLE messages (id TEXT)'));
	const write = database.run('INSERT INTO messages VALUES (?)', ['one']);
	await lifetime.close();
	expectOk(await write);
	expectErr(await database.all('SELECT * FROM messages'));
	await expect(lifetime.open('mail')).rejects.toThrow();
	await expect(lifetime.delete('mail')).rejects.toThrow();
	await lifetime.close();
	const next = await owner.acquire(appId, null);
	expect(
		expectOk(await (await next.open('mail')).all('SELECT * FROM messages')),
	).toEqual([{ id: 'one' }]);
	await next.close();
	await rm(root, { recursive: true });
});

test('batch rolls back failed statements and same-name opens share a connection', async () => {
	const { root, owner } = await setup();
	const lifetime = await owner.acquire(appId, null);
	const database = await lifetime.open('mail');
	expect(await lifetime.open('mail')).toBe(database);
	expectOk(
		await database.batch([
			{ sql: 'CREATE TABLE messages (id TEXT PRIMARY KEY)' },
			{ sql: 'INSERT INTO messages VALUES (?)', parameters: ['one'] },
		]),
	);
	expectErr(
		await database.batch([
			{ sql: 'INSERT INTO messages VALUES (?)', parameters: ['two'] },
			{ sql: 'INSERT INTO missing VALUES (?)', parameters: ['never'] },
		]),
	);
	expect(expectOk(await database.all('SELECT * FROM messages'))).toEqual([
		{ id: 'one' },
	]);
	await lifetime.close();
	await rm(root, { recursive: true });
});

test('a failed physical open can be retried in the same lifetime', async () => {
	const { root, owner } = await setup();
	const lifetime = await owner.acquire(appId, null);
	const appDir = join(root, 'apps', appId);
	await mkdir(join(root, 'apps'), { recursive: true });
	await Bun.write(appDir, 'in the way');
	await expect(lifetime.open('mail')).rejects.toThrow();
	await rm(appDir);
	expectOk(
		await (await lifetime.open('mail')).run('CREATE TABLE recovered (id TEXT)'),
	);
	await lifetime.close();
	await rm(root, { recursive: true });
});

test('delete removes database sidecars and reopening never revives an old handle', async () => {
	const { root, owner } = await setup();
	const lifetime = await owner.acquire(appId, null);
	const database = await lifetime.open('mail');
	expectOk(await database.run('CREATE TABLE messages (id TEXT)'));
	const path = join(root, 'apps', appId, 'local', 'sqlite', 'mail.sqlite');
	// Closed SQLite may remove its own journals; leftover sidecars must go too.
	await Bun.write(`${path}-journal`, 'orphaned journal');
	await lifetime.delete('mail');
	for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
		expect(await Bun.file(file).exists()).toBe(false);
	}
	const reopened = await lifetime.open('mail');
	expect(
		expectOk(await reopened.all('SELECT name FROM sqlite_master')),
	).toEqual([]);
	expectErr(await database.all('SELECT name FROM sqlite_master'));
	await lifetime.delete('never');
	await lifetime.close();
	await rm(root, { recursive: true });
});

test('concurrent open, delete, and reopen settle in issue order', async () => {
	const { root, owner } = await setup();
	const lifetime = await owner.acquire(appId, null);
	const opening = lifetime.open('mail');
	const deleting = lifetime.delete('mail');
	const reopening = lifetime.open('mail');
	const first = await opening;
	await deleting;
	const second = await reopening;
	expectErr(await first.run('CREATE TABLE old (id TEXT)'));
	expectOk(await second.run('CREATE TABLE current (id TEXT)'));
	await lifetime.close();
	await rm(root, { recursive: true });
});

test('duplicate lifetimes refuse while local, other accounts, and other apps stay independent', async () => {
	const { root, owner } = await setup();
	const accounts = [
		null,
		{ authorityId: 'cloud', principalId: asPrincipalId('alice') },
		{ authorityId: 'cloud', principalId: asPrincipalId('bob') },
		{ authorityId: 'other', principalId: asPrincipalId('alice') },
	];
	const lifetimes = await Promise.all(
		accounts.map((account) => owner.acquire(appId, account)),
	);
	for (const [index, lifetime] of lifetimes.entries()) {
		await expect(owner.acquire(appId, accounts[index]!)).rejects.toThrow();
		const database = await lifetime.open('mail');
		expectOk(await database.run('CREATE TABLE marker (value INTEGER)'));
		expectOk(await database.run('INSERT INTO marker VALUES (?)', [index]));
	}
	const other = await owner.acquire('so.epicenter.other', null);
	expect(
		expectOk(
			await (await other.open('mail')).all('SELECT name FROM sqlite_master'),
		),
	).toEqual([]);
	await lifetimes[1]!.delete('mail');
	for (const [index, lifetime] of lifetimes.entries()) {
		if (index === 1) continue;
		expect(
			expectOk(
				await (await lifetime.open('mail')).all('SELECT value FROM marker'),
			),
		).toEqual([{ value: index }]);
	}
	await Promise.all([...lifetimes, other].map((lifetime) => lifetime.close()));
	await rm(root, { recursive: true });
});

test('owner validates scope and database names before constructing paths', async () => {
	const { root, owner } = await setup();
	await expect(owner.acquire('../escape', null)).rejects.toThrow();
	await expect(
		owner.acquire(appId, {
			authorityId: '..',
			principalId: asPrincipalId('alice'),
		}),
	).rejects.toThrow();
	const lifetime = await owner.acquire(appId, null);
	await expect(lifetime.open('../escape')).rejects.toThrow();
	await expect(lifetime.delete('../escape')).rejects.toThrow();
	await lifetime.close();
	await rm(root, { recursive: true });
});
