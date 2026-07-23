/**
 * Cloudflare Epicenter Authority Tests
 *
 * Verifies the new Durable Object authority through its fetch boundary using a
 * fake SQLite-backed Durable Object storage implementation.
 *
 * Key behaviors:
 * - Scalar exchange executes through Durable Object fetch
 * - Accepted state and replica receipts survive actor restart
 */
import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';

import { batchDigest } from '@epicenter/data/protocol';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;

		constructor(ctx: DurableObjectState, _env: Cloudflare.Env) {
			this.ctx = ctx;
		}
	},
	WorkerEntrypoint: class {},
}));

type SqlValue = ArrayBuffer | string | number | null;

function setupStorage() {
	const database = new Database(':memory:', { strict: true });
	let alarm: number | null = null;
	const storage = {
		sql: {
			get databaseSize() {
				return 0;
			},
			exec<TRow extends Record<string, SqlValue>>(
				sql: string,
				...bindings: SqlValue[]
			) {
				const statements = sql.split(';').filter((part) => part.trim());
				if (statements.length > 1) {
					database.exec(sql);
					return { toArray: () => [] as TRow[] };
				}
				const values = bindings.map((value) =>
					value instanceof ArrayBuffer ? new Uint8Array(value) : value,
				);
				const query = database.query<
					TRow,
					(string | number | null | Uint8Array)[]
				>(sql);
				if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
					return { toArray: () => query.all(...values) };
				}
				query.run(...values);
				return { toArray: () => [] as TRow[] };
			},
		},
		transactionSync<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
		getAlarm: async () => alarm,
		setAlarm: async (value: number) => {
			alarm = value;
		},
		deleteAlarm: async () => {
			alarm = null;
		},
	} as unknown as DurableObjectStorage;
	return { database, storage };
}

function requestBody() {
	const changes = [
		{
			kind: 'create' as const,
			key: 'so.epicenter.tests.rows',
			rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			fields: { title: 'Persisted' },
		},
	];
	return {
		replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
		after: 0,
		batch: { seq: 1, digest: batchDigest(changes), changes },
	};
}

test('exchange state and receipt survive Durable Object restart', async () => {
	const { EpicenterAuthority } = await import('./cloudflare.js');
	const owned = setupStorage();
	const state = {
		storage: owned.storage,
		getWebSockets: () => [],
	} as unknown as DurableObjectState;
	try {
		let authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const accepted = await authority.fetch(
			new Request('https://epicenter-authority.internal/', {
				method: 'POST',
				body: JSON.stringify(requestBody()),
			}),
		);
		expect(accepted.status).toBe(200);
		expect((await accepted.json()) as unknown).toMatchObject({
			receipt: { seq: 1, appliedThrough: 1 },
			through: 1,
		});

		authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const retried = await authority.fetch(
			new Request('https://epicenter-authority.internal/', {
				method: 'POST',
				body: JSON.stringify(requestBody()),
			}),
		);
		expect((await retried.json()) as unknown).toMatchObject({
			receipt: { seq: 1, appliedThrough: 1 },
			through: 1,
			records: [
				{
					kind: 'row',
					fields: { title: 'Persisted' },
				},
			],
		});
	} finally {
		owned.database.close();
	}
});
