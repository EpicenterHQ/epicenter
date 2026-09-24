/**
 * The authority's side of the boundary, pinned from outside: every verb moves
 * bytes it cannot read.
 *
 * The structural half of the claim is the file itself: `authority.ts` imports
 * no Yjs and no `@epicenter/app/definition`, and there is no verb that could
 * interpret an update. This suite pins the behavioral half by driving every
 * verb with bytes no Yjs decode would survive. If sequencing, catch-up,
 * snapshot replacement or document identity ever grew a peek at the
 * payload, the garbage here would surface it as a refusal or a throw.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { expectErr, expectOk } from 'wellcrafted/testing';

import { openSyncAuthority } from './authority.js';

/** Deterministic garbage: bytes that are not a Yjs update by any decoding. */
function opaque(seed: number, length = 32): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (seed * 31 + i * 7 + 255) % 256);
}

function openAuthority() {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	// A floor of one byte so the snapshot policy is reachable from tiny bytes.
	return openSyncAuthority({ sqlite, snapshotFloorBytes: 1 });
}

describe('an authority needs no definition: every verb moves unread bytes', () => {
	test('append assigns positions and since returns the bytes untouched', () => {
		const authority = openAuthority();
		const first = authority.append(opaque(1));
		if (first.error !== null) throw first.error;
		expect(first.data).toBe(1);
		const second = authority.append(opaque(2));
		if (second.error !== null) throw second.error;
		expect(second.data).toBe(2);

		const entries = authority.since(0);
		if (entries.error !== null) throw entries.error;
		expect(entries.data.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(entries.data[0]?.bytes).toEqual(opaque(1));
		expect(entries.data[1]?.bytes).toEqual(opaque(2));
	});

	test('a snapshot of garbage replaces covered history and is served back whole', () => {
		const authority = openAuthority();
		authority.append(opaque(1));
		authority.append(opaque(2));
		authority.append(opaque(3));

		// The tail outgrew the (absent) snapshot, so the policy asks for one;
		// the policy is arithmetic over stored sizes, never over content.
		const wanted = authority.shouldSnapshot();
		if (wanted.error !== null) throw wanted.error;
		expect(wanted.data).toBe(true);

		const replaced = authority.replaceSnapshot(2, opaque(9, 128));
		if (replaced.error !== null) throw replaced.error;

		// Everything the snapshot covers is gone; the tail after it survives.
		const after = authority.since(0);
		if (after.error !== null) throw after.error;
		expect(after.data.map((entry) => entry.seq)).toEqual([3]);
		const held = authority.snapshot();
		if (held.error !== null) throw held.error;
		expect(held.data?.position).toBe(2);
		expect(held.data?.bytes).toEqual(opaque(9, 128));
	});
});

describe('a generation is seeded once, from one whole state (ADR-0293)', () => {
	test('the seed becomes the snapshot, and the tail is empty behind it', () => {
		const authority = openAuthority();
		const state = new Uint8Array([1, 2, 3, 4]);

		const position = expectOk(authority.seed(state));
		// Position 1, not 0: zero already means "no snapshot", so the state is
		// stored directly as the snapshot at position 1.
		expect(position).toBe(1);
		expect(expectOk(authority.snapshotPosition())).toBe(1);
		expect(expectOk(authority.snapshot())?.bytes).toEqual(state);
		// No transient log entry is needed, so a bootstrapping device receives
		// the state exactly once.
		expect(expectOk(authority.since(0))).toEqual([]);
	});

	test('a seeded log takes ordinary appends after it', () => {
		const authority = openAuthority();
		expectOk(authority.seed(new Uint8Array([1])));
		expect(expectOk(authority.append(new Uint8Array([2])))).toBe(2);
		expect(expectOk(authority.since(1)).map((entry) => entry.seq)).toEqual([2]);
	});

	test('seeding twice is refused: a generation is created once', () => {
		const authority = openAuthority();
		expectOk(authority.seed(new Uint8Array([1])));
		expect(authority.seed(new Uint8Array([9])).error?.name).toBe(
			'SnapshotRefused',
		);
		expect(expectOk(authority.snapshot())?.bytes).toEqual(new Uint8Array([1]));
	});

	test('a log that already took an append refuses a seed', () => {
		const authority = openAuthority();
		expectOk(authority.append(new Uint8Array([1])));
		expect(authority.seed(new Uint8Array([9])).error?.name).toBe(
			'SnapshotRefused',
		);
	});
});

test('a failed seed rolls back all chunks and can be retried without nested transactions', () => {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	let fail = true;
	let inTransaction = false;
	let inserts = 0;
	const authority = openSyncAuthority({
		sqlite: {
			...sqlite,
			run(sql, bindings) {
				if (sql.includes('INSERT') && sql.includes('_snapshot')) {
					inserts += 1;
					if (fail && inserts === 2) throw new Error('snapshot insert failed');
				}
				return sqlite.run(sql, bindings);
			},
			transaction(run) {
				if (inTransaction) throw new Error('nested transaction');
				inTransaction = true;
				try {
					return sqlite.transaction(run);
				} finally {
					inTransaction = false;
				}
			},
		},
	});
	const bytes = opaque(4, 2_097_153);
	expectErr(authority.seed(bytes));
	expect(expectOk(authority.head())).toBe(0);
	expect(expectOk(authority.snapshot())).toBeUndefined();
	expect(expectOk(authority.since(0))).toEqual([]);
	fail = false;
	expect(expectOk(authority.seed(bytes))).toBe(1);
	expect(expectOk(authority.snapshot())?.bytes).toEqual(bytes);
	expect(expectOk(authority.since(0))).toEqual([]);
});
