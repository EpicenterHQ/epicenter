import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunDevice } from './device.ts';

const local = { kind: 'local' } as const;

test('application SQLite is scoped, async, and batch is atomic', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	const storage = createBunDevice(root);
	const first = await storage.open('so.epicenter.mail', local, 'mail');
	const second = await storage.open('so.epicenter.other', local, 'mail');
	const account = await storage.open(
		'so.epicenter.mail',
		{ kind: 'account', authorityId: 'cloud', principalId: 'alice' },
		'mail',
	);

	const schema = await first.batch([
		{ sql: 'CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT)' },
		{ sql: 'INSERT INTO messages VALUES (?, ?)', parameters: ['one', 'Hello'] },
	]);
	expect(schema.error).toBeNull();

	const rows = await first.all<{ id: string; subject: string }>(
		'SELECT id, subject FROM messages',
	);
	expect(rows.data).toEqual([{ id: 'one', subject: 'Hello' }]);

	const failed = await first.batch([
		{ sql: 'INSERT INTO messages VALUES (?, ?)', parameters: ['two', 'World'] },
		{ sql: 'INSERT INTO missing VALUES (?)', parameters: ['never'] },
	]);
	expect(failed.error).not.toBeNull();
	const afterFailure = await first.all<{ id: string }>(
		'SELECT id FROM messages',
	);
	expect(afterFailure.data).toEqual([{ id: 'one' }]);

	const isolated = await second.all('SELECT name FROM sqlite_master');
	expect(isolated.data).toEqual([]);
	await second.run('CREATE TABLE only_here (id TEXT)');
	await account.run('CREATE TABLE account_only (id TEXT)');
	const mailPath = join(
		root,
		'apps',
		'so.epicenter.mail',
		'local',
		'sqlite',
		'mail.sqlite',
	);
	const otherPath = join(
		root,
		'apps',
		'so.epicenter.other',
		'local',
		'sqlite',
		'mail.sqlite',
	);
	const accountPath = join(
		root,
		'apps',
		'so.epicenter.mail',
		'accounts',
		'cloud',
		'alice',
		'sqlite',
		'mail.sqlite',
	);
	expect(Bun.file(mailPath).size).toBeGreaterThan(0);
	expect(Bun.file(otherPath).size).toBeGreaterThan(0);
	expect(Bun.file(accountPath).size).toBeGreaterThan(0);
});

test('an open that failed is not remembered', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	const storage = createBunDevice(root);

	// A file where the application's directory belongs, so `mkdir` fails the
	// way a locked or full disk would, and clears the same way.
	const appDir = join(root, 'apps', 'so.epicenter.mail');
	await mkdir(join(root, 'apps'), { recursive: true });
	await Bun.write(appDir, 'in the way');
	await expect(storage.open('so.epicenter.mail', local, 'mail')).rejects.toThrow();

	await rm(appDir);
	const opened = await storage.open('so.epicenter.mail', local, 'mail');
	expect(
		(await opened.run('CREATE TABLE recovered (id TEXT)')).error,
	).toBeNull();
});

test('deleting a database closes it, removes the file, and forgets the name', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	const storage = createBunDevice(root);
	const path = join(root, 'apps', 'so.epicenter.mail', 'local', 'sqlite', 'mail.sqlite');

	const before = await storage.open('so.epicenter.mail', local, 'mail');
	await before.run('CREATE TABLE messages (id TEXT)');
	await before.run('INSERT INTO messages VALUES (?)', ['one']);
	expect(await Bun.file(path).exists()).toBe(true);

	await storage.delete('so.epicenter.mail', local, 'mail');
	expect(await Bun.file(path).exists()).toBe(false);
	// The closed handle stays closed: an application holding it past a deletion
	// is holding a connection to a file that is gone, and must be told so.
	expect((await before.all('SELECT id FROM messages')).error).not.toBeNull();

	// Opening the same name again is a new, empty database rather than the
	// evicted handle.
	const after = await storage.open('so.epicenter.mail', local, 'mail');
	expect((await after.all('SELECT name FROM sqlite_master')).data).toEqual([]);
});

test('deleting a database that was never created succeeds', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	const storage = createBunDevice(root);
	await storage.delete('so.epicenter.mail', local, 'never');
});
