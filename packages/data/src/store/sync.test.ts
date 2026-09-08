import { field, plainText } from '@epicenter/data/definition';
/**
 * The client half of sync: what a replica owes the authority, and what it has
 * read from it.
 *
 * These tests reach the SQLite file directly rather than only the store's
 * surface, because the properties under test are properties of the log's shape.
 * A remote update landing in the log twice is invisible from every verb the
 * store exposes, and it was live for exactly that reason.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineData, defineTable } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import { copyBytes } from './log.js';
import { openAccountStore, syncEngineOf } from './store.js';

/** Wrap one application-document update the way the wire carries it. */

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

async function open() {
	const raw = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(raw);
	const db = await openAccountStore({ definition: database, sqlite });
	return {
		store: db,
		db,
		logRows: () =>
			sqlite.all<{ seq: number; len: number }>(
				'SELECT id AS seq, length(bytes) AS len FROM _updates ORDER BY id',
			),
		/** The raw queue, so a test can see what a merge was given to work with. */
		outbox: () =>
			sqlite
				.all<{ id: number; bytes: Uint8Array | ArrayBuffer }>(
					'SELECT id, bytes FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
				)
				.map((row) => ({ id: row.id, bytes: copyBytes(row.bytes) })),
	};
}

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

function titles(replica: Awaited<ReturnType<typeof open>>): string[] {
	return replica.db.tables.notes.rows.map((row) => row.title).sort();
}

describe('the local log holds each update once', () => {
	test('a remote update is persisted once, as the bytes that arrived', async () => {
		// This was a live bug, and the control that catches it is the byte count:
		// the `updateV2` listener appended what the document EMITTED while
		// `applyRemote` appended what it RECEIVED, so one 108-byte update became
		// two 108-byte rows and the log grew at double the rate it reported.
		// Neither copy was wrong on its own, so no verb could see it.
		const author = await open();
		const reader = await open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		const update = author.store.encodeStateSince();

		expectOk(syncEngineOf(reader.store).applyRemote(update));

		await reader.store.persistence.flush();
		const rows = reader.logRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.len).toBe(update.length);
	});

	test('a remote update owes the authority nothing, because it came from there', async () => {
		// Re-offering received bytes would grow the authority's log with entries
		// that carry no new information, and two replicas would pump one update
		// back and forth between them forever.
		const author = await open();
		const reader = await open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		expectOk(
			syncEngineOf(reader.store).applyRemote(author.store.encodeStateSince()),
		);

		await reader.store.persistence.flush();
		expect(reader.outbox()).toHaveLength(0);
		await reader.store.persistence.flush();
		expect(syncEngineOf(reader.store).coalesce()).toBeUndefined();
	});

	test("content written into a row's node owes it, like any local work", async () => {
		// A node edit reaches storage through the document's own update listener
		// rather than through a store verb, so it is the one local write that
		// could plausibly be missed.
		const author = await open();
		const note = expectOk(
			author.db.tables.notes.create({ title: 'Groceries' }),
		);
		await author.store.persistence.flush();
		const before = author.outbox().length;
		const text = author.db.tables.notes.get(note.id)?.content;
		if (text === undefined) throw new Error('the row has no content');
		text.applyDelta(text.change.insert('buy milk') as never);

		await author.store.persistence.flush();
		expect(author.outbox().length).toBeGreaterThan(before);
	});
});

describe('coalesce merges only what this replica authored', () => {
	test('twenty transactions become one entry that carries all twenty', async () => {
		const author = await open();
		const reader = await open();
		for (let index = 0; index < 20; index += 1) {
			expectOk(author.db.tables.notes.create({ title: `note ${index}` }));
		}
		await author.store.persistence.flush();
		expect(author.outbox()).toHaveLength(20);

		await author.store.persistence.flush();
		const merged = syncEngineOf(author.store).coalesce();
		if (merged === undefined) throw new Error('nothing to send');
		// The merge is for the wire and nowhere else. It used to be written back
		// as a durable op, which was the only compaction that crossed the port
		// boundary while the far larger fold stayed private to it, and it carried
		// no invariant: merging preserves the highest covered id and is
		// idempotent, so re-merging on the next pass costs a little work and
		// changes nothing. The record still owes all twenty until an ack lands.
		await author.store.persistence.flush();
		expect(author.outbox()).toHaveLength(20);

		expectOk(syncEngineOf(reader.store).applyRemote(merged.bytes));
		expect(titles(reader)).toHaveLength(20);
		expect(syncEngineOf(reader.store).hasUnresolvedDependencies()).toBe(false);
	});

	test('CONTROL: the last entry ALONE carries one note and leaves a gap', async () => {
		// Without this the test above passes when `coalesce` simply returns the
		// newest entry and silently drops nineteen, which is the exact failure the
		// merge exists to prevent. The single entry has to be visibly insufficient
		// and visibly incomplete, not merely smaller.
		const author = await open();
		const lastOnly = await open();
		for (let index = 0; index < 20; index += 1) {
			expectOk(author.db.tables.notes.create({ title: `note ${index}` }));
		}
		await author.store.persistence.flush();
		const last = author.outbox().at(-1);
		if (last === undefined) throw new Error('empty outbox');

		expectOk(syncEngineOf(lastOnly.store).applyRemote(last.bytes));

		expect(titles(lastOnly)).toEqual(['note 19']);
		// And the replica cannot even report the shortfall as an error, which is
		// why the merge has to be right rather than merely checked.
		expect(syncEngineOf(lastOnly.store).hasUnresolvedDependencies()).toBe(
			false,
		);
	});

	test('coalescing twice is a no-op rather than a re-merge', async () => {
		const author = await open();
		expectOk(author.db.tables.notes.create({ title: 'a' }));
		expectOk(author.db.tables.notes.create({ title: 'b' }));
		await author.store.persistence.flush();
		const first = syncEngineOf(author.store).coalesce();
		await author.store.persistence.flush();
		const second = syncEngineOf(author.store).coalesce();

		expect(second?.id).toBe(first?.id);
		expect(second?.bytes).toEqual(first?.bytes as Uint8Array);
	});

	test('an entry authored after a coalesce survives the acknowledgement', async () => {
		// The ack names a position rather than "everything", because work authored
		// while a submission was in flight has been acknowledged by nobody.
		const author = await open();
		expectOk(author.db.tables.notes.create({ title: 'sent' }));
		await author.store.persistence.flush();
		const inFlight = syncEngineOf(author.store).coalesce();
		if (inFlight === undefined) throw new Error('nothing to send');
		expectOk(
			author.db.tables.notes.create({ title: 'authored while in flight' }),
		);

		syncEngineOf(author.store).acknowledge(inFlight.id, 1);

		await author.store.persistence.flush();
		const remaining = author.outbox();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBeGreaterThan(inFlight.id);
	});

	test('an acknowledged replica still holds everything it sent', async () => {
		// The ack drops the OBLIGATION, never the data. A store that confused the
		// two would empty itself every time sync succeeded.
		const author = await open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		await author.store.persistence.flush();
		const sent = syncEngineOf(author.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');
		syncEngineOf(author.store).acknowledge(sent.id, 1);

		expect(titles(author)).toEqual(['Groceries']);
		await author.store.persistence.flush();
		expect(author.outbox()).toHaveLength(0);
	});
});

describe('the cursor is a log position, and never a state vector', () => {
	test('a fresh replica reads zero, which is also "I have read nothing"', async () => {
		expect(syncEngineOf((await open()).store).cursor()).toBe(0);
	});

	test('a position survives a reopen, carried by the bytes that reached it', async () => {
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		const first = await openAccountStore({ definition: database, sqlite });
		expectOk(first.tables.notes.create({ title: 'owed' }));
		await first.persistence.flush();
		const sent = syncEngineOf(first).coalesce();
		if (sent === undefined) throw new Error('nothing to send');
		syncEngineOf(first).acknowledge(sent.id, 7);
		await first.persistence.flush();

		expect(
			syncEngineOf(
				await openAccountStore({ definition: database, sqlite }),
			).cursor(),
		).toBe(7);
	});

	test('an acknowledgement that covers nothing owed moves no durable cursor', async () => {
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		syncEngineOf(
			await openAccountStore({ definition: database, sqlite }),
		).acknowledge(0, 7);

		// The honest consequence of deriving the cursor instead of storing it: it
		// can only report a position some bytes actually carry. It fails in the
		// safe direction, because a cursor that lags re-receives and applying an
		// update twice is free, while one that ran ahead would skip entries
		// forever. Unreachable in the client, which only acknowledges its own
		// submissions.
		expect(
			syncEngineOf(
				await openAccountStore({ definition: database, sqlite }),
			).cursor(),
		).toBe(0);
	});
});

describe("a row's content node is one type both devices edit", () => {
	test('two devices typing into one note both keep their text', async () => {
		// The race the old separate row-document model spent a name-addressed root
		// closing. A nested type is addressed by the struct that created it, so what makes
		// this safe is that it is minted ONCE, in the transaction that mints its
		// row (ADR-0295): both devices reach the same type because only the
		// creating device ever minted one.
		const author = await open();
		const other = await open();
		const note = expectOk(
			author.db.tables.notes.create({ title: 'Groceries' }),
		);
		expectOk(
			syncEngineOf(other.store).applyRemote(author.store.encodeStateSince()),
		);

		for (const [replica, words] of [
			[author, 'written on the phone'],
			[other, 'written on the laptop'],
		] as const) {
			const text = replica.db.tables.notes.get(note.id)?.content;
			if (text === undefined) throw new Error('the row has no content');
			text.applyDelta(text.change.insert(words) as never);
		}

		// Cross-deliver each device's unsent work through the one connection's
		// payload; a re-delivered update is idempotent.
		await author.store.persistence.flush();
		const fromAuthor = syncEngineOf(author.store).coalesce();
		await other.store.persistence.flush();
		const fromOther = syncEngineOf(other.store).coalesce();
		if (fromAuthor === undefined || fromOther === undefined) {
			throw new Error('nothing owed');
		}
		expectOk(syncEngineOf(author.store).applyRemote(fromOther.bytes));
		expectOk(syncEngineOf(other.store).applyRemote(fromAuthor.bytes));

		const readBack = (replica: typeof author) =>
			JSON.stringify(replica.db.tables.notes.get(note.id)?.content.toJSON());
		const merged = readBack(author);
		expect(merged).toContain('phone');
		expect(merged).toContain('laptop');
		expect(merged).toBe(readBack(other));
	});
});
