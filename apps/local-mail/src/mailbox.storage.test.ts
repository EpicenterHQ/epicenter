/**
 * Large download/history windows commit bounded storage requests. Interrupted
 * windows keep their old cursor and replay without skipping or duplicating mail.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { openTestSession } from './session.test-support.js';

const checkpoint = {
	scanId: 'scan',
	historyId: '100',
	syncedAt: '2026-09-19T00:00:00.000Z',
	nextPageToken: 'second',
};
const largePage = () =>
	Array.from({ length: 30 }, (_, index) => ({
		id: `large-${index}`,
		threadId: `thread-${index}`,
		labelIds: ['INBOX'],
		// Multibyte content checks the byte budget, not JavaScript string length.
		snippet: '邮件'.repeat(50_000),
	}));

test('a failed large-page checkpoint leaves partial mail readable and retries the same page', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage(
			[{ id: 'first', threadId: 'first' }],
			checkpoint,
		);
		expectOk(
			await session.mailboxDatabase.run(
				"CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON full_pull_checkpoint BEGIN SELECT RAISE(ABORT, 'checkpoint refused'); END",
			),
		);
		const messages = largePage();
		const next = { ...checkpoint, nextPageToken: 'third' };
		await expect(
			session.mailbox.ingestFullPullPage(messages, next),
		).rejects.toBeDefined();
		const partial = (await session.mailbox.counts()).messages;
		expect(partial).toBeGreaterThan(1);
		expect(partial).toBeLessThan(31);
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual(checkpoint);
		expectOk(
			await session.mailboxDatabase.run('DROP TRIGGER refuse_checkpoint'),
		);
		await session.mailbox.ingestFullPullPage(messages, next);
		expect((await session.mailbox.counts()).messages).toBe(31);
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual(next);
	} finally {
		session.close();
	}
});

test('a large history window advances its cursor only after all chunks succeed', async () => {
	const session = await openTestSession();
	try {
		expectOk(
			await session.mailboxDatabase.run(
				"UPDATE sync_state SET history_id = '100' WHERE id = 1",
			),
		);
		expectOk(
			await session.mailboxDatabase.run(
				"CREATE TRIGGER refuse_cursor BEFORE UPDATE ON sync_state BEGIN SELECT RAISE(ABORT, 'cursor refused'); END",
			),
		);
		const update = {
			messagesToUpsert: largePage(),
			messagesToDelete: [],
			labelPatches: [],
			newHistoryId: '200',
			syncedAt: checkpoint.syncedAt,
		};
		await expect(
			session.mailbox.applyHistoryBatch(update),
		).rejects.toBeDefined();
		expect((await session.mailbox.counts()).messages).toBeGreaterThan(0);
		expect((await session.mailbox.readCacheState()).historyId).toBe('100');
		expectOk(await session.mailboxDatabase.run('DROP TRIGGER refuse_cursor'));
		await session.mailbox.applyHistoryBatch(update);
		expect((await session.mailbox.counts()).messages).toBe(30);
		expect((await session.mailbox.readCacheState()).historyId).toBe('200');
	} finally {
		session.close();
	}
});

test('one oversized message refuses the page before changing its cache or checkpoint', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage(
			[{ id: 'first', threadId: 'first' }],
			checkpoint,
		);
		await expect(
			session.mailbox.ingestFullPullPage(
				[
					{ id: 'small', threadId: 'small' },
					{
						id: 'oversized',
						threadId: 'oversized',
						snippet: 'x'.repeat(4 * 1024 * 1024),
					},
				],
				{ ...checkpoint, nextPageToken: null },
			),
		).rejects.toThrow('One downloaded message is too large');
		expect((await session.mailbox.counts()).messages).toBe(1);
		expect(await session.mailbox.readFullPullCheckpoint()).toEqual(checkpoint);
	} finally {
		session.close();
	}
});
