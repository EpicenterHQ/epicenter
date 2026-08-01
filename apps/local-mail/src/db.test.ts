/**
 * The mirror's write contract. Unlike `apps/local-books`' monotonic-timestamp
 * guard (QuickBooks CDC deletes are stubs, so a stale write must not regress a
 * newer row), Gmail's history stream is applied strictly in the order it is
 * received within one process, so `upsertMessage`/`applyHistoryBatch` are
 * plain last-write-wins: what these tests actually cover is the FULL-pull vs
 * INCREMENTAL-patch split (a `labelPatch` must edit the stored resource's
 * `labelIds` in place and leave the rest of the payload alone), the atomic-cursor
 * discipline ported from `db.ts`, and the version-named artifact lifecycle
 * (ADR-0197): opening never destroys, a changed shape is a new filename.
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
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type MailDb,
	mailMirror,
	openMailDb,
	openMailDbReadonly,
} from './db.ts';
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

/** Live row count straight from SQL. The writer handle serves the app's read
 * models, not status, so it has no `counts()` of its own; the readonly reader
 * is where that read model lives. */
function countRows(db: MailDb, table: 'messages' | 'labels'): number {
	return (
		db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
			?.n ?? 0
	);
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

	test('a deleted message leaves the mirror, and the rest stay newest first', () => {
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

		expect(countRows(db, 'messages')).toBe(2);
		expect(countRows(db, 'labels')).toBe(1);
		expect(
			db.listMessages({ limit: 10, offset: 0 }).map((row) => row.subject),
		).toEqual(['Newest subject', 'Older subject']);

		db.applyHistoryBatch({
			messagesToUpsert: [],
			messagesToDelete: ['newest'],
			labelPatches: [],
			newHistoryId: '700',
			syncedAt: 's2',
		});
		expect(countRows(db, 'messages')).toBe(1);
		expect(
			db.listMessages({ limit: 10, offset: 0 }).map((row) => row.subject),
		).toEqual(['Older subject']);
		cleanup();
	});

	test('creates data and account dirs as 0700 and artifact files as 0600', () => {
		const tmp = tempDir();
		chmodSync(tmp.dir, 0o755);
		const accountDir = join(tmp.dir, 'you@example.com');
		// The mirror primitive does not know the artifact holds someone's mail, so
		// the app is what applies the permissions to the handle it receives, to the
		// versioned filename and both SQLite sidecars.
		const { path } = mailMirror(tmp.dir, 'you@example.com');
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
	test('reports an absent artifact instead of creating one', () => {
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

	test('reads an artifact whose DDL never ran as empty rather than throwing', () => {
		// The one window a current artifact can exist without the declared tables:
		// a writable open that died between creating the file and running its DDL.
		// ADR-0197 says the worst a mistaken writable open can do is leave an empty
		// file, so a reader must report it, not crash on it.
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		mkdirSync(accountDir, { recursive: true });
		const { path } = mailMirror(tmp.dir, 'you@example.com');
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

describe('the mirror', () => {
	test('an account email that is not one path segment cannot name a mirror directory', () => {
		expect(() => mailMirror('/data', '../evil')).toThrow(
			'cannot name a mirror directory',
		);
		expect(() => mailMirror('/data', 'a/b@example.com')).toThrow(
			'cannot name a mirror directory',
		);
		expect(() => mailMirror('/data', '')).toThrow(
			'cannot name a mirror directory',
		);
	});

	test('names the artifact by its corpus version, under the account dir', () => {
		const { path, version } = mailMirror('/data', 'you@example.com');
		expect(path).toBe(join('/data', 'you@example.com', `mail.v${version}.db`));
	});

	test('uses the post-reader corpus version, so v4 is never reopened', () => {
		// The reader-mirror rewrite that renamed `raw` to `resource` is version 5.
		// Restarting the count would name a fresh artifact after a corpus that
		// already existed.
		expect(mailMirror('/data', 'you@example.com').version).toBeGreaterThan(4);
	});
});

describe('the artifact lifecycle', () => {
	test('reopening keeps every row: opening is never destructive', () => {
		const tmp = tempDir();
		const location = { dataDir: tmp.dir, accountEmail: 'you@example.com' };
		const first = openMailDb(location);
		first.ingestFullPullPage([message()], 's1');
		first.finishFullPull('42', 's1');
		first.close();

		const second = openMailDb(location);
		expect(countRows(second, 'messages')).toBe(1);
		expect(second.readRealmState().historyId).toBe('42');
		second.close();

		// One version, one filename: reopening at the same version must not have
		// produced a second artifact.
		expect(
			readdirSync(join(tmp.dir, 'you@example.com')).filter((name) =>
				name.endsWith('.db'),
			),
		).toEqual([`mail.v${mailMirror(tmp.dir, 'you@example.com').version}.db`]);
		tmp.cleanup();
	});

	test('a predecessor artifact is retained, never opened, and never swept', () => {
		// A predecessor is what a version bump leaves behind. Opening the current
		// artifact must not consult it, migrate it, or unlink it: it is the only
		// complete local copy while the successor backfills, and a reader compiled
		// against it may still be running.
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		mkdirSync(accountDir, { recursive: true, mode: 0o700 });
		const previousVersion = mailMirror(tmp.dir, 'you@example.com').version - 1;
		const predecessorPath = join(accountDir, `mail.v${previousVersion}.db`);
		const predecessor = new Database(predecessorPath, { create: true });
		predecessor.run(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
		predecessor.run(`INSERT INTO messages (id) VALUES ('old');`);
		predecessor.close();

		const db = openMailDb({
			dataDir: tmp.dir,
			accountEmail: 'you@example.com',
		});
		// The successor starts empty. It does not inherit, re-project, or delete.
		expect(countRows(db, 'messages')).toBe(0);
		db.close();

		expect(existsSync(predecessorPath)).toBe(true);
		const kept = new Database(predecessorPath, { readonly: true });
		expect(kept.query(`SELECT count(*) AS n FROM messages`).get()).toEqual({
			n: 1,
		});
		kept.close();

		const mirror = mailMirror(tmp.dir, 'you@example.com');
		const artifacts = mirror.artifacts();
		expect(artifacts.length).toBe(2);
		expect(artifacts.filter((a) => a.current).map((a) => a.version)).toEqual([
			mirror.version,
		]);
		expect(artifacts.filter((a) => !a.current).map((a) => a.version)).toEqual([
			previousVersion,
		]);
		tmp.cleanup();
	});

	test('reclaim drops predecessors and cannot reach the siblings beside them', () => {
		const tmp = tempDir();
		const accountDir = join(tmp.dir, 'you@example.com');
		const db = openMailDb({
			dataDir: tmp.dir,
			accountEmail: 'you@example.com',
		});
		db.close();
		const mirror = mailMirror(tmp.dir, 'you@example.com');
		const predecessorPath = join(accountDir, `mail.v${mirror.version - 1}.db`);
		writeFileSync(predecessorPath, '');
		writeFileSync(`${predecessorPath}-wal`, '');
		// Local Mail's siblings: the sync-owner lock and the OAuth material. The
		// filename grammar is what puts them out of reclaim's reach (ADR-0197).
		writeFileSync(join(accountDir, 'lock.db'), '');
		writeFileSync(join(accountDir, 'credentials.json'), '{}');
		writeFileSync(join(accountDir, 'provider.json'), '{}');

		expect(mirror.reclaimPredecessors().map((a) => a.version)).toEqual([
			mirror.version - 1,
		]);

		expect(existsSync(predecessorPath)).toBe(false);
		expect(existsSync(`${predecessorPath}-wal`)).toBe(false);
		// Sidecars of the live artifact are noise here; what matters is that every
		// non-artifact file the app keeps beside the mirror survived untouched.
		expect(
			readdirSync(accountDir)
				.filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
				.sort(),
		).toEqual(
			[
				'credentials.json',
				'lock.db',
				'provider.json',
				`mail.v${mirror.version}.db`,
			].sort(),
		);
		// The current artifact is not a predecessor, so a second call is a no-op
		// rather than the thing that deletes the mailbox.
		expect(mirror.reclaimPredecessors()).toEqual([]);
		expect(existsSync(mirror.path)).toBe(true);
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
