/**
 * Production replica-store opening and format-recognition tests.
 *
 * The conformance suite owns lane semantics and crash atomicity. These cases
 * protect the clean-break boundary around the dedicated SQLite file itself:
 * initialization occurs only in an empty database, and reopening recognizes
 * exactly the current tables and indexes owned by this store.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import {
	openReplicaStore,
	REPLICA_STORE_INDEXES,
	REPLICA_STORE_TABLES,
} from './index.js';

const LIMITS = makeLimits();
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const ATTACHMENT = {
	deploymentId: 'https://api.example.com/',
	principalId: 'principal-one',
} as const;

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
	test('projects visible state through sealed and pending lanes', () => {
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
			store.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { first: 1 },
			});
			store.seal();
			store.localWrite({
				address: ADDRESS,
				op: 'patch',
				set: { second: 2 },
				unset: [],
			});
			expect(store.visible(ADDRESS)).toEqual({
				state: 'live',
				payload: { first: 1, second: 2 },
			});
			expect(
				store.visibleRecords(ADDRESS.namespace, ADDRESS.collection),
			).toEqual({
				entries: [
					{
						address: ADDRESS,
						record: {
							state: 'live',
							payload: { first: 1, second: 2 },
						},
					},
				],
			});
		} finally {
			database.close();
		}
	});

	test('keeps an unprojectable parked desire observable without hiding accepted state', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			store.localWrite({ address: ADDRESS, op: 'replace', value: 'dark' });
			database.run(
				`UPDATE records SET
					confirmed_state = 'live', confirmed_payload = '"dark"',
					confirmed_sequence = 1, pending_op = NULL, pending_args = NULL,
					parked_op = 'patch', parked_args = '{"set":{"a":1},"unset":[]}',
					parked_code = 'patch-base-not-object'`,
			);
			expect(store.visible(ADDRESS)).toEqual({
				state: 'live',
				payload: 'dark',
			});
			expect(store.record(ADDRESS)?.parked?.code).toBe('patch-base-not-object');
			expect(store.workSummary()).toMatchObject({
				scalar: { pending: 0, sealed: 0, parked: 1 },
			});
			expect(store.parkedWork()).toMatchObject({
				entries: [
					{
						address: ADDRESS,
						scalar: { code: 'patch-base-not-object' },
						document: null,
						blob: null,
					},
				],
			});
		} finally {
			database.close();
		}
	});

	test('gates first attachment and preserves a permanent owner', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			expect(store.attachment()).toEqual({
				kind: 'unattached',
				requiresChoice: false,
			});
			expect(store.attach(ATTACHMENT)).toEqual({
				attached: true,
				discarded: false,
			});
			expect(store.attach(ATTACHMENT)).toEqual({
				attached: false,
				discarded: false,
			});
			expect(store.attachment()).toEqual({
				kind: 'attached',
				attachment: ATTACHMENT,
			});
			expect(() =>
				store.attach({ ...ATTACHMENT, principalId: 'principal-two' }),
			).toThrow(/permanently attached/);
		} finally {
			database.close();
		}
	});

	test('requires a whole-replica choice and commits discard with attachment', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			const changes: unknown[] = [];
			store.subscribe((addresses) => changes.push(addresses));
			store.localWrite({ address: ADDRESS, op: 'replace', value: {} });
			expect(store.attachment()).toEqual({
				kind: 'unattached',
				requiresChoice: true,
			});
			expect(() => store.attach(ATTACHMENT)).toThrow(/bring or discard/);
			expect(store.visible(ADDRESS)).not.toBeNull();
			expect(store.attach(ATTACHMENT, 'discard')).toEqual({
				attached: true,
				discarded: true,
			});
			expect(store.visible(ADDRESS)).toBeNull();
			expect(store.attachment()).toEqual({
				kind: 'attached',
				attachment: ATTACHMENT,
			});
			expect(changes).toEqual([[ADDRESS], [ADDRESS]]);
		} finally {
			database.close();
		}
	});

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
			).toThrow(/does not match format 3/);
			expect(userSchemaObjects(database)).toEqual(['table:legacy_workspace']);
		} finally {
			database.close();
		}
	});

	test('refuses an incomplete current schema', () => {
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
			).toThrow(/does not match format 3/);
		} finally {
			database.close();
		}
	});

	test('refuses current object names and format marker over malformed tables', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			database.exec(`
				CREATE TABLE meta (
					singleton INTEGER PRIMARY KEY,
					format_version INTEGER,
					replica_id TEXT
				) STRICT;
				INSERT INTO meta VALUES (1, 3, '${REPLICA_ID}');
				CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;
				CREATE TABLE record_documents (id INTEGER PRIMARY KEY) STRICT;
				CREATE TABLE document_inflight (id INTEGER PRIMARY KEY) STRICT;
				CREATE UNIQUE INDEX records_address ON records(id);
				CREATE INDEX records_pending ON records(id) WHERE id > 0;
				CREATE INDEX records_sealed ON records(id) WHERE id > 0;
				CREATE INDEX records_doc_dirty ON records(id) WHERE id > 0;
				CREATE INDEX records_blob_pending ON records(id) WHERE id > 0;
			`);
			expect(() =>
				openReplicaStore({
					database: createBunSqliteAdapter(database),
					limits: LIMITS,
				}),
			).toThrow(/does not match format 3/);
		} finally {
			database.close();
		}
	});

	test('rolls back every schema object when initial DDL fails', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const inner = createBunSqliteAdapter(database);
			const injected: SqliteDatabase = {
				run(sql, parameters) {
					if (sql.startsWith('CREATE INDEX records_sealed')) {
						throw new Error('injected schema failure');
					}
					inner.run(sql, parameters);
				},
				all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
					return inner.all<TRow>(sql, parameters);
				},
				readTransaction<TResult>(run: () => TResult): TResult {
					return inner.readTransaction(run);
				},
				transaction<TResult>(run: () => TResult): TResult {
					return inner.transaction(run);
				},
			};
			expect(() =>
				openReplicaStore({
					database: injected,
					limits: LIMITS,
					initialize: { replicaId: REPLICA_ID },
				}),
			).toThrow('injected schema failure');
			expect(userSchemaObjects(database)).toEqual([]);
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
