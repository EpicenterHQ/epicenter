/**
 * Isolated current-generation storage protocol. These tests exercise real SQLite
 * commits, rollback, reopening, stale writers, and retry receipts. They do not
 * establish socket admission, browser retirement, or archive fidelity.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCurrentAuthority } from '../../../src/data/sync/authority.js';

function portable(database: Database): SqliteDatabase {
	const sqlite = createBunSqliteAdapter(database);
	let active = false;
	return {
		...sqlite,
		transaction(run) {
			if (active) throw new Error('Nested transaction');
			active = true;
			try {
				return sqlite.transaction(run);
			} finally {
				active = false;
			}
		},
	};
}

const bytes = (value: number) => new Uint8Array([value]);

function setup() {
	const database = new Database(':memory:');
	const authority = openCurrentAuthority({ sqlite: portable(database) });
	return { database, authority, [Symbol.dispose]: () => database.close() };
}

test('two first callers observe one complete current generation', async () => {
	using context = setup();
	const other = openCurrentAuthority({ sqlite: portable(context.database) });
	const results = await Promise.all([
		Promise.resolve().then(async () =>
			context.authority.ensureCurrent(bytes(1)),
		),
		Promise.resolve().then(async () => other.ensureCurrent(bytes(2))),
	]);
	expect(results[0]).toEqual(results[1]);
	expect(results[0]).toMatchObject({
		generation: 1,
		head: 1,
		snapshot: { bytes: bytes(1) },
		tail: [],
	});
});

test('capture includes the whole tail even beyond a log read batch', async () => {
	using context = setup();
	context.authority.ensureCurrent(bytes(1));
	for (let i = 0; i < 130; i++) context.authority.bind(1).append(bytes(i));
	const capture = context.authority.capture();
	expect(capture.head).toBe(131);
	expect(capture.snapshot.position).toBe(1);
	expect(capture.tail).toHaveLength(130);
	expect(capture.tail.at(-1)).toEqual({ seq: 131, bytes: bytes(129) });
});

test('a write accepted during preparation prevents activation', async () => {
	using context = setup();
	const expected = context.authority.ensureCurrent(bytes(1));
	context.authority.bind(1).append(bytes(2));
	expect(
		(
			await context.authority.prepareActivation({
				operation: 'restore',
				expected,
				bytes: bytes(9),
			})
		).activate(),
	).toEqual({ status: 'conflict' });
	expect(context.authority.capture()).toMatchObject({ generation: 1, head: 2 });
});

test('two restores of the same capture have one winner', async () => {
	using context = setup();
	const expected = context.authority.ensureCurrent(bytes(1));
	const results = await Promise.all(
		['a', 'b'].map((operation) =>
			Promise.resolve().then(async () =>
				(
					await context.authority.prepareActivation({
						operation,
						expected,
						bytes: bytes(9),
					})
				).activate(),
			),
		),
	);
	expect(results).toEqual([
		{ status: 'activated', operation: 'a', generation: 2, head: 1 },
		{ status: 'conflict' },
	]);
});

test('retired writers cannot append or fold after old bytes are removed', async () => {
	using context = setup();
	const oldOwner = openCurrentAuthority({ sqlite: portable(context.database) });
	const expected = context.authority.ensureCurrent(bytes(1));
	(
		await context.authority.prepareActivation({
			operation: 'a',
			expected,
			bytes: bytes(9),
		})
	).activate();
	expect(expectErr(oldOwner.bind(1).append(bytes(2)))).toMatchObject({
		name: 'GenerationUnavailable',
		current: 2,
	});
	expect(
		expectErr(oldOwner.bind(1).replaceSnapshot(2, bytes(3))),
	).toMatchObject({
		name: 'GenerationUnavailable',
		current: 2,
	});
	expect(context.authority.capture()).toEqual({
		generation: 2,
		head: 1,
		snapshot: { position: 1, bytes: bytes(9) },
		tail: [],
	});
});

test('a lost activation response returns its durable receipt after reopening and later activation', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'restore-proof-'));
	const path = join(directory, 'authority.sqlite');
	try {
		const first = new Database(path);
		const authority = openCurrentAuthority({ sqlite: portable(first) });
		const expected = authority.ensureCurrent(bytes(1));
		const request = { operation: 'lost', expected, bytes: bytes(9) };
		const receipt = (await authority.prepareActivation(request)).activate();
		(
			await authority.prepareActivation({
				operation: 'next',
				expected: authority.capture(),
				bytes: bytes(8),
			})
		).activate();
		first.close();
		const second = new Database(path);
		try {
			const reopened = openCurrentAuthority({ sqlite: portable(second) });
			expect((await reopened.prepareActivation(request)).activate()).toEqual(
				receipt,
			);
			expect(reopened.capture().generation).toBe(3);
			expect(
				(
					await reopened.prepareActivation({ ...request, bytes: bytes(7) })
				).activate(),
			).toEqual({
				status: 'operation-conflict',
			});
			expect(
				(
					await reopened.prepareActivation({
						...request,
						expected: { generation: 2, head: 1 },
					})
				).activate(),
			).toEqual({ status: 'operation-conflict' });
		} finally {
			second.close();
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test('receipt failure rolls back generation, replacement bytes, and deletion together', async () => {
	using context = setup();
	const expected = context.authority.ensureCurrent(bytes(1));
	context.database.run(
		`CREATE TRIGGER fail_receipt BEFORE INSERT ON _restore_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`,
	);
	const request = { operation: 'retry', expected, bytes: bytes(9) };
	const prepared = await context.authority.prepareActivation(request);
	expect(() => prepared.activate()).toThrow('injected receipt failure');
	expect(context.authority.capture()).toEqual(expected);
	context.database.run('DROP TRIGGER fail_receipt');
	expect(
		(await context.authority.prepareActivation(request)).activate(),
	).toMatchObject({
		status: 'activated',
		generation: 2,
	});
});

test('replacement snapshot failure restores the prior snapshot and tail without a receipt', async () => {
	using context = setup();
	context.authority.ensureCurrent(bytes(1));
	context.authority.bind(1).append(bytes(2));
	const expected = context.authority.capture();
	context.database.run(
		`CREATE TRIGGER fail_replacement BEFORE INSERT ON _snapshot BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`,
	);
	const request = { operation: 'retry', expected, bytes: bytes(9) };
	const prepared = await context.authority.prepareActivation(request);
	expect(() => prepared.activate()).toThrow();
	expect(context.authority.capture()).toEqual(expected);
	expect(
		context.database.query('SELECT * FROM _restore_receipts').all(),
	).toEqual([]);
	context.database.run('DROP TRIGGER fail_replacement');
	expect(
		(await context.authority.prepareActivation(request)).activate(),
	).toMatchObject({
		status: 'activated',
		generation: 2,
	});
});

test('failed initial snapshot leaves no generation and permits retry', async () => {
	using context = setup();
	context.database.run(
		`CREATE TRIGGER fail_seed BEFORE INSERT ON _snapshot BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END`,
	);
	expect(() => context.authority.ensureCurrent(bytes(1))).toThrow();
	expect(
		context.database.query('SELECT * FROM _current_generation').all(),
	).toEqual([]);
	context.database.run('DROP TRIGGER fail_seed');
	expect(context.authority.ensureCurrent(bytes(2))).toMatchObject({
		generation: 1,
		snapshot: { bytes: bytes(2) },
	});
});

test('ten replacements retain only each replacement and reject every predecessor', async () => {
	using context = setup();
	context.authority.ensureCurrent(bytes(0));
	for (let i = 1; i <= 10; i++) {
		(
			await context.authority.prepareActivation({
				operation: String(i),
				expected: context.authority.capture(),
				bytes: bytes(i),
			})
		).activate();
		for (let generation = 1; generation <= i; generation++) {
			expect(
				expectErr(context.authority.bind(generation).append(bytes(99))),
			).toMatchObject({
				name: 'GenerationUnavailable',
				current: i + 1,
			});
		}
		expect(context.authority.capture()).toEqual({
			generation: i + 1,
			head: 1,
			snapshot: { position: 1, bytes: bytes(i) },
			tail: [],
		});
	}
});

test('ordinary folding keeps generation and uncovered tail', async () => {
	using context = setup();
	context.authority.ensureCurrent(bytes(1));
	context.authority.bind(1).append(bytes(2));
	context.authority.bind(1).append(bytes(3));
	expectOk(context.authority.bind(1).replaceSnapshot(2, bytes(8)));
	expect(context.authority.capture()).toEqual({
		generation: 1,
		head: 3,
		snapshot: { position: 2, bytes: bytes(8) },
		tail: [{ seq: 3, bytes: bytes(3) }],
	});
});

test('uninitialized or invalid generations never acquire a writable history', async () => {
	using context = setup();
	expect(expectErr(context.authority.bind(1).append(bytes(1)))).toMatchObject({
		current: undefined,
	});
	expect(() => context.authority.ensureCurrent(new Uint8Array())).toThrow();
	context.authority.ensureCurrent(bytes(1));
	for (const generation of [0, -1, NaN, 1.5, Infinity]) {
		expect(() => context.authority.bind(generation).append(bytes(1))).toThrow();
	}
	expect(expectErr(context.authority.bind(2).append(bytes(1)))).toMatchObject({
		name: 'GenerationUnavailable',
		current: 1,
	});
	expect(context.authority.capture().head).toBe(1);
});

test('retained handles refuse every read and mutation after another owner activates', async () => {
	using context = setup();
	const expected = context.authority.ensureCurrent(bytes(1));
	const held = context.authority.bind(1);
	const reopened = openCurrentAuthority({ sqlite: portable(context.database) });
	(
		await reopened.prepareActivation({
			operation: 'restore',
			expected,
			bytes: bytes(9),
		})
	).activate();
	for (const result of [
		held.admission(),
		held.head(),
		held.snapshot(),
		held.snapshotPosition(),
		held.since(0),
		held.shouldSnapshot(),
		held.storedBytes(),
		held.append(bytes(2)),
		held.seed(bytes(3)),
		held.replaceSnapshot(2, bytes(4)),
	]) {
		expect(expectErr(result)).toMatchObject({
			name: 'GenerationUnavailable',
			generation: 1,
			current: 2,
		});
	}
	expect(reopened.capture()).toMatchObject({
		generation: 2,
		head: 1,
		snapshot: { bytes: bytes(9) },
		tail: [],
	});
});

test('preparation owns the captured position and bytes across asynchronous hashing and activation', async () => {
	using context = setup();
	const expected = context.authority.ensureCurrent(bytes(1));
	const replacement = bytes(9);
	const pending = context.authority.prepareActivation({
		operation: 'restore',
		expected,
		bytes: replacement,
	});
	expected.generation = 88;
	expected.head = 99;
	replacement[0] = 7;
	const prepared = await pending;
	expect(prepared.activate()).toEqual({
		status: 'activated',
		operation: 'restore',
		generation: 2,
		head: 1,
	});
	expect(context.authority.capture().snapshot.bytes).toEqual(bytes(9));
	const retry = await context.authority.prepareActivation({
		operation: 'restore',
		expected: { generation: 1, head: 1 },
		bytes: bytes(9),
	});
	expect(retry.activate()).toEqual(prepared.activate());
});
