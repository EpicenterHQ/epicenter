/**
 * `syncMailbox` end to end against a fake `GmailClient` (an in-memory mailbox,
 * not an HTTP mock server): exercises the FULL-pull path, the INCREMENTAL
 * history-folding path (`foldHistoryRecords`'s upsert/delete/labelPatch
 * resolution), and the mid-pass fallback to FULL when `history.list` reports
 * an expired cursor.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { type MailDb, openMailDb } from './db.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import type { GmailMessage, HistoryPage } from './schema.ts';
import { syncMailbox } from './sync.ts';

function tempDb(): { db: MailDb; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-sync-test-'));
	const db = openMailDb({ dataDir: dir, accountEmail: 'you@example.com' });
	return {
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function message(id: string, over: Partial<GmailMessage> = {}): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
		...over,
	};
}

/** An in-memory fake standing in for the real HTTP `GmailClient`. */
function createFakeGmailClient(seed: {
	mailbox: Map<string, GmailMessage>;
	historyPages: HistoryPage[];
	profileHistoryId: string;
	labels?: { id: string; name: string; type: string }[];
}): GmailClient & {
	calls: { getMessage: () => number; listLabels: () => number };
} {
	let historyCallCount = 0;
	let getMessageCallCount = 0;
	let listLabelsCallCount = 0;
	return {
		calls: {
			getMessage: () => getMessageCallCount,
			listLabels: () => listLabelsCallCount,
		},
		async listMessageIds() {
			return { data: { ids: [...seed.mailbox.keys()] }, error: null };
		},
		async getMessage(id) {
			getMessageCallCount += 1;
			const found = seed.mailbox.get(id);
			if (!found) return GmailApiError.Http({ status: 404, body: 'not found' });
			return { data: found, error: null };
		},
		async modifyMessage(id) {
			const found = seed.mailbox.get(id);
			if (!found) return GmailApiError.Http({ status: 404, body: 'not found' });
			return { data: found, error: null };
		},
		async trashMessage(id) {
			const found = seed.mailbox.get(id);
			if (!found) return GmailApiError.Http({ status: 404, body: 'not found' });
			return { data: found, error: null };
		},
		async untrashMessage(id) {
			const found = seed.mailbox.get(id);
			if (!found) return GmailApiError.Http({ status: 404, body: 'not found' });
			return { data: found, error: null };
		},
		async listHistory() {
			const page = seed.historyPages[historyCallCount];
			historyCallCount += 1;
			if (!page) throw new Error('fake client: no more history pages seeded');
			return { data: page, error: null };
		},
		async listLabels() {
			listLabelsCallCount += 1;
			return { data: seed.labels ?? [], error: null };
		},
		async getProfile() {
			return { data: { historyId: seed.profileHistoryId }, error: null };
		},
	};
}

const config: AppConfig = {
	dataDir: '/tmp/local-mail-test',
	apiBase: 'http://localhost:0',
	authorizeUrl: 'http://localhost:0/auth',
	tokenUrl: 'http://localhost:0/token',
	historySafeWindowDays: 5,
	fullBackstopDays: 30,
	pageSize: 100,
	credentialsPath: '/tmp/local-mail-test/credentials.json',
	account: null,
	readOnly: false,
};

describe('syncMailbox: FULL pull', () => {
	test('first run pulls every message, labels, and records the profile historyId as cursor', async () => {
		const { db, cleanup } = tempDb();
		const mailbox = new Map([
			['m1', message('m1')],
			['m2', message('m2')],
		]);
		const client = createFakeGmailClient({
			mailbox,
			historyPages: [],
			profileHistoryId: '1000',
			labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-07-01T00:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.mode).toBe('FULL');
		expect(outcome.failure).toBeNull();
		expect(outcome.messagesUpserted).toBe(2);
		expect(outcome.cursorAfter).toBe('1000');
		expect(db.readRealmState().historyId).toBe('1000');

		const row = db.raw
			.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE id = ?`)
			.get('m1');
		expect(row?.id).toBe('m1');
		cleanup();
	});

	test('full pull reads the profile baseline before listing page 1', async () => {
		const { db, cleanup } = tempDb();
		const mailbox = new Map([['m1', message('m1')]]);
		const order: string[] = [];
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getProfile() {
				order.push('getProfile');
				return { data: { historyId: '1000' }, error: null };
			},
			async listMessageIds(pageToken) {
				order.push(`listMessageIds:${pageToken ?? 'first'}`);
				return { data: { ids: [...mailbox.keys()] }, error: null };
			},
		};

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-07-01T00:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(order.slice(0, 2)).toEqual(['getProfile', 'listMessageIds:first']);
		cleanup();
	});

	test('messages.get concurrency stays at or under 8 during a full pull', async () => {
		const { db, cleanup } = tempDb();
		const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
		const mailbox = new Map(ids.map((id) => [id, message(id)]));
		let active = 0;
		let highWater = 0;
		const release = Promise.withResolvers<void>();
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getMessage(id) {
				active += 1;
				highWater = Math.max(highWater, active);
				await release.promise;
				active -= 1;
				const found = mailbox.get(id);
				if (!found)
					return GmailApiError.Http({ status: 404, body: 'not found' });
				return { data: found, error: null };
			},
		};

		const syncing = syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-07-01T00:00:00.000Z') },
			{ forceFull: true },
		);
		while (highWater < 8) await Bun.sleep(1);
		expect(active).toBe(8);
		release.resolve();
		const outcome = await syncing;

		expect(outcome.failure).toBeNull();
		expect(highWater).toBeLessThanOrEqual(8);
		cleanup();
	});

	test('messages.get failure in a full-pull page bounds calls and leaves the cursor unchanged', async () => {
		const { db, cleanup } = tempDb();
		const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
		const mailbox = new Map(ids.map((id) => [id, message(id)]));
		let getMessageCalls = 0;
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getMessage(id) {
				getMessageCalls += 1;
				if (id === 'm1') {
					return GmailApiError.Http({ status: 500, body: 'boom' });
				}
				const found = mailbox.get(id);
				if (!found)
					return GmailApiError.Http({ status: 404, body: 'not found' });
				return { data: found, error: null };
			},
		};

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-07-01T00:00:00.000Z') },
			{ forceFull: true },
		);

		expect(outcome.failure?.name).toBe('Http');
		expect(outcome.cursorAfter).toBeNull();
		expect(db.readRealmState().historyId).toBeNull();
		expect(getMessageCalls).toBeLessThanOrEqual(8);
		cleanup();
	});

	test('full pull deletes rows absent from the listed mailbox', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[message('kept'), message('stale')],
			'2026-06-30T00:00:00.000Z',
		);
		db.finishFullPull('500', '2026-06-30T00:00:00.000Z');
		const mailbox = new Map([['kept', message('kept')]]);
		const client = createFakeGmailClient({
			mailbox,
			historyPages: [],
			profileHistoryId: '1000',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-07-01T00:00:00.000Z') },
			{ forceFull: true },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.messagesDeleted).toBe(1);
		expect(
			db.raw
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM messages WHERE id = 'stale'`,
				)
				.get()?.n,
		).toBe(0);
		expect(
			db.raw
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM messages WHERE id = 'kept'`,
				)
				.get()?.n,
		).toBe(1);
		cleanup();
	});
});

describe('syncMailbox: INCREMENTAL', () => {
	function seededDb(): { db: MailDb; cleanup: () => void } {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('existing')], '2026-06-30T00:00:00.000Z');
		db.ingestLabels(
			[{ id: 'INBOX', name: 'INBOX', type: 'system' }],
			'2026-06-30T00:00:00.000Z',
		);
		db.finishFullPull('500', '2026-06-30T00:00:00.000Z');
		return { db, cleanup };
	}

	test('messagesAdded fetches and upserts full content', async () => {
		const { db, cleanup } = seededDb();
		const mailbox = new Map([['new-msg', message('new-msg')]]);
		const client = createFakeGmailClient({
			mailbox,
			historyPages: [
				{
					historyId: '501',
					history: [
						{
							id: 'h1',
							messagesAdded: [
								{ message: { id: 'new-msg', threadId: 't-new-msg' } },
							],
						},
					],
				},
			],
			profileHistoryId: '999', // must not be used; INCREMENTAL doesn't call getProfile
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.mode).toBe('INCREMENTAL');
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.cursorAfter).toBe('501');
		const row = db.raw
			.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE id = ?`)
			.get('new-msg');
		expect(row?.id).toBe('new-msg');
		cleanup();
	});

	test('incremental pass refreshes labels once and advances the cursor', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['INBOX', 'Label_1'],
									},
									labelIds: ['Label_1'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
			labels: [
				{ id: 'INBOX', name: 'INBOX', type: 'system' },
				{ id: 'Label_1', name: 'Work', type: 'user' },
			],
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(client.calls.listLabels()).toBe(1);
		const label = db.raw
			.query<{ name: string }, [string]>(`SELECT name FROM labels WHERE id = ?`)
			.get('Label_1');
		expect(label?.name).toBe('Work');
		cleanup();
	});

	test('incremental pass refreshes labels even when all referenced labels are known', async () => {
		const { db, cleanup } = seededDb();
		db.ingestLabels(
			[
				{ id: 'INBOX', name: 'INBOX', type: 'system' },
				{ id: 'IMPORTANT', name: 'Old important', type: 'system' },
			],
			'2026-06-30T00:00:00.000Z',
		);
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['INBOX', 'IMPORTANT'],
									},
									labelIds: ['IMPORTANT'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
			labels: [
				{ id: 'INBOX', name: 'INBOX', type: 'system' },
				{ id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
			],
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(client.calls.listLabels()).toBe(1);
		const label = db.raw
			.query<{ name: string }, [string]>(`SELECT name FROM labels WHERE id = ?`)
			.get('IMPORTANT');
		expect(label?.name).toBe('IMPORTANT');
		cleanup();
	});

	test('referenced label absent from labels.list refreshes once per pass and terminates', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['INBOX', 'Label_missing'],
									},
									labelIds: ['Label_missing'],
								},
							],
						},
					],
				},
				{ historyId: '503', history: undefined },
			],
			profileHistoryId: '999',
			labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
		});

		const first = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);
		const second = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:01:00.000Z') },
			{ forceFull: false },
		);

		expect(first.failure).toBeNull();
		expect(first.cursorAfter).toBe('502');
		expect(second.failure).toBeNull();
		expect(second.cursorAfter).toBe('503');
		expect(client.calls.listLabels()).toBe(2);
		cleanup();
	});

	test('labels.list failure logs and still advances the cursor', async () => {
		const { db, cleanup } = seededDb();
		const logs: string[] = [];
		const client: GmailClient & {
			calls: { getMessage: () => number; listLabels: () => number };
		} = {
			...createFakeGmailClient({
				mailbox: new Map(),
				historyPages: [
					{
						historyId: '502',
						history: [
							{
								id: 'h1',
								labelsAdded: [
									{
										message: {
											id: 'existing',
											threadId: 't-existing',
											labelIds: ['INBOX', 'Label_1'],
										},
										labelIds: ['Label_1'],
									},
								],
							},
						],
					},
				],
				profileHistoryId: '999',
			}),
			async listLabels() {
				return GmailApiError.Http({ status: 500, body: 'labels down' });
			},
		};

		const outcome = await syncMailbox(
			{
				db,
				client,
				config,
				now: () => Date.parse('2026-06-30T01:00:00.000Z'),
				log: (message) => logs.push(message),
			},
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(logs.join('\n')).toContain('labels.list failed');
		cleanup();
	});

	test('a label change on a mirrored message patches labelIds without a messages.get call', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(), // empty: a fetch here would 404 and evict the row
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['INBOX', 'IMPORTANT'],
									},
									labelIds: ['IMPORTANT'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.labelsPatched).toBe(1);
		expect(client.calls.getMessage()).toBe(0);
		const row = db.raw
			.query<{ label_ids: string }, [string]>(
				`SELECT label_ids FROM messages WHERE id = ?`,
			)
			.get('existing');
		expect(JSON.parse(row?.label_ids ?? '[]')).toEqual(['INBOX', 'IMPORTANT']);
		cleanup();
	});

	test('an idempotent history echo of already-current labels reports labelsPatched 0', async () => {
		const { db, cleanup } = seededDb();
		// The seeded row already carries exactly ['INBOX']; a labelsAdded echo of
		// the same set (the shape the reconciler's fold produces, then Gmail replays
		// through history) touches the row but changes nothing material.
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['INBOX'],
									},
									labelIds: ['INBOX'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(outcome.labelsPatched).toBe(0);
		cleanup();
	});

	test('a labels echo in a different order is not counted as a material change', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[message('existing', { labelIds: ['INBOX', 'IMPORTANT'] })],
			'2026-06-30T00:00:00.000Z',
		);
		db.finishFullPull('500', '2026-06-30T00:00:00.000Z');
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '502',
					history: [
						{
							id: 'h1',
							labelsAdded: [
								{
									message: {
										id: 'existing',
										threadId: 't-existing',
										labelIds: ['IMPORTANT', 'INBOX'],
									},
									labelIds: ['IMPORTANT'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(outcome.labelsPatched).toBe(0);
		cleanup();
	});

	test('labelsRemoved for an unmirrored message refetches it (untrash after a full-pull sweep)', async () => {
		const { db, cleanup } = seededDb();
		const mailbox = new Map([
			['untrashed', message('untrashed', { labelIds: ['INBOX'] })],
		]);
		const client = createFakeGmailClient({
			mailbox,
			historyPages: [
				{
					historyId: '504',
					history: [
						{
							id: 'h1',
							labelsRemoved: [
								{
									message: {
										id: 'untrashed',
										threadId: 't-untrashed',
										labelIds: ['INBOX'],
									},
									labelIds: ['TRASH'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(client.calls.getMessage()).toBe(1);
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.cursorAfter).toBe('504');
		const row = db.raw
			.query<{ subject: string | null }, [string]>(
				`SELECT subject FROM messages WHERE id = ?`,
			)
			.get('untrashed');
		expect(row?.subject).toBe('Subject untrashed');
		cleanup();
	});

	test('a refetch for an unmirrored label patch that 404s leaves no row and still advances the cursor', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(), // getMessage 404s: gone again before we fetched
			historyPages: [
				{
					historyId: '504',
					history: [
						{
							id: 'h1',
							labelsRemoved: [
								{
									message: {
										id: 'gone',
										threadId: 't-gone',
										labelIds: ['INBOX'],
									},
									labelIds: ['TRASH'],
								},
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.failure).toBeNull();
		expect(client.calls.getMessage()).toBe(1);
		expect(outcome.cursorAfter).toBe('504');
		const row = db.raw
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM messages WHERE id = 'gone'`,
			)
			.get();
		expect(row?.n).toBe(0);
		cleanup();
	});

	test('messagesDeleted physically removes the row', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [
				{
					historyId: '503',
					history: [
						{
							id: 'h1',
							messagesDeleted: [
								{ message: { id: 'existing', threadId: 't-existing' } },
							],
						},
					],
				},
			],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.messagesDeleted).toBe(1);
		const row = db.raw
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM messages WHERE id = 'existing'`,
			)
			.get();
		expect(row?.n).toBe(0);
		cleanup();
	});

	test('a no-history-key page (nothing changed) advances the cursor to the same value without touching rows', async () => {
		const { db, cleanup } = seededDb();
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [{ historyId: '500', history: undefined }],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.messagesUpserted).toBe(0);
		expect(outcome.messagesDeleted).toBe(0);
		expect(outcome.cursorAfter).toBe('500');
		cleanup();
	});

	test('an expired cursor (404) mid-pass falls back to FULL within the same call', async () => {
		const { db, cleanup } = seededDb();
		const mailbox = new Map([['fresh', message('fresh')]]);
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox,
				historyPages: [],
				profileHistoryId: '9000',
			}),
			async listHistory() {
				return GmailApiError.HistoryExpired();
			},
		};

		const outcome = await syncMailbox(
			{ db, client, config, now: () => Date.parse('2026-06-30T01:00:00.000Z') },
			{ forceFull: false },
		);

		expect(outcome.mode).toBe('FULL');
		expect(outcome.reason).toBe('historyId expired mid-pass');
		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('9000');
		expect(db.readRealmState().historyId).toBe('9000');
		cleanup();
	});
});

describe('syncMailbox: concurrent writers', () => {
	test('a mirror locked past the busy timeout reports MirrorBusy instead of throwing', async () => {
		const { db, cleanup } = tempDb();
		// Shrink the production 5s timeout so the test fails fast.
		db.raw.exec('PRAGMA busy_timeout = 50;');
		const rival = new Database(db.raw.filename);
		rival.exec('BEGIN IMMEDIATE;');

		const client = createFakeGmailClient({
			mailbox: new Map([['m1', message('m1')]]),
			historyPages: [],
			profileHistoryId: '1000',
		});
		const deps = {
			db,
			client,
			config,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		};

		const outcome = await syncMailbox(deps, { forceFull: true });
		expect(outcome.failure?.name).toBe('MirrorBusy');
		expect(outcome.cursorAfter).toBe(outcome.cursorBefore);

		// The lock released: the very next pass succeeds against the same handle.
		rival.exec('ROLLBACK;');
		rival.close();
		const retry = await syncMailbox(deps, { forceFull: true });
		expect(retry.failure).toBeNull();
		expect(db.readRealmState().historyId).toBe('1000');
		cleanup();
	});
});
