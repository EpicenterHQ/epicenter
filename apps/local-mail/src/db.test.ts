/**
 * The mailbox's write contract. Unlike `apps/local-books`' monotonic-timestamp
 * guard (QuickBooks CDC deletes are stubs, so a stale write must not regress a
 * newer row), Gmail's history stream is applied strictly in the order it is
 * received within one process, so `upsertMessage`/`applyHistoryBatch` are
 * plain last-write-wins: what these tests actually cover is the FULL-pull vs
 * INCREMENTAL-patch split (a `labelPatch` must edit the stored resource's
 * `labelIds` in place and leave the rest of the payload alone), the atomic-cursor
 * discipline ported from `db.ts`, and the one stable file's open contract
 * (ADR-0198): reopening keeps every row, and a corpus bump rebuilds the fact
 * tier in place without touching anything else in the file.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MailDb, openMailDb, openMailDbReadonly } from './db.ts';
import { mailDbPath } from './paths.ts';
import type { GmailMessage } from './schema.ts';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function openTmp(): { db: MailDb; dataDir: string; cleanup: () => void } {
	const tmp = tempDir();
	const db = openMailDb({ dataDir: tmp.dir, accountEmail: 'you@example.com' });
	return {
		db,
		dataDir: tmp.dir,
		cleanup: () => {
			db.close();
			tmp.cleanup();
		},
	};
}

function message(over: Partial<GmailMessage> = {}): GmailMessage {
	return {
		id: 'm1',
		threadId: 't1',
		labelIds: ['INBOX', 'UNREAD'],
		snippet: 'hello there',
		internalDate: '1719000000000',
		payload: {
			headers: [
				{ name: 'Subject', value: 'Test subject' },
				{ name: 'From', value: 'sender@example.com' },
			],
		},
		...over,
	};
}

function messageRow(db: MailDb, id: string) {
	return db.raw
		.query<
			{
				resource: string;
				thread_id: string;
				snippet: string;
				label_ids: string;
				subject: string | null;
				sender: string | null;
				body_text: string | null;
			},
			[string]
		>(
			`SELECT resource, thread_id, snippet, label_ids, subject, sender, body_text FROM messages WHERE id = ?`,
		)
		.get(id);
}

function base64Url(input: string): string {
	return Buffer.from(input, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe('full pull page ingestion', () => {
	test('upserts a message, projects generated columns, and computes header columns', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([message()], 's1');

		const row = messageRow(db, 'm1');
		expect(row?.thread_id).toBe('t1');
		expect(row?.snippet).toBe('hello there');
		expect(row?.subject).toBe('Test subject');
		expect(row?.sender).toBe('sender@example.com');
		expect(JSON.parse(row?.label_ids ?? '[]')).toEqual(['INBOX', 'UNREAD']);
		cleanup();
	});

	test('finishFullPull records the historyId baseline and timestamps', () => {
		const { db, cleanup } = openTmp();
		const swept = db.finishFullPull('500', 's1');
		const state = db.readRealmState();
		expect(swept).toBe(0);
		expect(state.historyId).toBe('500');
		expect(state.lastFullPullAt).toBe('s1');
		expect(state.lastSyncedAt).toBe('s1');
		cleanup();
	});

	test('finishFullPull sweeps rows older than the pass stamp', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({ id: 'older', internalDate: '998' }),
				message({ id: 'same-pass', internalDate: '999' }),
				message({ id: 'newer', internalDate: '1000' }),
			],
			'2026-06-30T00:00:00.000Z',
		);
		db.ingestFullPullPage(
			[message({ id: 'same-pass', internalDate: '999' })],
			'2026-07-01T00:00:00.000Z',
		);
		db.ingestFullPullPage(
			[message({ id: 'newer', internalDate: '1000' })],
			'2026-07-02T00:00:00.000Z',
		);

		const swept = db.finishFullPull('500', '2026-07-01T00:00:00.000Z');
		const ids = db.raw
			.query<{ id: string }, []>(`SELECT id FROM messages ORDER BY id`)
			.all()
			.map((row) => row.id);

		expect(swept).toBe(1);
		expect(ids).toEqual(['newer', 'same-pass']);
		cleanup();
	});

	test('same-thread messages ingested newest-first derive the newest message', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					id: 'newest',
					threadId: 'thread-1',
					internalDate: '1000',
					snippet: 'newest snippet',
				}),
				message({
					id: 'older',
					threadId: 'thread-1',
					internalDate: '999',
					snippet: 'older snippet',
				}),
			],
			's1',
		);

		const row = db.raw
			.query<
				{ thread_id: string; last_message_id: string; snippet: string },
				[]
			>(
				`SELECT thread_id, id AS last_message_id, snippet
				 FROM messages
				 WHERE thread_id = 'thread-1'
				 ORDER BY internal_date DESC
				 LIMIT 1`,
			)
			.get();

		expect(row).toEqual({
			thread_id: 'thread-1',
			last_message_id: 'newest',
			snippet: 'newest snippet',
		});
		cleanup();
	});

	test('physically deleted messages drop out of thread derivation', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					id: 'newest',
					threadId: 'thread-1',
					internalDate: '1000',
					snippet: 'newest snippet',
				}),
				message({
					id: 'older',
					threadId: 'thread-1',
					internalDate: '999',
					snippet: 'older snippet',
				}),
			],
			's1',
		);
		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: ['newest'],
			labelPatches: [],
			newHistoryId: '700',
			syncedAt: 's2',
		});

		const row = db.raw
			.query<{ last_message_id: string }, []>(
				`SELECT id AS last_message_id
				 FROM messages
				 WHERE thread_id = 'thread-1'
				 ORDER BY internal_date DESC
				 LIMIT 1`,
			)
			.get();

		expect(row?.last_message_id).toBe('older');
		cleanup();
	});

	test('text/plain MIME part decodes into body_text', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					payload: {
						headers: [],
						parts: [
							{
								mimeType: 'text/plain',
								body: { data: base64Url('Plain body text') },
							},
						],
					},
				}),
			],
			's1',
		);

		expect(messageRow(db, 'm1')?.body_text).toBe('Plain body text');
		cleanup();
	});

	test('html-only MIME part falls back to stripped body_text', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					payload: {
						headers: [],
						parts: [
							{
								mimeType: 'text/html',
								body: {
									data: base64Url(
										'<html><body><p>Hello <strong>there</strong></p></body></html>',
									),
								},
							},
						],
					},
				}),
			],
			's1',
		);

		expect(messageRow(db, 'm1')?.body_text).toBe('Hello there');
		cleanup();
	});

	test('missing body yields null body_text', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([message()], 's1');

		expect(messageRow(db, 'm1')?.body_text).toBeNull();
		cleanup();
	});

	test('counts and recentMessages read live rows, newest first', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					id: 'older',
					internalDate: '999',
					payload: {
						headers: [{ name: 'Subject', value: 'Older subject' }],
					},
				}),
				message({
					id: 'newest',
					internalDate: '1000',
					payload: {
						headers: [{ name: 'Subject', value: 'Newest subject' }],
					},
				}),
			],
			's1',
		);
		db.ingestLabels([{ id: 'INBOX', name: 'INBOX', type: 'system' }], 's1');

		expect(db.counts()).toEqual({ messages: 2, labels: 1 });
		expect(db.recentMessages(1)[0]?.subject).toBe('Newest subject');

		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: ['newest'],
			labelPatches: [],
			newHistoryId: '700',
			syncedAt: 's2',
		});
		expect(db.counts().messages).toBe(1);
		expect(db.recentMessages(5).map((row) => row.subject)).toEqual([
			'Older subject',
		]);
		cleanup();
	});

	test('creates data and account dirs as 0700 and mailbox files as 0600', () => {
		const tmp = tempDir();
		chmodSync(tmp.dir, 0o755);
		const accountDir = join(tmp.dir, 'you@example.com');
		// The file holds someone's mail, so the mode covers `mail.db` and both
		// SQLite sidecars, not just the directory around them.
		const path = mailDbPath(tmp.dir, 'you@example.com');
		const db = openMailDb({
			dataDir: tmp.dir,
			accountEmail: 'you@example.com',
		});
		db.ingestFullPullPage([message()], 's1');

		expect(mode(tmp.dir)).toBe(0o700);
		expect(mode(accountDir)).toBe(0o700);
		expect(mode(path)).toBe(0o600);
		expect(mode(`${path}-wal`)).toBe(0o600);
		expect(mode(`${path}-shm`)).toBe(0o600);
		db.close();
		tmp.cleanup();
	});
});

describe('applyHistoryBatch', () => {
	test('upserts new messages and advances the cursor', () => {
		const { db, cleanup } = openTmp();
		db.applyHistoryBatch({
			messagesToUpsert: [message()],
			messagesToDelete: [],
			labelPatches: [],
			newHistoryId: '600',
			syncedAt: 's2',
		});
		expect(messageRow(db, 'm1')).not.toBeNull();
		expect(db.readRealmState().historyId).toBe('600');
		cleanup();
	});

	test("a labelPatch edits the resource's labelIds in place, leaving the rest of the payload untouched", () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([message()], 's1');

		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [{ messageId: 'm1', labelIds: ['INBOX', 'IMPORTANT'] }],
			newHistoryId: '601',
			syncedAt: 's2',
		});

		const row = messageRow(db, 'm1');
		expect(JSON.parse(row?.label_ids ?? '[]')).toEqual(['INBOX', 'IMPORTANT']);
		// The subject/sender columns are plain (not re-derived from a patch), so a
		// labelPatch alone must not touch them.
		expect(row?.subject).toBe('Test subject');
		const resource = JSON.parse(row?.resource ?? '{}');
		expect(resource.snippet).toBe('hello there');
		cleanup();
	});

	test('labelsChanged counts only patches that materially change the label set', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({ id: 'a', labelIds: ['INBOX', 'UNREAD'] }),
				message({ id: 'b', labelIds: ['INBOX'] }),
				message({ id: 'c', labelIds: ['INBOX', 'UNREAD'] }),
			],
			's1',
		);

		const { labelsChanged } = db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [
				// 'a': same set in a different order, no material change.
				{ messageId: 'a', labelIds: ['UNREAD', 'INBOX'] },
				// 'b': a real change (UNREAD added).
				{ messageId: 'b', labelIds: ['INBOX', 'UNREAD'] },
				// 'c': identical set, an idempotent echo.
				{ messageId: 'c', labelIds: ['INBOX', 'UNREAD'] },
				// missing row: not found, not counted.
				{ messageId: 'gone', labelIds: ['INBOX'] },
			],
			newHistoryId: '650',
			syncedAt: 's2',
		});

		expect(labelsChanged).toBe(1);
		cleanup();
	});

	test('a labelPatch for a message not yet mirrored is silently skipped', () => {
		const { db, cleanup } = openTmp();
		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: [],
			labelPatches: [{ messageId: 'unknown', labelIds: ['INBOX'] }],
			newHistoryId: '602',
			syncedAt: 's1',
		});
		expect(messageRow(db, 'unknown')).toBeNull();
		expect(db.readRealmState().historyId).toBe('602');
		cleanup();
	});

	test('messagesDeleted physically removes the row', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([message()], 's1');

		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: ['m1'],
			labelPatches: [],
			newHistoryId: '603',
			syncedAt: 's2',
		});

		const row = db.raw
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM messages WHERE id = 'm1'`,
			)
			.get();
		expect(row?.n).toBe(0);
		cleanup();
	});

	test('cursor and all mutations commit atomically (one transaction)', () => {
		const { db, cleanup } = openTmp();
		db.applyHistoryBatch({
			messagesToUpsert: [message({ id: 'm2' })],
			messagesToDelete: [],
			labelPatches: [],
			newHistoryId: '700',
			syncedAt: 's1',
		});
		const state = db.readRealmState();
		expect(state.historyId).toBe('700');
		expect(state.lastSyncedAt).toBe('s1');
		expect(messageRow(db, 'm2')).not.toBeNull();
		cleanup();
	});
});

describe('labels', () => {
	test('ingestLabels replaces the label set', () => {
		const { db, cleanup } = openTmp();
		db.ingestLabels(
			[
				{ id: 'INBOX', name: 'INBOX', type: 'system' },
				{ id: 'Label_1', name: 'Work', type: 'user' },
			],
			's1',
		);
		db.ingestLabels(
			[{ id: 'INBOX', name: 'Inbox renamed', type: 'system' }],
			's2',
		);
		const rows = db.raw
			.query<{ id: string; name: string; type: string }, []>(
				`SELECT id, name, type FROM labels ORDER BY id`,
			)
			.all();
		expect(rows).toEqual([
			{ id: 'INBOX', name: 'Inbox renamed', type: 'system' },
		]);
		cleanup();
	});
});

describe('the read-only handle', () => {
	test('reports an absent mailbox instead of creating one', () => {
		const tmp = tempDir();

		expect(
			openMailDbReadonly({ dataDir: tmp.dir, accountEmail: 'you@example.com' }),
		).toBeNull();
		// The whole point of `openReadonly`: a status or query read against an
		// account that has never synced leaves the disk exactly as it found it.
		expect(existsSync(join(tmp.dir, 'you@example.com'))).toBe(false);
		tmp.cleanup();
	});

	test('rejects writes', () => {
		const { db, dataDir, cleanup } = openTmp();
		db.ingestFullPullPage([message()], 's1');
		const reader = openMailDbReadonly({
			dataDir,
			accountEmail: 'you@example.com',
		});
		expect(reader).not.toBeNull();
		expect(() => reader?.raw.run(`DELETE FROM messages`)).toThrow();
		reader?.close();
		cleanup();
	});

	test('reads a mailbox whose DDL never ran as empty rather than throwing', () => {
		// The one window `mail.db` can exist without the declared tables: a writable
		// open that died between creating the file and its first transaction. The
		// worst a mistaken writable open can do is leave an empty file, so a reader
		// must report it, not crash on it.
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		mkdirSync(accountDir, { recursive: true });
		const path = mailDbPath(tmp.dir, 'you@example.com');
		new Database(path, { create: true }).close();

		const reader = openMailDbReadonly({
			dataDir: tmp.dir,
			accountEmail: 'you@example.com',
		});
		expect(reader?.counts()).toEqual({ messages: 0, labels: 0 });
		expect(reader?.realmState().historyId).toBeNull();
		reader?.close();
		tmp.cleanup();
	});
});

describe('the mailbox file', () => {
	test('an account email that is not one path segment cannot name a directory', () => {
		expect(() => mailDbPath('/data', '../evil')).toThrow(
			'cannot name an account directory',
		);
		expect(() => mailDbPath('/data', 'a/b@example.com')).toThrow(
			'cannot name an account directory',
		);
		expect(() => mailDbPath('/data', '')).toThrow(
			'cannot name an account directory',
		);
	});

	test('is one stable name under the account dir, with no version in it', () => {
		expect(mailDbPath('/data', 'you@example.com')).toBe(
			join('/data', 'you@example.com', 'mail.db'),
		);
	});
});

/** What the current build stamped in the file, read without opening the app's
 * writer (which would rebuild whatever it disagreed with). */
function factCorpusVersion(dataDir: string): string | null {
	const db = new Database(mailDbPath(dataDir, 'you@example.com'), {
		readonly: true,
	});
	const row = db
		.query<{ value: string | null }, [string]>(
			`SELECT value FROM _meta WHERE key = ?`,
		)
		.get('fact_corpus_version');
	db.close();
	return row?.value ?? null;
}

/** Rewind the stamped contract, so the next open sees a fact tier built by a
 * corpus this build no longer promises. Standing in for a real bump keeps the
 * test from having to be edited every time the constant moves. */
function stampStaleCorpusVersion(dataDir: string): void {
	const db = new Database(mailDbPath(dataDir, 'you@example.com'));
	db.run(`UPDATE _meta SET value = '0' WHERE key = 'fact_corpus_version'`);
	db.close();
}

function dbFilesIn(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.endsWith('.db'));
}

describe('opening the mailbox', () => {
	const location = (dataDir: string) => ({
		dataDir,
		accountEmail: 'you@example.com',
	});

	test('a first open creates one file and stamps the fact-tier corpus version', () => {
		const tmp = tempDir();
		const db = openMailDb(location(tmp.dir));
		db.close();

		expect(existsSync(mailDbPath(tmp.dir, 'you@example.com'))).toBe(true);
		expect(dbFilesIn(join(tmp.dir, 'you@example.com'))).toEqual(['mail.db']);
		// The count continues from the reader rewrite that renamed `raw` to
		// `resource`; restarting it would claim a corpus that already existed.
		expect(Number(factCorpusVersion(tmp.dir))).toBeGreaterThan(4);
		tmp.cleanup();
	});

	test('reopening at the same corpus version keeps every row and the cursor', () => {
		const tmp = tempDir();
		const first = openMailDb(location(tmp.dir));
		first.ingestFullPullPage([message()], 's1');
		first.finishFullPull('42', 's1');
		first.close();

		const second = openMailDb(location(tmp.dir));
		expect(second.counts().messages).toBe(1);
		expect(second.readRealmState().historyId).toBe('42');
		second.close();

		expect(dbFilesIn(join(tmp.dir, 'you@example.com'))).toEqual(['mail.db']);
		tmp.cleanup();
	});

	test('a corpus change rebuilds the fact tier in place and clears the cursor', () => {
		const tmp = tempDir();
		const first = openMailDb(location(tmp.dir));
		first.ingestFullPullPage([message()], 's1');
		first.ingestLabels([{ id: 'INBOX', name: 'INBOX', type: 'system' }], 's1');
		first.finishFullPull('42', 's1');
		first.close();
		const version = factCorpusVersion(tmp.dir);

		stampStaleCorpusVersion(tmp.dir);
		const rebuilt = openMailDb(location(tmp.dir));

		// The facts go, and the cursor goes with them: an incremental pass against
		// a history id that describes a corpus we dropped would never converge.
		expect(rebuilt.counts()).toEqual({ messages: 0, labels: 0 });
		expect(rebuilt.readRealmState()).toEqual({
			historyId: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
		});
		rebuilt.close();

		expect(factCorpusVersion(tmp.dir)).toBe(version);
		// In place: no successor file, and nothing left behind to reclaim.
		expect(dbFilesIn(join(tmp.dir, 'you@example.com'))).toEqual(['mail.db']);
		tmp.cleanup();
	});

	test('a rebuild leaves state this build does not declare untouched', () => {
		// Standing in for the durable local overlays ADR-0198 puts in this file.
		// Nothing here is re-pullable, so a rebuild that swept tables or `_meta`
		// keys it did not recognize would destroy the only copy of a user's pending
		// work. The fact tier is the whole of a rebuild's reach.
		const tmp = tempDir();
		const first = openMailDb(location(tmp.dir));
		first.ingestFullPullPage([message()], 's1');
		first.raw.run(
			`CREATE TABLE pending_label_overrides (message_id TEXT PRIMARY KEY, label_id TEXT);`,
		);
		first.raw.run(
			`INSERT INTO pending_label_overrides VALUES ('m1', 'STARRED');`,
		);
		first.raw.run(
			`INSERT INTO _meta (key, value) VALUES ('overlay_note', 'x');`,
		);
		first.close();

		stampStaleCorpusVersion(tmp.dir);
		const rebuilt = openMailDb(location(tmp.dir));

		expect(rebuilt.counts().messages).toBe(0);
		expect(
			rebuilt.raw
				.query<{ label_id: string }, []>(
					`SELECT label_id FROM pending_label_overrides WHERE message_id = 'm1'`,
				)
				.get(),
		).toEqual({ label_id: 'STARRED' });
		expect(
			rebuilt.raw
				.query<{ value: string }, []>(
					`SELECT value FROM _meta WHERE key = 'overlay_note'`,
				)
				.get(),
		).toEqual({ value: 'x' });
		rebuilt.close();
		tmp.cleanup();
	});

	test('a file from before the version was stamped rebuilds to the declared shape', () => {
		// What an install carried over from a pre-corpus-version `mail.db`: a fact
		// table shaped by a contract nothing records, which reads as a mismatch
		// because no version is stamped at all.
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		mkdirSync(accountDir, { recursive: true, mode: 0o700 });
		const legacy = new Database(mailDbPath(tmp.dir, 'you@example.com'), {
			create: true,
		});
		legacy.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, raw TEXT);`);
		legacy.run(`INSERT INTO messages (id, raw) VALUES ('old', '{}');`);
		legacy.close();

		const db = openMailDb(location(tmp.dir));
		const columns = db.raw
			.query<{ name: string }, []>(`PRAGMA table_info(messages)`)
			.all()
			.map((row) => row.name);

		expect(columns).toContain('resource');
		expect(columns).not.toContain('raw');
		expect(db.counts().messages).toBe(0);
		db.close();
		expect(Number(factCorpusVersion(tmp.dir))).toBeGreaterThan(4);
		tmp.cleanup();
	});
});

describe('the stored payload', () => {
	test('is a column named resource, and there is no raw column', () => {
		// `format=raw` is Gmail's name for the base64url RFC 5322 blob this app
		// never fetches, so a column named `raw` holding the parsed `format=full`
		// resource was a false statement in the schema (ADR-0196).
		const { db, cleanup } = openTmp();
		const columnsOf = (table: string) =>
			db.raw
				.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name);

		expect(columnsOf('messages')).toContain('resource');
		expect(columnsOf('messages')).not.toContain('raw');
		expect(columnsOf('labels')).toContain('resource');
		expect(columnsOf('labels')).not.toContain('raw');
		cleanup();
	});

	test('stores the parsed resource verbatim, including fields nothing projects', () => {
		const { db, cleanup } = openTmp();
		const unread = {
			...message(),
			sizeEstimate: 4242,
			historyId: '99',
		} as GmailMessage;
		db.ingestFullPullPage([unread], 's1');

		const stored = JSON.parse(messageRow(db, 'm1')?.resource ?? '{}');
		expect(stored.sizeEstimate).toBe(4242);
		expect(stored.historyId).toBe('99');
		cleanup();
	});
});

describe('a body Gmail externalized', () => {
	/** A `text/plain` part whose bytes Gmail holds behind an `attachmentId`
	 * instead of inline `data`, which `format=full` does not guarantee. */
	const externalizedBody = (): GmailMessage =>
		message({
			payload: {
				headers: [{ name: 'Subject', value: 'Big one' }],
				parts: [
					{
						mimeType: 'text/plain',
						body: { attachmentId: 'ANGjdJ8', size: 900_000 },
					},
				],
			},
		});

	test('ingests as a normal, complete row', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([externalizedBody()], 's1');

		const row = messageRow(db, 'm1');
		// Synchronized, not partial: headers, labels, and snippet are all here.
		expect(row?.subject).toBe('Big one');
		expect(row?.snippet).toBe('hello there');
		expect(JSON.parse(row?.label_ids ?? '[]')).toEqual(['INBOX', 'UNREAD']);
		// The body is simply not local, and no second call goes looking for it.
		expect(row?.body_text).toBeNull();
		cleanup();
	});

	test('reads back as honestly absent, not as an unexplained blank', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage([externalizedBody()], 's1');

		const detail = db.getMessageDetail('m1');
		expect(detail?.bodyText).toBeNull();
		expect(detail?.unsafeBodyHtml).toBeNull();
		expect(detail?.bodyExternalized).toBe(true);
		cleanup();
	});

	test('an attached file beside an inline body is not an externalized body', () => {
		const { db, cleanup } = openTmp();
		db.ingestFullPullPage(
			[
				message({
					payload: {
						headers: [],
						parts: [
							{
								mimeType: 'text/plain',
								body: { data: base64Url('Inline body') },
							},
							{
								mimeType: 'application/pdf',
								filename: 'invoice.pdf',
								body: { attachmentId: 'ANGjdJ9', size: 42_000 },
							},
						],
					},
				}),
			],
			's1',
		);

		const detail = db.getMessageDetail('m1');
		expect(detail?.bodyText).toBe('Inline body');
		expect(detail?.bodyExternalized).toBe(false);
		cleanup();
	});
});
