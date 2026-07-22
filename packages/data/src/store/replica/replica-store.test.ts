/**
 * Production replica-store opening and format-recognition tests.
 *
 * The conformance suite owns lane semantics and crash atomicity. These cases
 * protect the clean-break boundary around the dedicated SQLite file itself:
 * initialization occurs only in an empty database, and reopening recognizes
 * exactly the format-two tables and indexes owned by this store.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import {
	openReplicaStore,
	REPLICA_STORE_INDEXES,
	REPLICA_STORE_TABLES,
} from './index.js';

const LIMITS = makeLimits();
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

function userSchemaObjects(database: Database): string[] {
	return database
		.query<{ name: string; type: string }, []>(
			`SELECT type, name FROM sqlite_schema
			WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		)
		.all()
		.map(({ type, name }) => `${type}:${name}`);
}

describe('production replica store format', () => {
	test('initializes an empty database and reopens only the exact owned schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const adapter = createBunSqliteAdapter(database);
			const created = openReplicaStore({
				database: adapter,
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			expect(created.sync().replicaId).toBe(REPLICA_ID);
			expect(userSchemaObjects(database)).toEqual(
				[
					...REPLICA_STORE_INDEXES.map((name) => `index:${name}`),
					...REPLICA_STORE_TABLES.map((name) => `table:${name}`),
				].sort(),
			);
			expect(
				openReplicaStore({ database: adapter, limits: LIMITS }).sync(),
			).toEqual(created.sync());
		} finally {
			database.close();
		}
	});

	test('refuses to initialize beside an unrelated schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			database.exec(
				'CREATE TABLE legacy_workspace (id INTEGER PRIMARY KEY) STRICT',
			);
			expect(() =>
				openReplicaStore({
					database: createBunSqliteAdapter(database),
					limits: LIMITS,
					initialize: { replicaId: REPLICA_ID },
				}),
			).toThrow(/does not match format 2/);
			expect(userSchemaObjects(database)).toEqual(['table:legacy_workspace']);
		} finally {
			database.close();
		}
	});

	test('refuses an incomplete format-two schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const adapter = createBunSqliteAdapter(database);
			openReplicaStore({
				database: adapter,
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			database.exec('DROP INDEX records_pending');
			expect(() =>
				openReplicaStore({ database: adapter, limits: LIMITS }),
			).toThrow(/does not match format 2/);
		} finally {
			database.close();
		}
	});

	test('rejects invalid initial synchronization metadata without creating tables', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			expect(() =>
				openReplicaStore({
					database: createBunSqliteAdapter(database),
					limits: LIMITS,
					initialize: {
						replicaId: REPLICA_ID,
						authorityLifetime: 'x'.repeat(LIMITS.maxLifetimeBytes + 1),
					},
				}),
			).toThrow(/replica initialization failed/);
			expect(userSchemaObjects(database)).toEqual([]);
		} finally {
			database.close();
		}
	});

	test('enforces the bounded document-chain and retry-image row shapes', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			const address = {
				namespace: 'so.epicenter.notes',
				collection: 'recordings',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			};
			store.localWrite({ address, op: 'replace', value: {} });
			const recordId = database
				.query<{ record_id: number }, []>('SELECT record_id FROM records')
				.get()?.record_id;
			if (recordId === undefined) throw new Error('record was not created');

			expect(() =>
				database.run(
					`INSERT INTO record_documents (record_id, seq, kind, bytes)
					VALUES (?, 2, 'baseline', X'01')`,
					[recordId],
				),
			).toThrow(/constraint failed/);
			expect(() =>
				database.run(
					`INSERT INTO document_inflight (
						record_id, payload, digest, captured_revision
					) VALUES (?, NULL, ?, 0)`,
					[recordId, 'a'.repeat(64)],
				),
			).toThrow(/constraint failed/);
		} finally {
			database.close();
		}
	});

	test('retains one internal exhaustion sentinel but never seals it onto the wire', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			database.exec(
				'UPDATE meta SET next_submission = 9007199254740992 WHERE singleton = 1',
			);
			store.localWrite({
				address: {
					namespace: 'so.epicenter.notes',
					collection: 'recordings',
					recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				},
				op: 'replace',
				value: 'pending',
			});
			expect(() => store.seal()).toThrow(/number space is exhausted/);
			expect(() =>
				database.exec(
					'UPDATE meta SET next_submission = 9007199254740993 WHERE singleton = 1',
				),
			).toThrow(/constraint failed/);
		} finally {
			database.close();
		}
	});

	test('shrinks the sealed prefix until its canonical request fits the byte ceiling', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: makeLimits({ maxSubmissionBytes: 700 }),
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			const firstAddress = {
				namespace: 'so.epicenter.notes',
				collection: 'recordings',
				recordKey: 'a'.repeat(24),
			};
			const secondAddress = {
				...firstAddress,
				recordKey: 'b'.repeat(24),
			};
			const addresses = [firstAddress, secondAddress] as const;
			for (const address of addresses) {
				store.localWrite({
					address,
					op: 'replace',
					value: 'x'.repeat(300),
				});
			}
			const sealed = JSON.parse(store.seal().bytes) as {
				intents: { address: (typeof addresses)[number] }[];
			};
			expect(sealed.intents.map((intent) => intent.address)).toEqual([
				firstAddress,
			]);
			expect(store.record(firstAddress)?.sealed).not.toBeNull();
			expect(store.record(secondAddress)?.pending).not.toBeNull();
		} finally {
			database.close();
		}
	});
});
