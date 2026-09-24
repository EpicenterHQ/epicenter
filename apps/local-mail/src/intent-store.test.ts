/**
 * Assertion revisions protect newer choices from stale Gmail responses.
 * Exercises overlapping database batches, allocation across store instances,
 * and retirement followed by a new assertion over the same durable file.
 */
import { expect, test } from 'bun:test';
import { openIntentStore } from './intent-store.js';
import { openTestSession } from './session.test-support.js';

const AT = '2026-09-09T00:00:00.000Z';

test('an older delivery cannot retire an overlapping undo from another store', async () => {
	const session = await openTestSession();
	const release = Promise.withResolvers<void>();
	let batches = 0;
	const database = {
		...session.localDatabase,
		async batch(statements: Parameters<typeof session.localDatabase.batch>[0]) {
			if (++batches === 2) await release.promise;
			return session.localDatabase.batch(statements);
		},
	};
	const firstStore = openIntentStore(database, session.sub);
	const secondStore = openIntentStore(database, session.sub);
	try {
		const first = firstStore.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: true }],
			AT,
		);
		const undo = secondStore.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: false }],
			AT,
		);
		await first;
		const snapshot = await firstStore.pending();
		release.resolve();
		await undo;
		expect(await firstStore.retire(snapshot)).toBe(0);
		const pending = await secondStore.pending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.want).toBe(false);
		expect(pending[0]?.revision).toBeGreaterThan(snapshot[0]!.revision);
	} finally {
		release.resolve();
		session.close();
	}
});

test('a new store never reuses a retired revision when the outbox is empty', async () => {
	const session = await openTestSession();
	try {
		const assertion = { messageId: 'm1', labelId: 'TRASH', want: true };
		await session.intents.assert([assertion], AT);
		const snapshot = await session.intents.pending();
		await session.intents.retire(snapshot);
		const reopened = openIntentStore(session.localDatabase, session.sub);
		await reopened.assert([assertion], AT);
		expect(await reopened.retire(snapshot)).toBe(0);
		expect((await reopened.pending())[0]?.revision).toBeGreaterThan(
			snapshot[0]!.revision,
		);
	} finally {
		session.close();
	}
});

test('overlapping batches allocate distinct ordered revisions for every assertion', async () => {
	const session = await openTestSession();
	try {
		await Promise.all(
			['a', 'b'].map((messageId) =>
				session.intents.assert(
					['INBOX', 'TRASH'].map((labelId) => ({
						messageId,
						labelId,
						want: true,
					})),
					AT,
				),
			),
		);
		expect(
			(await session.intents.pending()).map((intent) => intent.revision),
		).toEqual([1, 2, 3, 4]);
	} finally {
		session.close();
	}
});
