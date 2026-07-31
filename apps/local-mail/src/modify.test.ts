/**
 * Gmail label write-through core tests.
 *
 * Verifies that `modifyMessageLabels` writes Gmail first and treats SQLite as a
 * disposable mirror fold: Gmail failures leave the mirror untouched, accepted
 * Gmail responses fold only returned `labelIds`, and fold failures never turn a
 * committed Gmail write into a failed mutation.
 *
 * Key behaviors:
 * - Read-only mode refuses before network
 * - Per-id Gmail errors continue while systemic errors abort remaining ids
 * - Mirror folds write Gmail response bytes only and leave `_meta` untouched
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from 'wellcrafted/result';
import { type MailDb, openMailDb } from './db.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import {
	type ModifyMessageLabelsInput,
	modifyMessageLabels,
	resolveAndModifyMessageLabels,
	resolveLabelIds,
	setMessagesTrashed,
} from './modify.ts';
import type { GmailLabel, GmailMessage, HistoryPage } from './schema.ts';

type FakeModifyResult =
	| { data: GmailMessage; error?: null }
	| {
			data?: null;
			error: NonNullable<
				Awaited<ReturnType<GmailClient['modifyMessage']>>['error']
			>;
	  };

function tempDb(): { db: MailDb; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-modify-test-'));
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
		labelIds: ['INBOX', 'UNREAD'],
		snippet: `snippet ${id}`,
		internalDate: '1719000000000',
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
		...over,
	};
}

function messageRaw(db: MailDb, id: string): string | null {
	return (
		db.raw
			.query<{ raw: string }, [string]>(`SELECT raw FROM messages WHERE id = ?`)
			.get(id)?.raw ?? null
	);
}

function metaRows(db: MailDb): { key: string; value: string }[] {
	return db.raw
		.query<{ key: string; value: string }, []>(
			`SELECT key, value FROM _meta ORDER BY key`,
		)
		.all();
}

function tableNames(db: MailDb): string[] {
	return db.raw
		.query<{ name: string }, []>(
			`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
		)
		.all()
		.map((row) => row.name);
}

function createFakeGmailClient(
	results: Map<string, FakeModifyResult>,
	labels: GmailLabel[] = [],
): GmailClient & {
	modifyCalls: {
		id: string;
		addLabelIds: string[];
		removeLabelIds: string[];
	}[];
	trashCalls: string[];
	untrashCalls: string[];
	listLabelsCalls: number;
} {
	const modifyCalls: {
		id: string;
		addLabelIds: string[];
		removeLabelIds: string[];
	}[] = [];
	const trashCalls: string[] = [];
	const untrashCalls: string[] = [];
	let listLabelsCalls = 0;
	const lookup = (id: string) => {
		const result = results.get(id);
		if (!result) return GmailApiError.Http({ status: 404, body: 'not found' });
		return result.error
			? { data: null, error: result.error }
			: { data: result.data, error: null };
	};
	return {
		modifyCalls,
		trashCalls,
		untrashCalls,
		get listLabelsCalls() {
			return listLabelsCalls;
		},
		async modifyMessage(id, body) {
			modifyCalls.push({ id, ...body });
			return lookup(id);
		},
		async trashMessage(id) {
			trashCalls.push(id);
			return lookup(id);
		},
		async untrashMessage(id) {
			untrashCalls.push(id);
			return lookup(id);
		},
		async listMessageIds() {
			return { data: { ids: [] }, error: null };
		},
		async getMessage() {
			return GmailApiError.Http({ status: 404, body: 'not found' });
		},
		async listHistory(): Promise<{ data: HistoryPage; error: null }> {
			return { data: { historyId: '1' }, error: null };
		},
		async listLabels(): Promise<{ data: GmailLabel[]; error: null }> {
			listLabelsCalls += 1;
			return { data: labels, error: null };
		},
		async getProfile() {
			return { data: { historyId: '1' }, error: null };
		},
	};
}

const input: ModifyMessageLabelsInput = {
	ids: ['m1'],
	addLabelIds: [],
	removeLabelIds: ['UNREAD'],
};

function expectOk<TData>(result: Result<TData, unknown>): TData {
	expect(result.error).toBeNull();
	if (result.error) throw new Error('expected Ok result');
	if (result.data === null) throw new Error('expected Ok data');
	return result.data;
}

describe('modifyMessageLabels', () => {
	test('readOnly true refuses before any Gmail client call', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: true,
		});

		expect(result.error?.name).toBe('ReadOnly');
		expect(client.modifyCalls).toHaveLength(0);
		cleanup();
	});

	test('empty add and remove label sets refuse before any Gmail client call', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input: { ids: ['m1'], addLabelIds: [], removeLabelIds: [] },
			readOnly: false,
		});

		expect(result.error?.name).toBe('EmptyLabelMutation');
		expect(client.modifyCalls).toHaveLength(0);
		cleanup();
	});

	test('resolveLabelIds reads mirrored labels before one fresh labels.list miss', async () => {
		const { db, cleanup } = tempDb();
		db.ingestLabels([{ id: 'Label_work', name: 'Work', type: 'user' }], 's1');
		const client = createFakeGmailClient(new Map(), [
			{ id: 'Label_work', name: 'Work', type: 'user' },
			{ id: 'Label_personal', name: 'Personal', type: 'user' },
		]);

		const mirrored = await resolveLabelIds({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			labels: ['Work'],
		});
		const fresh = await resolveLabelIds({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			labels: ['Personal'],
		});

		expect(expectOk(mirrored)).toEqual(['Label_work']);
		expect(expectOk(fresh)).toEqual(['Label_personal']);
		expect(client.listLabelsCalls).toBe(1);
		expect(client.modifyCalls).toHaveLength(0);
		cleanup();
	});

	test('resolveLabelIds names unknown labels after one fresh labels.list and no modify calls', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(new Map(), [
			{ id: 'Label_work', name: 'Work', type: 'user' },
		]);

		const result = await resolveLabelIds({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			labels: ['Missing'],
		});

		expect(result.error?.name).toBe('UnknownLabel');
		expect(result.error?.message).toContain('"Missing"');
		expect(client.listLabelsCalls).toBe(1);
		expect(client.modifyCalls).toHaveLength(0);
		cleanup();
	});

	test('Gmail rejection leaves SQLite unchanged', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1')], 's1');
		db.finishFullPull('500', 's1');
		const beforeRaw = messageRaw(db, 'm1');
		const beforeMeta = metaRows(db);
		const client = createFakeGmailClient(
			new Map([
				[
					'm1',
					{
						error: GmailApiError.Http({
							status: 400,
							body: 'Invalid label: DRAFT',
						}).error,
					},
				],
			]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toMatchObject({
			id: 'm1',
			labelIds: null,
			folded: false,
			error: { name: 'Http' },
		});
		expect(messageRaw(db, 'm1')).toBe(beforeRaw);
		expect(metaRows(db)).toEqual(beforeMeta);
		cleanup();
	});

	test('fold writes Gmail response labelIds exactly, not local add/remove math', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[message('m1', { labelIds: ['INBOX', 'UNREAD', 'Label_old'] })],
			's1',
		);
		const client = createFakeGmailClient(
			new Map([
				[
					'm1',
					{
						data: message('m1', { labelIds: ['SENT', 'Label_from_gmail'] }),
					},
				],
			]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input: {
				ids: ['m1'],
				addLabelIds: ['Label_new'],
				removeLabelIds: ['UNREAD'],
			},
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['SENT', 'Label_from_gmail'],
			folded: true,
			error: null,
		});
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'SENT',
			'Label_from_gmail',
		]);
		cleanup();
	});

	test('response without labelIds leaves mirror untouched and returns folded false', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1')], 's1');
		const beforeRaw = messageRaw(db, 'm1');
		const client = createFakeGmailClient(
			new Map([['m1', { data: { id: 'm1', threadId: 't-m1' } }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: null,
			folded: false,
			error: null,
		});
		expect(messageRaw(db, 'm1')).toBe(beforeRaw);
		cleanup();
	});

	test('replaying the same history label change after a fold converges cleanly', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1')], 's1');
		db.finishFullPull('500', 's1');
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});
		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [{ messageId: 'm1', labelIds: ['INBOX'] }],
			newHistoryId: '501',
			syncedAt: 's2',
		});

		expectOk(result);
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'INBOX',
		]);
		expect(db.readRealmState().historyId).toBe('501');
		cleanup();
	});

	test('accepted regression race can heal through the later Gmail history record', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[message('m1', { labelIds: ['INBOX', 'UNREAD'] })],
			's1',
		);
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});
		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [{ messageId: 'm1', labelIds: ['INBOX', 'UNREAD'] }],
			newHistoryId: '501',
			syncedAt: 's2',
		});
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'INBOX',
			'UNREAD',
		]);

		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [{ messageId: 'm1', labelIds: ['INBOX'] }],
			newHistoryId: '502',
			syncedAt: 's3',
		});

		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'INBOX',
		]);
		cleanup();
	});

	test('fold leaves no new mirror state and does not touch _meta', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1')], 's1');
		db.finishFullPull('500', 's1');
		const beforeMeta = metaRows(db);
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});

		expectOk(result);
		expect(metaRows(db)).toEqual(beforeMeta);
		expect(tableNames(db)).toEqual(['_meta', 'labels', 'messages']);
		expect(db.readRealmState()).toEqual({
			historyId: '500',
			lastFullPullAt: 's1',
			lastSyncedAt: 's1',
		});
		// The `_meta` comparison above is what carries this: the shape stamp is one
		// of those rows, so a fold that touched it would fail here.
		expect(beforeMeta.map((row) => row.key)).toContain('mirror_fingerprint');
		cleanup();
	});

	test('per-id 404 continues while systemic throttle aborts remaining ids', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[
				message('ok-1'),
				message('missing'),
				message('ok-2'),
				message('throttled'),
				message('not-attempted'),
			],
			's1',
		);
		const client = createFakeGmailClient(
			new Map([
				['ok-1', { data: message('ok-1', { labelIds: ['INBOX'] }) }],
				[
					'missing',
					{
						error: GmailApiError.Http({ status: 404, body: 'not found' }).error,
					},
				],
				['ok-2', { data: message('ok-2', { labelIds: ['INBOX'] }) }],
				[
					'throttled',
					{
						error: GmailApiError.Throttled({ retries: 5 }).error,
					},
				],
				[
					'not-attempted',
					{ data: message('not-attempted', { labelIds: ['INBOX'] }) },
				],
			]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input: {
				...input,
				ids: ['ok-1', 'missing', 'ok-2', 'throttled', 'not-attempted'],
			},
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.aborted?.name).toBe('Throttled');
		expect(outcome.results.map((row) => row.id)).toEqual([
			'ok-1',
			'missing',
			'ok-2',
			'throttled',
		]);
		expect(client.modifyCalls.map((call) => call.id)).toEqual([
			'ok-1',
			'missing',
			'ok-2',
			'throttled',
		]);
		expect(outcome.results[1]?.error?.name).toBe('Http');
		cleanup();
	});

	test('fold SQLITE_BUSY reports folded false without failing Gmail success', async () => {
		const { db, cleanup } = tempDb();
		const busyDb: MailDb = {
			...db,
			patchMessageLabels() {
				throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
			},
		};
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: {
				client,
				db: busyDb,
				now: () => Date.parse('2026-07-03T00:00:00.000Z'),
			},
			input,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['INBOX'],
			folded: false,
			error: null,
		});
		cleanup();
	});

	test('unmirrored message id calls Gmail and skips the fold', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await modifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			input,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['INBOX'],
			folded: false,
			error: null,
		});
		expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1']);
		expect(messageRaw(db, 'm1')).toBeNull();
		cleanup();
	});

	test('resolveAndModifyMessageLabels refuses read-only before any network', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
			[{ id: 'Label_work', name: 'Work', type: 'user' }],
		);

		const result = await resolveAndModifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['m1'],
			addLabels: ['Work'],
			removeLabels: [],
			readOnly: true,
		});

		expect(result.error?.name).toBe('ReadOnly');
		expect(client.listLabelsCalls).toBe(0);
		expect(client.modifyCalls).toHaveLength(0);
		cleanup();
	});

	test('resolveAndModifyMessageLabels resolves a label name then folds Gmail bytes', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1')], 's1');
		db.ingestLabels([{ id: 'Label_work', name: 'Work', type: 'user' }], 's1');
		const client = createFakeGmailClient(
			new Map([
				['m1', { data: message('m1', { labelIds: ['INBOX', 'Label_work'] }) }],
			]),
			[{ id: 'Label_work', name: 'Work', type: 'user' }],
		);

		const result = await resolveAndModifyMessageLabels({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['m1'],
			addLabels: ['Work'],
			removeLabels: [],
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['INBOX', 'Label_work'],
			folded: true,
			error: null,
		});
		// The core sees the resolved id, never the name.
		expect(client.modifyCalls[0]).toEqual({
			id: 'm1',
			addLabelIds: ['Label_work'],
			removeLabelIds: [],
		});
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'INBOX',
			'Label_work',
		]);
		cleanup();
	});
});

describe('setMessagesTrashed', () => {
	test('readOnly true refuses before any Gmail client call', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['TRASH'] }) }]]),
		);

		const result = await setMessagesTrashed({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['m1'],
			trashed: true,
			readOnly: true,
		});

		expect(result.error?.name).toBe('ReadOnly');
		expect(client.trashCalls).toHaveLength(0);
		cleanup();
	});

	test('empty ids refuse before any Gmail client call', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(new Map());

		const result = await setMessagesTrashed({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: [],
			trashed: true,
			readOnly: false,
		});

		expect(result.error?.name).toBe('NoMessageIds');
		expect(client.trashCalls).toHaveLength(0);
		cleanup();
	});

	test('trash calls messages.trash and folds the returned labelIds', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage(
			[message('m1', { labelIds: ['INBOX', 'UNREAD'] })],
			's1',
		);
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['TRASH'] }) }]]),
		);

		const result = await setMessagesTrashed({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['m1'],
			trashed: true,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['TRASH'],
			folded: true,
			error: null,
		});
		expect(client.trashCalls).toEqual(['m1']);
		expect(client.untrashCalls).toEqual([]);
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'TRASH',
		]);
		cleanup();
	});

	test('untrash calls messages.untrash and folds the restored labelIds', async () => {
		const { db, cleanup } = tempDb();
		db.ingestFullPullPage([message('m1', { labelIds: ['TRASH'] })], 's1');
		const client = createFakeGmailClient(
			new Map([['m1', { data: message('m1', { labelIds: ['INBOX'] }) }]]),
		);

		const result = await setMessagesTrashed({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['m1'],
			trashed: false,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.results[0]).toEqual({
			id: 'm1',
			labelIds: ['INBOX'],
			folded: true,
			error: null,
		});
		expect(client.untrashCalls).toEqual(['m1']);
		expect(client.trashCalls).toEqual([]);
		expect(JSON.parse(messageRaw(db, 'm1') ?? '{}').labelIds).toEqual([
			'INBOX',
		]);
		cleanup();
	});

	test('a per-id 404 is recorded without aborting, like the label core', async () => {
		const { db, cleanup } = tempDb();
		const client = createFakeGmailClient(
			new Map([
				['ok', { data: message('ok', { labelIds: ['TRASH'] }) }],
				[
					'missing',
					{
						error: GmailApiError.Http({ status: 404, body: 'not found' }).error,
					},
				],
			]),
		);

		const result = await setMessagesTrashed({
			deps: { client, db, now: () => Date.parse('2026-07-03T00:00:00.000Z') },
			ids: ['ok', 'missing'],
			trashed: true,
			readOnly: false,
		});

		const outcome = expectOk(result);
		expect(outcome.aborted).toBeNull();
		expect(outcome.results.map((row) => row.id)).toEqual(['ok', 'missing']);
		expect(outcome.results[1]?.error?.name).toBe('Http');
		expect(client.trashCalls).toEqual(['ok', 'missing']);
		cleanup();
	});
});
