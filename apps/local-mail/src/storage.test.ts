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
import { sqliteHandle } from './handle.ts';
import { openIntentStore } from './intent-store.ts';
import { openMailbox } from './mailbox.ts';
import { openPassRecord } from './outbox.ts';
import {
	LOCAL_SCHEMA_VERSION,
	MAIL_SCHEMA_VERSION,
	openLocalMailStorage,
	requireAccountFiling,
} from './storage.ts';
// Frozen SQL from the shipped v1 shape: migration tests must not derive their
// starting point from the schema they are meant to validate.
import legacySchema from './storage-v1.test-fixture.json';

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

async function legacyFile(
	owner: ReturnType<typeof testOwner>,
	name: string,
	schema: readonly string[],
) {
	const opened = await owner.device.sqlite.open(name);
	if (opened.error) throw opened.error;
	const db = sqliteHandle(opened.data);
	await db.batch(
		[...schema, 'PRAGMA user_version = 1'].map((sql) => ({ sql })),
	);
	return opened.data;
}

test('durable v1 migration preserves pending revisions, empty-outbox counters, and failure explanations', async () => {
	const owner = testOwner();
	const old = await legacyFile(owner, 'local', legacySchema.local);
	const db = sqliteHandle(old);
	await db.batch([
		{
			sql: `INSERT INTO accounts VALUES ('one', 'one@example.com', 'connected', 'synced')`,
		},
		{
			sql: `INSERT INTO label_intents VALUES ('one', 'm1', 'TRASH', 1, 17, 'asserted')`,
		},
		{
			sql: `INSERT INTO intent_meta VALUES ('one', 'next_seq', '4'), ('empty', 'next_seq', '90'), ('null-counter', 'next_seq', NULL)`,
		},
		{
			sql: `INSERT INTO last_pass VALUES ('one', 'finished', 2, 1, '[]', 'signin', 'CredentialMissing', 'Reconnect Gmail')`,
		},
	]);
	const storage = await openLocalMailStorage(owner.device);
	expect(await version(storage.local)).toBe(2);
	const intents = openIntentStore(storage.local, 'one');
	expect(await intents.pending()).toEqual([
		{
			messageId: 'm1',
			labelId: 'TRASH',
			want: true,
			revision: 17,
			assertedAt: 'asserted',
		},
	]);
	await intents.assert(
		[{ messageId: 'm1', labelId: 'TRASH', want: false }],
		'undo',
	);
	expect((await intents.pending())[0]?.revision).toBe(18);
	const empty = openIntentStore(storage.local, 'empty');
	await empty.assert(
		[{ messageId: 'm2', labelId: 'INBOX', want: false }],
		'now',
	);
	expect((await empty.pending())[0]?.revision).toBe(90);
	const nullCounter = openIntentStore(storage.local, 'null-counter');
	await nullCounter.assert(
		[{ messageId: 'm3', labelId: 'INBOX', want: false }],
		'now',
	);
	expect((await nullCounter.pending())[0]?.revision).toBe(1);
	expect(await openPassRecord(storage.local, 'one').read()).toEqual({
		finishedAt: 'finished',
		discarded: [],
		failure: {
			kind: 'signin',
			name: 'CredentialMissing',
			message: 'Reconnect Gmail',
		},
	});
	expect(await db.all('SELECT * FROM accounts')).toEqual([
		{ sub: 'one', email: 'one@example.com', connected_at: 'connected' },
	]);
	expect(owner.deleted).toEqual([]);
});

for (const complete of [false, true]) {
	test(`cache v1 migration preserves mail and ${complete ? 'complete' : 'incomplete'} pull state`, async () => {
		const owner = testOwner();
		const old = await legacyFile(
			owner,
			requireAccountFiling('one').database,
			legacySchema.mail,
		);
		const db = sqliteHandle(old);
		const resource = JSON.stringify({
			id: 'm1',
			threadId: 'thread',
			labelIds: ['INBOX'],
			snippet: 'hello',
			internalDate: '100',
		});
		await db.batch([
			{
				sql: `INSERT INTO messages (id, resource, subject, sender, body_text, synced_at) VALUES ('m1', ?, 'subject', 'sender', 'body', 'seen')`,
				parameters: [resource],
			},
			{
				sql: `INSERT INTO labels (id, resource, synced_at) VALUES ('INBOX', '{"id":"INBOX","name":"Inbox","type":"system"}', 'seen')`,
			},
			...(complete
				? [
						{
							sql: `INSERT INTO cache_meta VALUES ('history_id', '123'), ('last_full_pull_at', 'full'), ('last_synced_at', 'latest')`,
						},
					]
				: []),
		]);
		const storage = await openLocalMailStorage(owner.device);
		const current = await storage.mail('one');
		expect(await version(current)).toBe(MAIL_SCHEMA_VERSION);
		expect(await openMailbox(current).readCacheState()).toEqual({
			historyId: null,
			lastSyncedAt: complete ? 'latest' : null,
		});
		expect(
			await db.all(
				'SELECT id, resource, subject, sender, body_text, synced_at FROM messages',
			),
		).toEqual([
			{
				id: 'm1',
				resource,
				subject: 'subject',
				sender: 'sender',
				body_text: 'body',
				synced_at: 'seen',
			},
		]);
		expect(await db.all('SELECT id, name FROM labels')).toEqual([
			{ id: 'INBOX', name: 'Inbox' },
		]);
		expect(owner.deleted).toEqual([]);
	});
}

test('a failed durable migration rolls back schema and version without deleting data', async () => {
	const owner = testOwner();
	const old = await legacyFile(owner, 'local', legacySchema.local);
	const db = sqliteHandle(old);
	await db.run(
		`INSERT INTO accounts VALUES ('one', 'email', 'connected', 'synced')`,
	);
	// Fail after the earlier schema steps have run.
	await db.run('DROP TABLE last_pass');
	await expect(openLocalMailStorage(owner.device)).rejects.toThrow();
	expect(await version(old)).toBe(1);
	expect(await db.all('SELECT last_synced_at FROM accounts')).toEqual([
		{ last_synced_at: 'synced' },
	]);
	expect(
		await db.all(
			"SELECT name FROM sqlite_master WHERE name = 'intent_counters'",
		),
	).toEqual([]);
	expect(owner.deleted).toEqual([]);
});

test('cache v2 adoption retains offline mail and pending work, and invalidates its smaller-scope cursor once', async () => {
	const owner = testOwner();
	const opened = await owner.device.sqlite.open(
		requireAccountFiling('one').database,
	);
	if (opened.error) throw opened.error;
	const db = sqliteHandle(opened.data);
	// Frozen v2 sync shape. Other tables are unchanged by this migration.
	await db.batch([
		{
			sql: `CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), history_id TEXT, last_full_pull_at TEXT, last_synced_at TEXT)`,
		},
		{ sql: `INSERT INTO sync_state VALUES (1, '123', 'full', 'latest')` },
		{
			sql: `CREATE TABLE messages (id TEXT PRIMARY KEY, resource TEXT NOT NULL)`,
		},
		{
			sql: `INSERT INTO messages VALUES ('m1', '{"id":"m1","threadId":"t1","labelIds":["INBOX"]}')`,
		},
		{ sql: `PRAGMA user_version = 2` },
	]);
	const storage = await openLocalMailStorage(owner.device);
	const intents = openIntentStore(storage.local, 'one');
	await intents.assert(
		[{ messageId: 'm1', labelId: 'TRASH', want: true }],
		'now',
	);
	const pending = await intents.pending();
	const current = await storage.mail('one');
	expect(await version(current)).toBe(MAIL_SCHEMA_VERSION);
	expect(await db.all('SELECT * FROM sync_state')).toEqual([
		{ id: 1, history_id: null, last_synced_at: 'latest' },
	]);
	expect(await db.all('SELECT id FROM messages')).toEqual([{ id: 'm1' }]);
	expect(await intents.pending()).toEqual(pending);
	expect(owner.deleted).toEqual([]);
	await db.run("UPDATE sync_state SET history_id = '456' WHERE id = 1");
	const reopened = await openLocalMailStorage(owner.device);
	await reopened.mail('one');
	expect(
		(
			await db.all<{ history_id: string }>('SELECT history_id FROM sync_state')
		)[0]?.history_id,
	).toBe('456');
});
