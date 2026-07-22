/**
 * Production replica-store opening and format-recognition tests.
 *
 * The conformance suite owns lane semantics and crash atomicity. These cases
 * protect the clean-break boundary around the dedicated SQLite file itself:
 * initialization occurs only in an empty database, and reopening recognizes
 * exactly the format-one tables and indexes owned by this store.
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
			).toThrow(/does not match format 1/);
			expect(userSchemaObjects(database)).toEqual(['table:legacy_workspace']);
		} finally {
			database.close();
		}
	});

	test('refuses an incomplete format-one schema', () => {
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
			).toThrow(/does not match format 1/);
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
});
