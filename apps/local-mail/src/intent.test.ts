/**
 * The durable intent store's map semantics.
 *
 * These pin the two properties everything else leans on: the store holds a MAP
 * from `(message, label)` to a wish, not a log of acts; and its sequence is
 * monotonic for the life of the account, which is what stops an in-flight
 * delivery from retiring a newer wish. A row leaves only through `retire`, and
 * only against the sequence a delivery actually proved.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb } from './db.ts';
import { type IntentDb, openIntentDb } from './intent.ts';

const ASSERTED_AT = '2026-08-01T12:00:00.000Z';

function openTmp(): { intent: IntentDb; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-intent-'));
	const intent = openIntentDb({
		dataDir: dir,
		accountEmail: 'you@example.com',
	});
	return {
		intent,
		dir,
		cleanup: () => {
			intent.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe('openIntentDb', () => {
	test('creates a 0600 intent.db inside the account directory', () => {
		const { intent, dir, cleanup } = openTmp();
		try {
			expect(intent.path).toBe(join(dir, 'you@example.com', 'intent.db'));
			expect(existsSync(intent.path)).toBe(true);
			expect(statSync(intent.path).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});

	test('reopening keeps what was asserted', () => {
		const dir = mkdtempSync(join(tmpdir(), 'local-mail-intent-'));
		try {
			const first = openIntentDb({ dataDir: dir, accountEmail: 'a@b.c' });
			first.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			first.close();

			const second = openIntentDb({ dataDir: dir, accountEmail: 'a@b.c' });
			expect(second.pending()).toEqual([
				{ messageId: 'm1', labelId: 'INBOX', want: false, seq: 1 },
			]);
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('assert', () => {
	test('re-asserting a pair overwrites it and takes a new sequence', () => {
		const { intent, cleanup } = openTmp();
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: true }],
				ASSERTED_AT,
			);

			// Archive then unarchive then archive is one row, not three acts.
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			const pending = intent.pending();
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ labelId: 'INBOX', want: false });
			expect(pending[0]?.seq).toBe(3);
		} finally {
			cleanup();
		}
	});

	test('distinct labels on one message are distinct rows, ordered by sequence', () => {
		const { intent, cleanup } = openTmp();
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'UNREAD', want: false },
				],
				ASSERTED_AT,
			);
			expect(intent.pending().map((i) => [i.labelId, i.seq])).toEqual([
				['INBOX', 1],
				['UNREAD', 2],
			]);
		} finally {
			cleanup();
		}
	});
});

describe('retire', () => {
	test('retires only the sequence that was delivered', () => {
		const { intent, cleanup } = openTmp();
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			const [inFlight] = intent.pending();
			if (!inFlight) throw new Error('expected a pending assertion');

			// The user changes their mind while the delivery is in flight.
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: true }],
				ASSERTED_AT,
			);

			// The delivery lands, carrying the OLD sequence: it proves nothing about
			// the newer wish, so it retires nothing.
			expect(intent.retire([inFlight])).toBe(0);
			expect(intent.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: true },
			]);
		} finally {
			cleanup();
		}
	});

	test('a sequence is never reused, even after the table empties', () => {
		const { intent, cleanup } = openTmp();
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			const [first] = intent.pending();
			if (!first) throw new Error('expected a pending assertion');
			expect(intent.retire([first])).toBe(1);
			expect(intent.pending()).toEqual([]);

			// A counter derived from the rows would hand out 1 again here, and the
			// stale retirement below would delete a wish Gmail never heard.
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: true }],
				ASSERTED_AT,
			);
			expect(intent.pending()[0]?.seq).toBe(2);
			expect(intent.retire([first])).toBe(0);
			expect(intent.pending()).toHaveLength(1);
		} finally {
			cleanup();
		}
	});
});

describe('durability', () => {
	test('assertions survive the mirror being deleted and rebuilt', () => {
		// The mirror is disposable by design: a shape change deletes the file and
		// re-pulls from Gmail. The whole reason intent lives in its own file is
		// that a user's undelivered triage must not go with it.
		const dir = mkdtempSync(join(tmpdir(), 'local-mail-intent-'));
		const account = { dataDir: dir, accountEmail: 'you@example.com' };
		try {
			const intent = openIntentDb(account);
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			intent.close();

			const mirror = openMailDb(account);
			mirror.ingestFullPullPage(
				[
					{
						id: 'm1',
						threadId: 't1',
						labelIds: ['INBOX'],
						payload: { headers: [] },
					},
				],
				ASSERTED_AT,
			);
			// Force the rebuild the same way a shape change does: leave a version the
			// opener cannot recognise, then reopen.
			mirror.raw.run(`UPDATE _meta SET value = 'ancient' WHERE key = ?`, [
				'schema_version',
			]);
			mirror.close();

			const rebuilt = openMailDb(account);
			expect(rebuilt.counts().messages).toBe(0);
			rebuilt.close();

			const reopened = openIntentDb(account);
			expect(reopened.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
			]);
			expect(reopened.summary()).toEqual({
				assertions: 1,
				oldestAssertedAt: ASSERTED_AT,
			});
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a second process continues the sequence rather than restarting it', () => {
		// The counter lives on disk, so two writers (the open app and a CLI verb)
		// cannot hand out the same number. Driven through a real subprocess: this
		// is the case where an in-memory counter would look fine and be wrong.
		//
		// Deliberately sequential rather than racing. What needs proving is that
		// the sequence is read from and written to the file, which a race would
		// only obscure; concurrent SAFETY is SQLite's immediate transaction, and
		// there is at most one Gmail writer regardless (the reconcile lock).
		const dir = mkdtempSync(join(tmpdir(), 'local-mail-intent-'));
		const account = { dataDir: dir, accountEmail: 'you@example.com' };
		try {
			const first = openIntentDb(account);
			first.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				ASSERTED_AT,
			);
			expect(first.pending()[0]?.seq).toBe(1);
			first.close();

			const child = Bun.spawnSync([
				process.execPath,
				'-e',
				`import { openIntentDb } from ${JSON.stringify(join(import.meta.dir, 'intent.ts'))};
				 const intent = openIntentDb(${JSON.stringify(account)});
				 intent.assert([{ messageId: 'm2', labelId: 'UNREAD', want: false }], ${JSON.stringify(ASSERTED_AT)});
				 intent.close();`,
			]);
			expect(child.stderr.toString()).toBe('');
			expect(child.exitCode).toBe(0);

			const second = openIntentDb(account);
			second.assert(
				[{ messageId: 'm3', labelId: 'STARRED', want: true }],
				ASSERTED_AT,
			);
			// 1 from this process, 2 from the child, 3 from this process again: no
			// number is ever handed out twice, so no delivery can retire a wish it
			// did not prove.
			expect(second.pending().map((i) => [i.messageId, i.seq])).toEqual([
				['m1', 1],
				['m2', 2],
				['m3', 3],
			]);
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('summary reports how much is owed and how long the oldest has waited', () => {
		const { intent, cleanup } = openTmp();
		try {
			expect(intent.summary()).toEqual({
				assertions: 0,
				oldestAssertedAt: null,
			});

			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				'2026-08-01T10:00:00.000Z',
			);
			intent.assert(
				[{ messageId: 'm2', labelId: 'UNREAD', want: false }],
				'2026-08-01T11:00:00.000Z',
			);

			expect(intent.summary()).toEqual({
				assertions: 2,
				oldestAssertedAt: '2026-08-01T10:00:00.000Z',
			});

			// Re-asserting a pair is a new answer, so its wait restarts with it.
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: true }],
				'2026-08-01T12:00:00.000Z',
			);
			expect(intent.summary()).toEqual({
				assertions: 2,
				oldestAssertedAt: '2026-08-01T11:00:00.000Z',
			});
		} finally {
			cleanup();
		}
	});
});
