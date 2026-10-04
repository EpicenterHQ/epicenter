/**
 * Cloudflare Epicenter Authority Tests
 *
 * Verifies the new Durable Object authority through its fetch boundary using a
 * fake SQLite-backed Durable Object storage implementation.
 *
 * Key behaviors:
 * - Scalar exchange executes through Durable Object fetch
 * - Accepted state, replica receipts, and the authority lifetime survive
 *   actor restart
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

function requestBody(lifetimeId: string | null) {
	const changes = [
		{
			kind: 'create' as const,
			namespace: 'so.epicenter.tests',
			table: 'rows',
			rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			fields: { title: 'Persisted' },
		},
	];
	return {
		replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
		lifetimeId,
		after: 0,
		batch: { seq: 1, digest: batchDigest(changes), changes },
	};
}

test('exchange state, receipt, and lifetime survive Durable Object restart', async () => {
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
				body: JSON.stringify(requestBody(null)),
			}),
		);
		expect(accepted.status).toBe(200);
		const acceptedBody = (await accepted.json()) as {
			lifetimeId: string;
			receipt: { seq: number; digest: string };
			through: number;
		};
		expect(acceptedBody.lifetimeId).toMatch(/^[a-z0-9]{24}$/);
		expect(acceptedBody).toMatchObject({
			receipt: { seq: 1 },
			through: 1,
		});

		authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const retried = await authority.fetch(
			new Request('https://epicenter-authority.internal/', {
				method: 'POST',
				body: JSON.stringify(requestBody(acceptedBody.lifetimeId)),
			}),
		);
		expect((await retried.json()) as unknown).toMatchObject({
			lifetimeId: acceptedBody.lifetimeId,
			receipt: { seq: 1 },
			through: 1,
			more: false,
			records: [
				{
					kind: 'row',
					namespace: 'so.epicenter.tests',
					table: 'rows',
					fields: { title: 'Persisted' },
				},
			],
		});

		// A superseded lifetime is refused after restart too.
		authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const mismatched = await authority.fetch(
			new Request('https://epicenter-authority.internal/', {
				method: 'POST',
				body: JSON.stringify(requestBody('oooooooooooooooooooooooo')),
			}),
		);
		expect((await mismatched.json()) as unknown).toEqual({
			refusal: 'lifetime-mismatch',
			lifetimeId: acceptedBody.lifetimeId,
		});
	} finally {
		owned.database.close();
	}
});
