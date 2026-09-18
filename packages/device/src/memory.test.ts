/**
 * Memory SQL uses the production WASM adapter and physical per-App connections.
 * Committed bytes survive close; transactions and temporary state do not.
 * Independent runtimes isolate equal names, and disposal rejects active leases.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createMemorySqliteOwner } from './memory.js';
import { createAppSqlite } from './owner.js';

const appId = 'so.epicenter.memory-test';

test('close retains committed data but rolls back transactions and clears temporary tables', async () => {
	const runtime = createMemorySqliteOwner();
	const first = createAppSqlite(runtime.owner, appId);
	const db = expectOk(await first.value.open('notes'));
	expectOk(await db.run('CREATE TABLE notes (title TEXT)'));
	expectOk(await db.run("INSERT INTO notes VALUES ('kept')"));
	expectOk(await db.run('CREATE TEMP TABLE transient (value TEXT)'));
	expectOk(await db.run('BEGIN'));
	expectOk(await db.run("INSERT INTO notes VALUES ('rollback')"));
	await first.close();
	expectErr(await db.all('SELECT 1'));
	const reopened = createAppSqlite(runtime.owner, appId);
	const next = expectOk(await reopened.value.open('notes'));
	expect(
		expectOk(await next.query('SELECT title FROM notes', { tables: ['notes'] }))
			.rows,
	).toEqual([['kept']]);
	expect(
		expectOk(
			await next.all(
				"SELECT name FROM sqlite_temp_master WHERE name='transient'",
			),
		),
	).toEqual([]);
	expectErr(await next.query('DELETE FROM notes', { tables: ['notes'] }));
	expectOk(await next.run("INSERT INTO notes VALUES ('trusted')"));
	await reopened.close();
	runtime.dispose();
});

test('duplicate leases and disposal during pending acquisition are refused', async () => {
	const runtime = createMemorySqliteOwner();
	const pending = runtime.owner.acquire(appId);
	expect(() => runtime.dispose()).toThrow('still open');
	const lease = await pending;
	await expect(runtime.owner.acquire(appId)).rejects.toThrow(
		'already acquired',
	);
	await lease.close();
	await lease.close();
	runtime.dispose();
	runtime.dispose();
	await expect(runtime.owner.acquire(appId)).rejects.toThrow('disposed');
});

test('equal names in independent runtimes isolate data and deletion invalidates old handles', async () => {
	const firstRuntime = createMemorySqliteOwner();
	const secondRuntime = createMemorySqliteOwner();
	const first = createAppSqlite(firstRuntime.owner, appId);
	const second = createAppSqlite(secondRuntime.owner, appId);
	const db = expectOk(await first.value.open('notes'));
	expectOk(await db.run('CREATE TABLE notes (title TEXT)'));
	const isolated = expectOk(await second.value.open('notes'));
	expectErr(await isolated.all('SELECT * FROM notes'));
	expectOk(await first.value.delete('notes'));
	expectErr(await db.all('SELECT 1'));
	const fresh = expectOk(await first.value.open('notes'));
	expectErr(await fresh.all('SELECT * FROM notes'));
	await first.close();
	await second.close();
	firstRuntime.dispose();
	secondRuntime.dispose();
});
