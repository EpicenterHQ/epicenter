/**
 * How each of Local Mail's two kinds of file is opened, which is the only code
 * here that destroys data.
 *
 * The durable file is migrated and never unlinked, and it refuses a shape from
 * the future rather than writing through it. A borrowed file is demolished
 * whenever its shape is not the one this build understands, in either
 * direction, because Gmail still has the originals (ADR-0319). Those two
 * sentences are opposite policies applied by one module, so the tests that
 * matter are the ones that prove the policies cannot be swapped.
 */

import { expect, test } from 'bun:test';
import { type AppSqliteDatabase, type Device } from '@epicenter/device';
import { Ok } from 'wellcrafted/result';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import {
	LOCAL_SCHEMA_VERSION,
	MAIL_SCHEMA_VERSION,
	openLocalMailStorage,
	requireAccountFiling,
} from './storage.ts';

/**
 * A storage owner over in-memory databases, keyed by name the way the host
 * keys files, so `sqlite.delete` is observable as the name losing its contents.
 */
function testOwner() {
	const files = new Map<string, ReturnType<typeof createTestAppSqlite>>();
	const deleted: string[] = [];
	const device = {
		appId: 'so.epicenter.local-mail',
		sqlite: {
			open: async (name: string) => {
				const existing = files.get(name);
				if (existing !== undefined) return Ok(existing);
				const opened = createTestAppSqlite();
				files.set(name, opened);
				return Ok(opened);
			},
			delete: async (name: string) => {
				deleted.push(name);
				files.get(name)?.close();
				files.delete(name);
				return Ok(undefined);
			},
		},
	} as unknown as Device;
	return { device, files, deleted };
}

const version = async (database: AppSqliteDatabase): Promise<number> => {
	const rows = await database.all<{ user_version: number }>(
		'PRAGMA user_version',
	);
	if (rows.error !== null) throw rows.error;
	return rows.data[0]?.user_version ?? 0;
};

const stamp = async (database: AppSqliteDatabase, at: number) => {
	const set = await database.run(`PRAGMA user_version = ${at}`);
	if (set.error !== null) throw set.error;
};

test('a first open creates the durable file and stamps its version', async () => {
	const owner = testOwner();
	const storage = await openLocalMailStorage(owner.device);

	expect(await version(storage.local)).toBe(LOCAL_SCHEMA_VERSION);
	const tables = await storage.local.all<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
	);
	expect(tables.data?.map((row) => row.name)).toEqual([
		'accounts',
		'intent_counters',
		'label_intents',
		'last_pass',
	]);
	// The durable file is never deleted, not even to create it.
	expect(owner.deleted).toEqual([]);
});

test('the durable file refuses a shape written by a newer build', async () => {
	const owner = testOwner();
	const opened = await owner.device.sqlite.open('local');
	if (opened.error !== null) throw opened.error;
	await stamp(opened.data, LOCAL_SCHEMA_VERSION + 1);

	// Writing through it would lose the columns this build does not know about,
	// and these bytes cannot be fetched again.
	expect(openLocalMailStorage(owner.device)).rejects.toThrow(/newer version/);
	expect(owner.deleted).toEqual([]);
});

test('a mail file at the wrong shape is demolished, in either direction', async () => {
	for (const wrong of [0, MAIL_SCHEMA_VERSION + 1]) {
		const owner = testOwner();
		const storage = await openLocalMailStorage(owner.device);
		const name = requireAccountFiling('sub-one').database;

		const stale = await owner.device.sqlite.open(name);
		if (stale.error !== null) throw stale.error;
		await stale.data.run('CREATE TABLE gone (id TEXT)');
		await stale.data.run(`INSERT INTO gone VALUES ('row')`);
		await stamp(stale.data, wrong);

		const mail = await storage.mail('sub-one');
		expect(owner.deleted).toEqual([name]);
		expect(await version(mail)).toBe(MAIL_SCHEMA_VERSION);
		const tables = await mail.all<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
		);
		expect(tables.data?.map((row) => row.name)).toEqual([
			'labels',
			'messages',
			'sync_state',
		]);
	}
});

test('the first open of an account creates its file without deleting one', async () => {
	const owner = testOwner();
	const storage = await openLocalMailStorage(owner.device);

	const mail = await storage.mail('sub-one');
	expect(await version(mail)).toBe(MAIL_SCHEMA_VERSION);
	// Deleting a file created one statement ago to create it again is a round
	// trip that buys nothing, and on the desktop it is a real unlink.
	expect(owner.deleted).toEqual([]);
});

test('a mail file already at this shape is opened, not demolished', async () => {
	const owner = testOwner();
	const storage = await openLocalMailStorage(owner.device);

	const first = await storage.mail('sub-one');
	await first.run(`UPDATE sync_state SET history_id = '9' WHERE id = 1`);
	owner.deleted.length = 0;

	// A second call joins the open it already performed, and a second storage
	// over the same owner finds the file at the right version and leaves it.
	expect(await storage.mail('sub-one')).toBe(first);
	const reopened = await openLocalMailStorage(owner.device);
	const again = await reopened.mail('sub-one');
	const rows = await again.all<{ value: string }>(
		`SELECT history_id AS value FROM sync_state WHERE id = 1`,
	);
	expect(rows.data?.[0]?.value).toBe('9');
	expect(owner.deleted).toEqual([]);
});

test('two accounts are two files, and forgetting one leaves the other', async () => {
	const owner = testOwner();
	const storage = await openLocalMailStorage(owner.device);
	const one = await storage.mail('sub-one');
	const two = await storage.mail('sub-two');
	await one.run(`UPDATE sync_state SET history_id = '1' WHERE id = 1`);
	await two.run(`UPDATE sync_state SET history_id = '2' WHERE id = 1`);

	await storage.forgetMail('sub-one');
	expect(owner.deleted).toEqual([requireAccountFiling('sub-one').database]);
	expect(owner.files.has(requireAccountFiling('sub-two').database)).toBe(true);

	// The next open of a forgotten account is a new empty file, not the handle
	// that was evicted with it.
	const reopened = await storage.mail('sub-one');
	const rows = await reopened.all(`SELECT history_id AS value FROM sync_state`);
	expect(rows.data).toEqual([{ value: null }]);
	expect(
		(await two.all(`SELECT history_id AS value FROM sync_state`)).data,
	).toHaveLength(1);
});

test('new account storage reopens with cached mail and durable pending triage intact', async () => {
	const owner = testOwner();
	const first = await openLocalMailStorage(owner.device);
	await first.local.run(
		"INSERT INTO accounts VALUES ('one', 'one@example.com', 'today')",
	);
	await first.local.run(
		"INSERT INTO label_intents VALUES ('one', 'message', 'INBOX', 0, 1, 'today')",
	);
	const cache = await first.mail('one');
	await cache.run(
		"INSERT INTO messages (id, resource, synced_at) VALUES ('message', '{}', 'today')",
	);
	const reopened = await openLocalMailStorage(owner.device);
	expect((await reopened.local.all('SELECT sub FROM accounts')).data).toEqual([
		{ sub: 'one' },
	]);
	expect(
		(await reopened.local.all('SELECT revision FROM label_intents')).data,
	).toEqual([{ revision: 1 }]);
	expect(
		(await (await reopened.mail('one')).all('SELECT id FROM messages')).data,
	).toEqual([{ id: 'message' }]);
	expect(owner.deleted).toEqual([]);
});
