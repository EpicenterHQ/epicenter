import { expect, test } from 'bun:test';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { openIntentStore } from './intent-store.ts';
import { openMailbox, overlayOf } from './mailbox.ts';
import type { GmailMessage } from './schema.ts';
import { LOCAL_SCHEMA, MAIL_CACHE_SCHEMA } from './storage.ts';

const AT = '2026-08-31T00:00:00.000Z';

function message(
	id: string,
	labelIds: string[],
	overrides: Partial<GmailMessage> = {},
): GmailMessage {
	return {
		id,
		threadId: `thread-${id}`,
		labelIds,
		snippet: `snippet ${id}`,
		internalDate: String(1_700_000_000_000 + Number(id.slice(1))),
		payload: {
			headers: [
				{ name: 'Subject', value: `Subject ${id}` },
				{ name: 'From', value: `sender-${id}@example.com` },
			],
		},
		...overrides,
	} as GmailMessage;
}

async function openBoth() {
	const mail = createTestAppSqlite();
	const intent = createTestAppSqlite();
	for (const statement of MAIL_CACHE_SCHEMA) await mail.run(statement);
	for (const statement of LOCAL_SCHEMA) await intent.run(statement);
	return { mail, intent };
}

test('the overlay decides the page, so an archived message leaves it at once', async () => {
	const { mail, intent } = await openBoth();
	const mailbox = openMailbox(mail);
	const intents = openIntentStore(intent, 'account-one');
	await mailbox.ingestFullPullPage(
		[message('m1', ['INBOX']), message('m2', ['INBOX'])],
		AT,
	);

	// Gmail has not been told, and the inbox page must not show it anyway.
	await intents.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		AT,
	);
	const overlay = overlayOf(await intents.pending());
	const inbox = await mailbox.listMessages({
		labelId: 'INBOX',
		limit: 10,
		offset: 0,
		overlay,
	});
	expect(inbox.map((m) => m.id)).toEqual(['m2']);

	// The same overlay adds a label Gmail does not have yet.
	await intents.assert(
		[{ messageId: 'm2', labelId: 'STARRED', want: true }],
		AT,
	);
	const starred = await mailbox.listMessages({
		labelId: 'STARRED',
		limit: 10,
		offset: 0,
		overlay: overlayOf(await intents.pending()),
	});
	expect(starred.map((m) => m.id)).toEqual(['m2']);
	expect(starred[0]?.labelIds).toContain('STARRED');
});

test('trash is hidden from every view except trash, before Gmail hears about it', async () => {
	const { mail, intent } = await openBoth();
	const mailbox = openMailbox(mail);
	const intents = openIntentStore(intent, 'account-one');
	await mailbox.ingestFullPullPage(
		[message('m1', ['INBOX']), message('m2', ['INBOX'])],
		AT,
	);
	await intents.assert([{ messageId: 'm1', labelId: 'TRASH', want: true }], AT);
	const overlay = overlayOf(await intents.pending());

	expect(
		(await mailbox.listMessages({ limit: 10, offset: 0, overlay })).map(
			(m) => m.id,
		),
	).toEqual(['m2']);
	expect(
		(
			await mailbox.listMessages({
				labelId: 'TRASH',
				limit: 10,
				offset: 0,
				overlay,
			})
		).map((m) => m.id),
	).toEqual(['m1']);
});

test('throwing the cache away cannot reach the durable intent store', async () => {
	const { mail, intent } = await openBoth();
	const mailbox = openMailbox(mail);
	const intents = openIntentStore(intent, 'account-one');
	await mailbox.ingestFullPullPage([message('m1', ['INBOX'])], AT);
	await mailbox.finishFullPull('900', AT);
	await intents.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		AT,
	);

	// Clearing a cache is unlinking its file and opening a new one (ADR-0319).
	// The durable store cannot go with it, and not because anything here is
	// careful: it is a different file, and no handle reaches across.
	const replacement = createTestAppSqlite();
	for (const statement of MAIL_CACHE_SCHEMA) await replacement.run(statement);
	const reopened = openMailbox(replacement);

	expect(await reopened.counts()).toEqual({ messages: 0, labels: 0 });
	expect(await reopened.readCacheState()).toEqual({
		historyId: null,
		lastFullPullAt: null,
		lastSyncedAt: null,
	});
	expect(await intents.count()).toBe(1);
	replacement.close();
});

test('an older delivery cannot retire a newer assertion', async () => {
	const { intent } = await openBoth();
	const intents = openIntentStore(intent, 'account-one');
	await intents.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		AT,
	);
	const inFlight = (await intents.pending())[0];
	if (inFlight === undefined) throw new Error('expected one assertion');

	// The person changed their mind while the delivery was in flight.
	await intents.assert([{ messageId: 'm1', labelId: 'INBOX', want: true }], AT);
	expect(await intents.retire([inFlight])).toBe(0);

	const current = await intents.pending();
	expect(current).toHaveLength(1);
	expect(current[0]?.want).toBe(true);
	expect(current[0]?.revision).toBeGreaterThan(inFlight.revision);
	expect(await intents.retire(current)).toBe(1);
	expect(await intents.pending()).toEqual([]);
});

test('the revision stays monotonic across an emptied table', async () => {
	const { intent } = await openBoth();
	const intents = openIntentStore(intent, 'account-one');
	await intents.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		AT,
	);
	const first = (await intents.pending())[0]?.revision ?? 0;
	await intents.discardAll();
	await intents.assert(
		[{ messageId: 'm2', labelId: 'INBOX', want: false }],
		AT,
	);
	expect((await intents.pending())[0]?.revision).toBeGreaterThan(first);
});

test('a history batch folds labels and advances the cursor together', async () => {
	const { mail } = await openBoth();
	const mailbox = openMailbox(mail);
	await mailbox.ingestFullPullPage(
		[message('m1', ['INBOX', 'UNREAD']), message('m2', ['INBOX'])],
		AT,
	);
	await mailbox.finishFullPull('900', AT);

	const applied = await mailbox.applyHistoryBatch({
		messagesToUpsert: [message('m3', ['INBOX'])],
		messagesToDelete: ['m2'],
		labelPatches: [
			{ messageId: 'm1', labelIds: ['INBOX'] },
			// An echo of labels already current is applied and not counted.
			{ messageId: 'm3', labelIds: ['INBOX'] },
			// A patch for a row that is not mirrored is skipped.
			{ messageId: 'absent', labelIds: ['INBOX'] },
		],
		newHistoryId: '910',
		syncedAt: '2026-08-31T01:00:00.000Z',
	});

	expect(applied.labelsChanged).toBe(1);
	expect((await mailbox.readCacheState()).historyId).toBe('910');
	expect(await mailbox.hasMessage('m2')).toBe(false);
	const detail = await mailbox.getMessageDetail('m1');
	expect(detail?.labelIds).toEqual(['INBOX']);
});

test('a full pull sweeps what the pass did not touch', async () => {
	const { mail } = await openBoth();
	const mailbox = openMailbox(mail);
	await mailbox.ingestFullPullPage([message('m1', ['INBOX'])], AT);
	await mailbox.finishFullPull('900', AT);

	const later = '2026-09-01T00:00:00.000Z';
	await mailbox.ingestFullPullPage([message('m2', ['INBOX'])], later);
	expect(await mailbox.finishFullPull('910', later)).toBe(1);
	expect(await mailbox.hasMessage('m1')).toBe(false);
	expect(await mailbox.hasMessage('m2')).toBe(true);
});

/**
 * The cache's lifecycle, which is what `status` is for: `empty` is nothing
 * pulled, `building` is rows without a finished full pull, and `ready` is a
 * cursor that `finishFullPull` wrote after every page landed. The middle one is
 * the one that matters, because a partial mailbox that reported `ready` would
 * have a person believing mail is missing from Gmail.
 */
test('the cache reports which of its three states it is in', async () => {
	const mail = createTestAppSqlite();
	for (const sql of MAIL_CACHE_SCHEMA) await mail.run(sql);
	const mailbox = openMailbox(mail);
	try {
		expect(await mailbox.status()).toEqual({
			cache: 'empty',
			lastSyncedAt: null,
			rows: { messages: 0, labels: 0 },
		});

		await mailbox.ingestFullPullPage([message('m1', ['INBOX'])], AT);
		const building = await mailbox.status();
		expect(building.cache).toBe('building');
		expect(building.rows.messages).toBe(1);

		await mailbox.finishFullPull('900', AT);
		const ready = await mailbox.status();
		expect(ready.cache).toBe('ready');
		expect(ready.lastSyncedAt).toBe(AT);
	} finally {
		mail.close();
	}
});
