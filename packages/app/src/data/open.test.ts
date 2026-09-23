/** Data-only opening borrows SQLite, drains writes on disposal, and replays the same record. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { defineStore, defineTable, field } from '@epicenter/app';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { openData } from './open.js';

const definition = defineStore({
	id: 'test.data-open',
	kv: {},
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

test('disposing data leaves caller-owned SQLite open and preserves rows for reopening', async () => {
	using sqlite = new Database(':memory:');
	const adapter = createBunSqliteAdapter(sqlite);
	let id: string;
	{
		await using data = await openData(definition, adapter);
		id = data.tables.notes.create({ title: 'Kept' }).id;
	}
	expect(sqlite.query('SELECT 1 AS value').get()).toEqual({ value: 1 });
	await using reopened = await openData(definition, adapter);
	expect(reopened.tables.notes.get(id)?.title).toBe('Kept');
});
