/**
 * Local Mail-shaped usage, which is where the shared API has to earn itself.
 * Gmail differs from QuickBooks in every way that could have made one
 * abstraction dishonest:
 *
 * - two heterogeneous tables, not a registry of uniform ones
 * - an opaque increasing `historyId` cursor, not a timestamp
 * - physical deletes and a post-backfill sweep, not soft deletes
 * - no authority ordering value, so writes are last-writer-wins
 * - columns SQLite cannot express (a MIME walk, a lookup inside
 *   `payload.headers[]`), computed in TypeScript and supplied at write time
 * - partial authoritative updates: `history.list` hands back a message's new
 *   label set without resending the message
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { defineMirror } from './declaration.ts';
import { openMirrorWriter } from './writer.ts';

const mailMirror = defineMirror({
	domain: 'epicenter.local-mail.mirror',
	tables: {
		messages: {
			columns: {
				thread_id: { type: 'TEXT', from: ['threadId'] },
				label_ids: { type: 'TEXT', from: ['labelIds'] },
				snippet: { type: 'TEXT', from: ['snippet'], stored: true },
				internal_date: {
					type: 'INTEGER',
					from: ['internalDate'],
					stored: true,
				},
			},
			// Header lookups walk `payload.headers[]` and the body is a base64url
			// MIME walk. SQLite can express neither, and all three are searched, so
			// read-time derivation would cost the search. `revision` is bumped when
			// the extraction code changes what it produces.
			supplied: {
				subject: { type: 'TEXT', revision: 'headers/v1' },
				sender: { type: 'TEXT', revision: 'headers/v1' },
				body_text: { type: 'TEXT', revision: 'mime-walk/v1' },
			},
			indexes: {
				idx_messages_thread: ['thread_id', 'internal_date'],
				idx_messages_internal_date: ['internal_date'],
			},
		},
		labels: {
			columns: {
				name: { type: 'TEXT', from: ['name'] },
				type: { type: 'TEXT', from: ['type'] },
			},
		},
	},
});

type GmailMessage = {
	id: string;
	threadId: string;
	labelIds: string[];
	snippet: string;
	internalDate: string;
	payload: { headers: { name: string; value: string }[]; body: string };
};

function message(id: string, labelIds: string[]): GmailMessage {
	return {
		id,
		threadId: `t${id}`,
		labelIds,
		snippet: `snippet ${id}`,
		internalDate: `170000000${id}`,
		payload: {
			headers: [
				{ name: 'Subject', value: `Subject ${id}` },
				{ name: 'From', value: `sender${id}@example.com` },
			],
			body: `body ${id}`,
		},
	};
}

/** What `message-fields.ts` does today: the derivation `revision` describes. */
function derive(record: GmailMessage) {
	const header = (name: string) =>
		record.payload.headers.find((h) => h.name === name)?.value ?? null;
	return {
		subject: header('Subject'),
		sender: header('From'),
		body_text: record.payload.body,
	};
}

function openAccount() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	return openMirrorWriter(mailMirror, { database });
}

describe('a Local Mail-shaped mirror', () => {
	let writer: ReturnType<typeof openAccount>;
	beforeEach(() => {
		writer = openAccount();
	});

	function ingest(messages: GmailMessage[], syncedAt: string) {
		writer.write({ syncedAt }, ({ table }) => {
			const rows = table('messages');
			for (const record of messages) {
				rows.upsert({ id: record.id, record, supplied: derive(record) });
			}
		});
	}

	test('supplied columns and stored projections land side by side', () => {
		ingest([message('1', ['INBOX', 'UNREAD'])], 'p1');

		const row = writer.all<{
			subject: string;
			sender: string;
			body_text: string;
			thread_id: string;
			internal_date: number;
		}>(
			`SELECT subject, sender, body_text, thread_id, internal_date FROM messages WHERE id = '1'`,
		)[0];

		expect(row).toEqual({
			subject: 'Subject 1',
			sender: 'sender1@example.com',
			body_text: 'body 1',
			thread_id: 't1',
			internal_date: 1700000001,
		});
	});

	test('a missing supplied value is refused rather than quietly stored as null', () => {
		expect(() =>
			writer.write({ syncedAt: 'p1' }, ({ table }) => {
				table('messages').upsert({
					id: '1',
					record: message('1', ['INBOX']),
					supplied: { subject: 'only this one' },
				});
			}),
		).toThrow(/declares supplied column "sender"/);
	});

	test('declared indexes are applied with the table and are not the gate', () => {
		ingest([message('1', ['INBOX'])], 'p1');

		const indexes = writer
			.all<{ name: string }>(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name LIKE 'idx_%' ORDER BY name`,
			)
			.map((row) => row.name);

		expect(indexes).toEqual([
			'idx_messages_internal_date',
			'idx_messages_thread',
		]);
	});

	test('a full backfill commits per page, then sweeps what the pass never touched', () => {
		// Two pages, two transactions: a crash mid-backfill loses the page in
		// flight, not the whole pull.
		ingest([message('1', ['INBOX']), message('2', ['INBOX'])], 'pass-1');
		ingest([message('3', ['INBOX'])], 'pass-1');
		expect(writer.count('messages')).toBe(3);

		// A later full pull no longer sees message 2.
		ingest([message('1', ['INBOX']), message('3', ['INBOX'])], 'pass-2');
		const swept = writer.write({ syncedAt: 'pass-2' }, ({ table, advance }) => {
			const removed = table('messages').sweep('pass-2');
			advance({
				cursor: 'history-500',
				lastFullPullAt: 'pass-2',
				lastSyncedAt: 'pass-2',
			});
			return removed;
		});

		expect(swept).toBe(1);
		expect(writer.count('messages')).toBe(2);
		expect(writer.state().cursor).toBe('history-500');
	});

	test('a partial authoritative update folds into the stored record', () => {
		ingest([message('1', ['INBOX', 'UNREAD'])], 'p1');

		// `labelsRemoved` carries the message's full CURRENT label set, not the
		// record. Counting a material change is the app's business, so it happens
		// inside the fold, where the app already has both sides.
		let changed = 0;
		const found = writer.write({ syncedAt: 'p2' }, ({ table }) =>
			table('messages').patch('1', (record) => {
				const before = record.labelIds as string[];
				const after = ['INBOX'];
				if (before.length !== after.length) changed += 1;
				return { ...record, labelIds: after };
			}),
		);

		expect(found).toBe(true);
		expect(changed).toBe(1);
		expect(
			writer.all<{ label_ids: string }>(
				`SELECT label_ids FROM messages WHERE id = '1'`,
			)[0]?.label_ids,
		).toBe('["INBOX"]');

		// A patch aimed at a message we never mirrored is reported, not invented.
		expect(
			writer.write({ syncedAt: 'p2' }, ({ table }) =>
				table('messages').patch('999', (record) => record),
			),
		).toBe(false);
	});

	test('a history batch upserts, removes, and advances in one transaction', () => {
		ingest([message('1', ['INBOX']), message('2', ['INBOX'])], 'p1');

		writer.write({ syncedAt: 'p2' }, ({ table, advance }) => {
			const rows = table('messages');
			const added = message('3', ['INBOX']);
			rows.upsert({ id: added.id, record: added, supplied: derive(added) });
			rows.remove('2');
			advance({ cursor: 'history-42', lastSyncedAt: 'p2' });
		});

		expect(
			writer
				.all<{ id: string }>(`SELECT id FROM messages ORDER BY id`)
				.map((row) => row.id),
		).toEqual(['1', '3']);
		expect(writer.state()).toEqual({
			cursor: 'history-42',
			lastFullPullAt: null,
			lastSyncedAt: 'p2',
		});
	});

	test('with no authority ordering value, the last write wins', () => {
		ingest([message('1', ['INBOX'])], 'p1');
		writer.write({ syncedAt: 'p2' }, ({ table }) => {
			const record = message('1', ['INBOX']);
			table('messages').upsert({
				id: '1',
				record,
				supplied: { ...derive(record), subject: 'Rewritten' },
			});
		});

		expect(
			writer.all<{ subject: string }>(
				`SELECT subject FROM messages WHERE id = '1'`,
			)[0]?.subject,
		).toBe('Rewritten');
	});

	test('soft delete is refused on a table that did not declare it', () => {
		expect(() =>
			writer.write({ syncedAt: 'p1' }, ({ table }) => {
				table('labels').softDelete({ id: 'l1', record: { id: 'l1' } });
			}),
		).toThrow(/does not declare softDelete/);
	});
});
