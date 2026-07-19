import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	initializeLocalWorkspaceStorage,
	readLocalRow,
} from './local-workspace-storage.js';

test('fresh local storage owns only scalar rows at the current version', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		expect(
			database
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master WHERE type = 'table'
					 AND name NOT LIKE 'sqlite_%' ORDER BY name`,
				)
				.all(),
		).toEqual([{ name: 'rows' }]);
		expect(database.query('PRAGMA user_version').get()).toEqual({
			user_version: 3,
		});
		// Reopening the same version is an ordinary no-op.
		initializeLocalWorkspaceStorage(sqlite);
		sqlite.run(
			`INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)`,
			['notes', 'note-1', '{"title":"kept row"}'],
		);
		expect(readLocalRow(sqlite, 'notes', 'note-1')).toEqual({
			title: 'kept row',
		});
	} finally {
		database.close();
	}
});

test('any other stored version fails loudly instead of migrating', () => {
	for (const version of [1, 2, 4]) {
		const database = new Database(':memory:');
		try {
			database.exec(`PRAGMA user_version = ${version}`);
			expect(() =>
				initializeLocalWorkspaceStorage(createBunSqliteAdapter(database)),
			).toThrow('Incompatible local workspace storage');
		} finally {
			database.close();
		}
	}
});
