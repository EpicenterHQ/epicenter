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
import { type IntentDb, openIntentDb } from './intent.ts';

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
			first.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
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
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: true }]);

			// Archive then unarchive then archive is one row, not three acts.
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
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
			intent.assert([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
				{ messageId: 'm1', labelId: 'UNREAD', want: false },
			]);
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
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
			const [inFlight] = intent.pending();
			if (!inFlight) throw new Error('expected a pending assertion');

			// The user changes their mind while the delivery is in flight.
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: true }]);

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
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: false }]);
			const [first] = intent.pending();
			if (!first) throw new Error('expected a pending assertion');
			expect(intent.retire([first])).toBe(1);
			expect(intent.pending()).toEqual([]);

			// A counter derived from the rows would hand out 1 again here, and the
			// stale retirement below would delete a wish Gmail never heard.
			intent.assert([{ messageId: 'm1', labelId: 'INBOX', want: true }]);
			expect(intent.pending()[0]?.seq).toBe(2);
			expect(intent.retire([first])).toBe(0);
			expect(intent.pending()).toHaveLength(1);
		} finally {
			cleanup();
		}
	});
});
