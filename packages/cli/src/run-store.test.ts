/** Verify transactional run storage, replay, payload sharing, and expiry. */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogFull, openRunStore } from './run-store.ts';

test('admission and append are durable, bounded, and deduplicate payloads across expiry', () => {
	const dir = mkdtempSync(join(tmpdir(), 'run-store-'));
	const path = join(dir, 'runs.sqlite');
	const store = openRunStore({ path });
	try {
		const at = '2024-01-01T00:00:00.000Z';
		const first = store.admit({
			app: 'app',
			id: 'first',
			action: 'go',
			files: {},
			at,
		});
		expect(first.event?.seq).toBe(1);
		expect(
			store.admit({ app: 'app', id: 'first', action: 'go', files: {}, at })
				.existing?.lastSeq,
		).toBe(1);
		store.append(
			'app',
			'first',
			{ type: 'yielded', value: 'shared', at },
			{ limit: 4096 },
		);
		store.append(
			'app',
			'first',
			{ type: 'yielded', value: 'unique', at },
			{ limit: 4096 },
		);
		expect(() =>
			store.append(
				'app',
				'first',
				{ type: 'yielded', value: 'oversized', at },
				{ limit: 1 },
			),
		).toThrow(LogFull);
		expect(store.record('app', 'first')?.lastSeq).toBe(3);
		store.append(
			'app',
			'first',
			{ type: 'finished', answer: { returned: null }, at },
			{ limit: 4096 },
		);
		store.admit({ app: 'app', id: 'second', action: 'go', files: {}, at });
		store.append(
			'app',
			'second',
			{ type: 'yielded', value: 'shared', at },
			{ limit: 4096 },
		);
		store.append(
			'app',
			'second',
			{
				type: 'finished',
				answer: { returned: null },
				at: '2025-01-01T00:00:00.000Z',
			},
			{ limit: 4096 },
		);
		expect(store.expire(Date.parse('2024-06-01'))).toEqual([
			{ app: 'app', id: 'first' },
		]);
		expect(store.events('app', 'second', 0).map((event) => event.type)).toEqual(
			['accepted', 'yielded', 'finished'],
		);
		const db = new Database(path, { readonly: true });
		expect(
			db
				.query<{ count: number }, []>('SELECT count(*) AS count FROM payloads')
				.get()?.count,
		).toBe(2);
		db.close();
		for (const suffix of ['', '-wal', '-shm'])
			expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
