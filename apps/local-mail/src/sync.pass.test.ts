/**
 * `syncMailbox` end to end against a fake `GmailClient` (an in-memory mailbox,
 * not an HTTP mock server): exercises the FULL-pull path, the INCREMENTAL
 * history-folding path (`foldHistoryRecords`'s upsert/delete/labelPatch
 * resolution), and the mid-pass fallback to FULL when `history.list` reports
 * an expired cursor.
 */

import { describe, expect, test } from 'bun:test';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import type { GmailMessage, HistoryPage } from './schema.ts';
import { openTestSession, type TestSession } from './session.test-support.ts';
import { syncMailbox } from './sync.ts';

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
			if (!page)
				return { data: { historyId: seed.profileHistoryId }, error: null };
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

describe('syncMailbox: FULL pull', () => {
	test('first run pulls every message, labels, and records the profile historyId as cursor', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		const remote = new Map([
			['m1', message('m1')],
			['m2', message('m2')],
		]);
		const client = createFakeGmailClient({
			mailbox: remote,
			historyPages: [],
			profileHistoryId: '1000',
			labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
		});

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		});

		expect(outcome.mode).toBe('FULL');
		expect(outcome.failure).toBeNull();
		expect(outcome.messagesUpserted).toBe(2);
		expect(outcome.cursorAfter).toBe('1000');
		expect((await mailbox.readCacheState()).historyId).toBe('1000');

		const row = await session.row<{ id: string }>(
			`SELECT id FROM messages WHERE id = ?`,
			['m1'],
		);
		expect(row?.id).toBe('m1');
		cleanup();
	});

	test('full pull reads the profile baseline before listing page 1', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		const remote = new Map([['m1', message('m1')]]);
		const order: string[] = [];
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox: remote,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getProfile() {
				order.push('getProfile');
				return { data: { historyId: '1000' }, error: null };
			},
			async listMessageIds(pageToken) {
				order.push(`listMessageIds:${pageToken ?? 'first'}`);
				return { data: { ids: [...remote.keys()] }, error: null };
			},
		};

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(order.slice(0, 2)).toEqual(['getProfile', 'listMessageIds:first']);
		cleanup();
	});

	test('messages.get concurrency stays at or under 8 during a full pull', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
		const remote = new Map(ids.map((id) => [id, message(id)]));
		let active = 0;
		let highWater = 0;
		const release = Promise.withResolvers<void>();
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox: remote,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getMessage(id) {
				active += 1;
				highWater = Math.max(highWater, active);
				await release.promise;
				active -= 1;
				const found = remote.get(id);
				if (!found)
					return GmailApiError.Http({ status: 404, body: 'not found' });
				return { data: found, error: null };
			},
		};

		const syncing = syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		});
		while (highWater < 8) await Bun.sleep(1);
		expect(active).toBe(8);
		release.resolve();
		const outcome = await syncing;

		expect(outcome.failure).toBeNull();
		expect(highWater).toBeLessThanOrEqual(8);
		cleanup();
	});

	test('messages.get failure in a full-pull page bounds calls and leaves the cursor unchanged', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
		const remote = new Map(ids.map((id) => [id, message(id)]));
		let getMessageCalls = 0;
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox: remote,
				historyPages: [],
				profileHistoryId: '1000',
			}),
			async getMessage(id) {
				getMessageCalls += 1;
				if (id === 'm1') {
					return GmailApiError.Http({ status: 500, body: 'boom' });
				}
				const found = remote.get(id);
				if (!found)
					return GmailApiError.Http({ status: 404, body: 'not found' });
				return { data: found, error: null };
			},
		};

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		});

		expect(outcome.failure?.name).toBe('Http');
		expect(outcome.cursorAfter).toBeNull();
		expect((await mailbox.readCacheState()).historyId).toBeNull();
		expect(getMessageCalls).toBeLessThanOrEqual(8);
		cleanup();
	});

	test('full pull deletes rows absent from the listed mailbox', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		await mailbox.ingestFullPullPage(
			[message('kept'), message('stale')],
			'2026-05-30T00:00:00.000Z',
		);

		const remote = new Map([['kept', message('kept')]]);
		const client = createFakeGmailClient({
			mailbox: remote,
			historyPages: [],
			profileHistoryId: '1000',
		});

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.messagesDeleted).toBe(1);
		expect(
			(
				await session.row<{ n: number }>(
					`SELECT count(*) AS n FROM messages WHERE id = 'stale'`,
					[],
				)
			)?.n,
		).toBe(0);
		expect(
			(
				await session.row<{ n: number }>(
					`SELECT count(*) AS n FROM messages WHERE id = 'kept'`,
					[],
				)
			)?.n,
		).toBe(1);
		cleanup();
	});
});

describe('syncMailbox: INCREMENTAL', () => {
	async function seededDb(): Promise<TestSession> {
		const session = await openTestSession();
		await session.mailbox.ingestFullPullPage(
			[message('existing')],
			'2026-06-30T00:00:00.000Z',
		);
		await session.mailbox.ingestLabels([
			{ id: 'INBOX', name: 'INBOX', type: 'system' },
		]);
		await session.mailbox.finishFullPull('500', '2026-06-30T00:00:00.000Z');
		return session;
	}

	test('messagesAdded fetches and upserts full content', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
		const remote = new Map([['new-msg', message('new-msg')]]);
		const client = createFakeGmailClient({
			mailbox: remote,
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.mode).toBe('INCREMENTAL');
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.cursorAfter).toBe('501');
		const row = await session.row<{ id: string }>(
			`SELECT id FROM messages WHERE id = ?`,
			['new-msg'],
		);
		expect(row?.id).toBe('new-msg');
		cleanup();
	});

	test('incremental pass refreshes labels once and advances the cursor', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(client.calls.listLabels()).toBe(1);
		const label = await session.row<{ name: string }>(
			`SELECT name FROM labels WHERE id = ?`,
			['Label_1'],
		);
		expect(label?.name).toBe('Work');
		cleanup();
	});

	test('incremental pass refreshes labels even when all referenced labels are known', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
		await mailbox.ingestLabels([
			{ id: 'INBOX', name: 'INBOX', type: 'system' },
			{ id: 'IMPORTANT', name: 'Old important', type: 'system' },
		]);
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(client.calls.listLabels()).toBe(1);
		const label = await session.row<{ name: string }>(
			`SELECT name FROM labels WHERE id = ?`,
			['IMPORTANT'],
		);
		expect(label?.name).toBe('IMPORTANT');
		cleanup();
	});

	test('referenced label absent from labels.list refreshes once per pass and terminates', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const first = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});
		const second = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:01:00.000Z'),
		});

		expect(first.failure).toBeNull();
		expect(first.cursorAfter).toBe('502');
		expect(second.failure).toBeNull();
		expect(second.cursorAfter).toBe('503');
		expect(client.calls.listLabels()).toBe(2);
		cleanup();
	});

	test('labels.list failure logs and still advances the cursor', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
			log: (message) => logs.push(message),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(logs.join('\n')).toContain('labels.list failed');
		cleanup();
	});

	test('a label change on a mirrored message patches labelIds without a messages.get call', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.labelsPatched).toBe(1);
		expect(client.calls.getMessage()).toBe(0);
		const row = await session.row<{ label_ids: string }>(
			`SELECT label_ids FROM messages WHERE id = ?`,
			['existing'],
		);
		expect(JSON.parse(row?.label_ids ?? '[]')).toEqual(['INBOX', 'IMPORTANT']);
		cleanup();
	});

	test('an idempotent history echo of already-current labels reports labelsPatched 0', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('502');
		expect(outcome.labelsPatched).toBe(0);
		cleanup();
	});

	test('a labels echo in a different order is not counted as a material change', async () => {
		const session = await openTestSession();
		const { mailbox } = session;
		const cleanup = session.close;
		await mailbox.ingestFullPullPage(
			[message('existing', { labelIds: ['INBOX', 'IMPORTANT'] })],
			'2026-06-30T00:00:00.000Z',
		);
		await mailbox.finishFullPull('500', '2026-06-30T00:00:00.000Z');
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.labelsPatched).toBe(0);
		cleanup();
	});

	test('labelsRemoved for an unmirrored message refetches it (untrash after a full-pull sweep)', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
		const remote = new Map([
			['untrashed', message('untrashed', { labelIds: ['INBOX'] })],
		]);
		const client = createFakeGmailClient({
			mailbox: remote,
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(client.calls.getMessage()).toBe(1);
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.cursorAfter).toBe('504');
		const row = await session.row<{ subject: string | null }>(
			`SELECT subject FROM messages WHERE id = ?`,
			['untrashed'],
		);
		expect(row?.subject).toBe('Subject untrashed');
		cleanup();
	});

	test('a refetch for an unmirrored label patch that 404s leaves no row and still advances the cursor', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.failure).toBeNull();
		expect(client.calls.getMessage()).toBe(1);
		expect(outcome.cursorAfter).toBe('504');
		const row = await session.row<{ n: number }>(
			`SELECT count(*) AS n FROM messages WHERE id = 'gone'`,
			[],
		);
		expect(row?.n).toBe(0);
		cleanup();
	});

	test('messagesDeleted physically removes the row', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
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

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.messagesDeleted).toBe(1);
		const row = await session.row<{ n: number }>(
			`SELECT count(*) AS n FROM messages WHERE id = 'existing'`,
			[],
		);
		expect(row?.n).toBe(0);
		cleanup();
	});

	test('a no-history-key page (nothing changed) advances the cursor to the same value without touching rows', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
		const client = createFakeGmailClient({
			mailbox: new Map(),
			historyPages: [{ historyId: '500', history: undefined }],
			profileHistoryId: '999',
		});

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.messagesUpserted).toBe(0);
		expect(outcome.messagesDeleted).toBe(0);
		expect(outcome.cursorAfter).toBe('500');
		cleanup();
	});

	test('an expired cursor (404) mid-pass falls back to FULL within the same call', async () => {
		const session = await seededDb();
		const { mailbox } = session;
		const cleanup = session.close;
		const remote = new Map([['fresh', message('fresh')]]);
		const client: GmailClient = {
			...createFakeGmailClient({
				mailbox: remote,
				historyPages: [],
				profileHistoryId: '9000',
			}),
			async listHistory(cursor) {
				return cursor === '500'
					? GmailApiError.HistoryExpired()
					: { data: { historyId: '9000' }, error: null };
			},
		};

		const outcome = await syncMailbox({
			mailbox,
			client,
			now: () => Date.parse('2026-06-30T01:00:00.000Z'),
		});

		expect(outcome.mode).toBe('FULL');
		expect(outcome.reason).toBe('history cursor expired');
		expect(outcome.failure).toBeNull();
		expect(outcome.cursorAfter).toBe('9000');
		expect((await mailbox.readCacheState()).historyId).toBe('9000');
		cleanup();
	});
});

describe('syncMailbox: concurrent writers', () => {
	test('a cache locked past the busy timeout reports CacheBusy instead of throwing', async () => {
		// The cache is one file that a pass writes and the page reads, so a write
		// that loses the lock is an operational condition rather than a bug. What it must not do is take the
		// surface down or advance the cursor.
		const session = await openTestSession();
		const { mailbox } = session;
		let locked = true;
		const busy = Object.assign(new Error('database is locked'), {
			code: 'SQLITE_BUSY',
		});
		const guarded = {
			...mailbox,
			ingestFullPullPage: async (
				...args: Parameters<typeof mailbox.ingestFullPullPage>
			) => {
				if (locked) throw busy;
				return mailbox.ingestFullPullPage(...args);
			},
		};

		const client = createFakeGmailClient({
			mailbox: new Map([['m1', message('m1')]]),
			historyPages: [],
			profileHistoryId: '1000',
		});
		const deps = {
			mailbox: guarded,
			client,
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
		};

		const outcome = await syncMailbox(deps);
		expect(outcome.failure?.name).toBe('CacheBusy');
		expect(outcome.cursorAfter).toBe(outcome.cursorBefore);
		expect((await mailbox.readCacheState()).historyId).toBeNull();

		// The lock released: the very next pass succeeds against the same handle.
		locked = false;
		const retry = await syncMailbox(deps);
		expect(retry.failure).toBeNull();
		expect((await mailbox.readCacheState()).historyId).toBe('1000');
		session.close();
	});
});

describe('whole-mailbox receiving', () => {
	const at = '2026-09-08T00:00:00.000Z';
	const now = () => Date.parse(at);

	test('an old valid cursor applies thin label deltas across pages without fetching cached mail', async () => {
		const session = await openTestSession();
		try {
			await session.mailbox.ingestFullPullPage(
				[message('m1', { labelIds: ['INBOX', 'UNREAD'] })],
				'2020-01-01',
			);
			await session.mailbox.finishFullPull('100', '2020-01-01');
			const thin = { id: 'm1', threadId: 't-m1' };
			const client = createFakeGmailClient({
				mailbox: new Map(),
				profileHistoryId: 'unused',
				historyPages: [
					{
						historyId: '103',
						nextPageToken: 'next',
						history: [
							{
								id: '101',
								labelsAdded: [{ message: thin, labelIds: ['STARRED'] }],
							},
							{
								id: '102',
								labelsRemoved: [
									{ message: thin, labelIds: ['STARRED', 'UNREAD'] },
								],
							},
						],
					},
					{
						historyId: '103',
						history: [
							{
								id: '103',
								labelsAdded: [{ message: thin, labelIds: ['STARRED'] }],
							},
						],
					},
				],
			});
			client.listMessageIds = async () => {
				throw new Error('a valid cursor must not enumerate');
			};
			const outcome = await syncMailbox({
				mailbox: session.mailbox,
				client,
				now,
			});
			expect(outcome.failure).toBeNull();
			expect(outcome.mode).toBe('INCREMENTAL');
			expect(client.calls.getMessage()).toBe(0);
			expect(
				(await session.mailbox.getMessageDetail('m1'))?.labelIds.sort(),
			).toEqual(['INBOX', 'STARRED']);
			expect((await session.mailbox.readCacheState()).historyId).toBe('103');
		} finally {
			session.close();
		}
	});

	test('completed pages are readable during download and history catches changes before completion', async () => {
		const session = await openTestSession();
		const waiting = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const client = createFakeGmailClient({
			mailbox: new Map([
				['m1', message('m1')],
				['m2', message('m2')],
			]),
			profileHistoryId: '100',
			labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }],
			historyPages: [
				{
					historyId: '101',
					history: [
						{
							id: '101',
							labelsAdded: [
								{
									message: { id: 'm1', threadId: 't-m1' },
									labelIds: ['STARRED'],
								},
							],
						},
					],
				},
			],
		});
		client.listMessageIds = async (page) => {
			if (!page)
				return { data: { ids: ['m1'], nextPageToken: 'second' }, error: null };
			waiting.resolve();
			await release.promise;
			return { data: { ids: ['m2', 'disappeared'] }, error: null };
		};
		const syncing = syncMailbox({ mailbox: session.mailbox, client, now });
		try {
			await waiting.promise;
			expect((await session.mailbox.status()).rows).toEqual({
				messages: 1,
				labels: 1,
			});
			expect((await session.mailbox.status()).cache).toBe('building');
			await session.intents.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				at,
			);
			await session.intents.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: true }],
				at,
			);
			release.resolve();
			const outcome = await syncing;
			expect(outcome.failure).toBeNull();
			expect(outcome.cursorAfter).toBe('101');
			expect(outcome.messagesUpserted).toBe(2);
			expect(await session.mailbox.hasMessage('disappeared')).toBe(false);
			expect((await session.mailbox.getMessageDetail('m1'))?.labelIds).toEqual([
				'INBOX',
				'STARRED',
			]);
			expect((await session.intents.pending()).map(({ want }) => want)).toEqual(
				[true],
			);
			expect((await session.mailbox.status()).cache).toBe('ready');
		} finally {
			release.resolve();
			await syncing;
			session.close();
		}
	});

	test('failed catchup preserves enumeration and retries history without redownloading', async () => {
		const session = await openTestSession();
		try {
			const client = createFakeGmailClient({
				mailbox: new Map([['m1', message('m1')]]),
				profileHistoryId: '100',
				historyPages: [],
			});
			client.listHistory = async () =>
				GmailApiError.Http({ status: 503, body: 'unavailable' });
			const first = await syncMailbox({
				mailbox: session.mailbox,
				client,
				now,
			});
			expect(first.failure?.name).toBe('Http');
			expect(first.cursorBefore).toBeNull();
			expect(first.cursorAfter).toBe('100');
			expect((await session.mailbox.readCacheState()).lastSyncedAt).toBeNull();
			expect((await session.mailbox.status()).cache).toBe('building');
			client.listMessageIds = async () => {
				throw new Error('completed enumeration must not repeat');
			};
			client.listHistory = async (cursor) => {
				expect(cursor).toBe('100');
				return { data: { historyId: '101' }, error: null };
			};
			const second = await syncMailbox({
				mailbox: session.mailbox,
				client,
				now,
			});
			expect(second.failure).toBeNull();
			expect(client.calls.getMessage()).toBe(1);
			expect((await session.mailbox.readCacheState()).lastSyncedAt).toBe(at);
		} finally {
			session.close();
		}
	});

	test('expiry during initial catchup stops after one enumeration', async () => {
		const session = await openTestSession();
		try {
			const client = createFakeGmailClient({
				mailbox: new Map([['m1', message('m1')]]),
				profileHistoryId: '100',
				historyPages: [],
			});
			client.listHistory = async () => GmailApiError.HistoryExpired();
			const outcome = await syncMailbox({
				mailbox: session.mailbox,
				client,
				now,
			});
			expect(outcome.failure?.name).toBe('HistoryExpired');
			expect(outcome.cursorAfter).toBe('100');
			expect(client.calls.getMessage()).toBe(1);
			expect((await session.mailbox.readCacheState()).lastSyncedAt).toBeNull();
		} finally {
			session.close();
		}
	});
});

test('a later page lock reports the messages already committed', async () => {
	const session = await openTestSession();
	try {
		const client = createFakeGmailClient({
			mailbox: new Map([
				['m1', message('m1')],
				['m2', message('m2')],
			]),
			historyPages: [],
			profileHistoryId: '100',
		});
		client.listMessageIds = async (page) => ({
			data: page ? { ids: ['m2'] } : { ids: ['m1'], nextPageToken: 'second' },
			error: null,
		});
		let pages = 0;
		const outcome = await syncMailbox({
			client,
			now: () => Date.parse('2026-09-08'),
			mailbox: {
				...session.mailbox,
				async ingestFullPullPage(...args) {
					if (++pages === 2)
						throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
					await session.mailbox.ingestFullPullPage(...args);
				},
			},
		});
		expect(outcome.failure?.name).toBe('CacheBusy');
		expect(outcome.messagesUpserted).toBe(1);
		expect(outcome.cursorAfter).toBeNull();
		expect(await session.mailbox.hasMessage('m1')).toBe(true);
		expect(await session.mailbox.hasMessage('m2')).toBe(false);
	} finally {
		session.close();
	}
});
