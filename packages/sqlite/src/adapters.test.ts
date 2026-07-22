/**
 * Embedded SQLite Adapter Conformance Tests
 *
 * Verifies that every runtime adapter exposes the same query and transaction
 * semantics without depending on an authority or workspace schema.
 *
 * Key behaviors:
 * - bound writes and object-row reads agree across adapters
 * - transaction exceptions roll back every write
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from './browser.js';
import { createBunSqliteAdapter } from './bun.js';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from './durable-object.js';
import type { SqliteDatabase, SqliteValue } from './index.js';

type OpenDatabase = () => {
	database: SqliteDatabase;
	close(): void;
};

function execute(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): void {
	database.run(sql, [...parameters]);
}

function query<TRow>(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): TRow[] {
	return database.query<TRow, SqliteValue[]>(sql).all(...parameters);
}

const adapters: [name: string, open: OpenDatabase][] = [
	[
		'Bun SQLite',
		() => {
			const sqlite = new Database(':memory:');
			return {
				database: createBunSqliteAdapter(sqlite),
				close: () => sqlite.close(),
			};
		},
	],
	[
		'browser SQLite OO1',
		() => {
			const sqlite = new Database(':memory:');
			const browser = {
				exec(options) {
					if (options.resultRows) {
						options.resultRows.push(
							...query(sqlite, options.sql, options.bind ?? []),
						);
						return;
					}
					execute(sqlite, options.sql, options.bind ?? []);
				},
				transaction(qualifier, run) {
					const transaction = sqlite.transaction(run);
					return qualifier === 'DEFERRED'
						? transaction.deferred()
						: transaction.immediate();
				},
			} satisfies BrowserSqliteDatabase;
			return {
				database: createBrowserSqliteAdapter(browser),
				close: () => sqlite.close(),
			};
		},
	],
	[
		'Durable Object SQLite',
		() => {
			const sqlite = new Database(':memory:');
			const storage = {
				sql: {
					exec<TRow>(sql: string, ...bindings: SqliteValue[]) {
						let rows: TRow[] = [];
						if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
							rows = query<TRow>(sqlite, sql, bindings);
						} else {
							execute(sqlite, sql, bindings);
						}
						return { toArray: () => rows };
					},
				},
				transactionSync(run) {
					return sqlite.transaction(run).immediate();
				},
			} satisfies DurableObjectSqliteStorage;
			return {
				database: createDurableObjectSqliteAdapter(storage),
				close: () => sqlite.close(),
			};
		},
	],
];

test('browser SQLite uses deferred reads and immediate writes', () => {
	const qualifiers: string[] = [];
	const database = createBrowserSqliteAdapter({
		exec() {},
		transaction(qualifier, run) {
			qualifiers.push(qualifier);
			return run();
		},
	});
	database.readTransaction(() => undefined);
	database.transaction(() => undefined);
	expect(qualifiers).toEqual(['DEFERRED', 'IMMEDIATE']);
});

for (const [name, open] of adapters) {
	test(`${name}: writes, reads, and rollback share one contract`, () => {
		const { database, close } = open();
		try {
			database.run('CREATE TABLE values_table(value TEXT NOT NULL)');
			database.run('INSERT INTO values_table VALUES (?)', ['kept']);
			expect(() =>
				database.transaction(() => {
					database.run('INSERT INTO values_table VALUES (?)', ['rolled-back']);
					throw new Error('rollback');
				}),
			).toThrow('rollback');
			expect(
				database.all<{ value: string }>(
					'SELECT value FROM values_table ORDER BY rowid',
				),
			).toEqual([{ value: 'kept' }]);
		} finally {
			close();
		}
	});

	test(`${name}: nested transaction failure rolls back the outer transaction`, () => {
		const { database, close } = open();
		try {
			database.run('CREATE TABLE nested_values(value TEXT NOT NULL)');
			expect(() =>
				database.transaction(() => {
					database.run("INSERT INTO nested_values VALUES ('outer')");
					database.transaction(() => {
						database.run("INSERT INTO nested_values VALUES ('inner')");
					});
					throw new Error('outer rollback');
				}),
			).toThrow('outer rollback');
			expect(database.all('SELECT * FROM nested_values')).toEqual([]);
		} finally {
			close();
		}
	});
}
