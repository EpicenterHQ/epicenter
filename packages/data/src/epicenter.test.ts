/**
 * Typed Data API Tests
 *
 * Verifies inert definitions, grouped binding, typed scalar CRUD and paging,
 * committed observation, and local row-document persistence over Bun SQLite.
 *
 * Key behaviors:
 * - Invalid namespace and member names fail before storage work
 * - Conforming rows and values round-trip while invalid stored data is classified
 * - Local and synchronized commits notify borrowed lenses
 * - Row documents persist locally and are revoked by row deletion through any
 *   lens, including one that never opened the document
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openBunEpicenter } from './bun.js';
import { defineTable, defineValue, optional } from './definitions.js';
import { createEpicenter } from './epicenter.js';
import { openReplica } from './replica/index.js';

const TEST_NAMESPACE = 'so.epicenter.tests';
const NOTES_TABLE = 'notes';
const THEME_VALUE = 'theme';
const AUTHORITY_LIFETIME = 'cccccccccccccccccccccccc';
const REMOTE_ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const notesDefinition = defineTable({
	namespace: TEST_NAMESPACE,
	table: NOTES_TABLE,
	fields: {
		title: field.string(),
		rank: field.integer(),
		note: optional(field.string()),
		label: optional(field.json(Type.Union([Type.String(), Type.Null()]))),
	},
});

const themeDefinition = defineValue({
	namespace: TEST_NAMESPACE,
	value: THEME_VALUE,
	schema: field.string(),
});

function setup(log?: Logger) {
	const rawDatabase = new Database(':memory:');
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplica({ database }));
	const epicenter = createEpicenter({ replica, database, log });
	return { rawDatabase, database, replica, epicenter };
}

test('definitions reject invalid addresses and structural id fields', () => {
	expect(() =>
		defineTable({
			namespace: 'notes',
			table: 'notes',
			fields: { title: field.string() },
		}),
	).toThrow('Invalid namespace');
	expect(() =>
		defineValue({
			namespace: TEST_NAMESPACE,
			value: 'Not.Valid',
			schema: field.string(),
		}),
	).toThrow('Invalid value');
	expect(() =>
		defineTable({
			namespace: TEST_NAMESPACE,
			table: 'invalid-id',
			// @ts-expect-error The runtime guard is exercised despite the type error.
			fields: { id: field.string() },
		}),
	).toThrow("structural 'id'");
});

test('Bun factory opens the public runtime over an in-memory path', async () => {
	await using epicenter = await openBunEpicenter({ path: ':memory:' });
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const row = await notes.create({ title: 'factory', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
});

test('bind rejects duplicate scalar addresses', async () => {
	const { rawDatabase, epicenter } = setup();
	const duplicateNotes = defineTable({
		namespace: TEST_NAMESPACE,
		table: NOTES_TABLE,
		fields: { title: field.string() },
	});
	expect(() =>
		epicenter.bind({
			tables: { notes: notesDefinition, duplicate: duplicateNotes },
			values: {},
		}),
	).toThrow("'tables.notes' and 'tables.duplicate'");
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('table CRUD lowers undefined and list pages with a row-id tie-break', async () => {
	const { rawDatabase, epicenter } = setup();
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const localNotifications: string[][] = [];
	const unsubscribe = notes.subscribe((ids) => localNotifications.push(ids));
	const first = await notes.create({
		title: 'first',
		rank: 1,
		note: undefined,
	});
	const second = await notes.create({ title: 'second', rank: 1 });
	const third = await notes.create({ title: 'third', rank: 2, note: 'remove' });

	expect(first.id).toMatch(/^[a-z0-9]{24}$/);
	expect(expectOk(await notes.get(first.id))).toEqual({
		id: first.id,
		title: 'first',
		rank: 1,
	});
	expect(expectOk(await notes.update(third.id, { note: undefined }))).toEqual({
		id: third.id,
		title: 'third',
		rank: 2,
	});
	expect(
		expectOk(await notes.update('zzzzzzzzzzzzzzzzzzzzzzzz', { rank: 3 })),
	).toBeUndefined();

	const firstPage = await notes.list({
		where: { rank: 1 },
		orderBy: { field: 'rank', direction: 'asc' },
		limit: 1,
	});
	expect(firstPage.rows).toHaveLength(1);
	expect(firstPage.nextCursor).toBeDefined();
	const secondPage = await notes.list({
		where: { rank: 1 },
		orderBy: { field: 'rank', direction: 'asc' },
		cursor: firstPage.nextCursor,
		limit: 1,
	});
	expect(secondPage.rows).toHaveLength(1);
	expect(secondPage.nextCursor).toBeUndefined();
	expect([...firstPage.rows, ...secondPage.rows].map((row) => row.id)).toEqual(
		[first.id, second.id].sort(),
	);
	await expect(
		notes.list({
			where: { rank: 2 },
			orderBy: { field: 'rank', direction: 'asc' },
			cursor: firstPage.nextCursor,
			limit: 1,
		}),
	).rejects.toThrow('does not match this query');
	const nullLabel = await notes.create({
		title: 'null label',
		rank: 3,
		label: null,
	});
	const nullMatches = await notes.list({ where: { label: null } });
	expect(nullMatches.rows.map((row) => row.id)).toEqual([nullLabel.id]);

	expect(await notes.delete(first.id)).toBe(true);
	expect(await notes.delete(first.id)).toBe(false);
	expect(expectOk(await notes.get(first.id))).toBeUndefined();
	expect(localNotifications).toEqual([
		[first.id],
		[second.id],
		[third.id],
		[third.id],
		[nullLabel.id],
		[first.id],
	]);
	unsubscribe();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('stored schema-invalid rows and values are reported without repair', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	expectOk(
		replica.write({
			kind: 'create',
			namespace: TEST_NAMESPACE,
			table: NOTES_TABLE,
			rowId: REMOTE_ROW_A,
			fields: { title: 42, rank: 1 },
		}),
	);
	expectOk(
		replica.write({
			kind: 'set',
			namespace: TEST_NAMESPACE,
			value: THEME_VALUE,
			payload: 42,
		}),
	);
	const bound = epicenter.bind({
		tables: { notes: notesDefinition },
		values: { theme: themeDefinition },
	});

	const rowError = expectErr(await bound.tables.notes.get(REMOTE_ROW_A));
	expect(rowError.name).toBe('NonconformingRow');
	expect(rowError).toMatchObject({
		namespace: TEST_NAMESPACE,
		table: NOTES_TABLE,
		id: REMOTE_ROW_A,
		issues: [{ field: 'title', kind: 'invalid' }],
	});
	const page = await bound.tables.notes.list();
	expect(page.rows).toEqual([]);
	expect(page.nonconforming).toHaveLength(1);
	expect(expectErr(await bound.values.theme.get()).name).toBe(
		'NonconformingValue',
	);
	expect(
		expectOk(
			replica.readRow({
				namespace: TEST_NAMESPACE,
				table: NOTES_TABLE,
				rowId: REMOTE_ROW_A,
			}),
		),
	).toEqual({
		title: 42,
		rank: 1,
	});

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('value operations validate, unset to absence, and notify local commits', async () => {
	const { rawDatabase, epicenter } = setup();
	const theme = epicenter.bind({
		tables: {},
		values: { theme: themeDefinition },
	}).values.theme;
	let changes = 0;
	const unsubscribe = theme.subscribe(() => {
		changes += 1;
	});

	expect(expectOk(await theme.get())).toBeUndefined();
	await theme.set('dark');
	expect(expectOk(await theme.get())).toBe('dark');
	await expect(
		(theme.set as (value: unknown) => Promise<void>)(42),
	).rejects.toThrow("Invalid value for 'so.epicenter.tests/theme'");
	await theme.unset();
	expect(expectOk(await theme.get())).toBeUndefined();
	expect(changes).toBe(2);
	unsubscribe();
	await theme.set('light');
	expect(changes).toBe(2);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('throwing subscribers are logged without changing committed write results', async () => {
	const { sink, events } = memorySink();
	const { rawDatabase, epicenter } = setup(createLogger('test/data', sink));
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	let laterSubscriberCalls = 0;
	notes.subscribe(() => {
		throw new Error('subscriber failed');
	});
	notes.subscribe(() => {
		laterSubscriberCalls += 1;
	});

	const row = await notes.create({ title: 'committed', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
	expect(laterSubscriberCalls).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ level: 'error', source: 'test/data' });

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('subscriptions fire once per installed synchronized transaction', async () => {
	const { rawDatabase, epicenter } = setup();
	const bound = epicenter.bind({
		tables: { notes: notesDefinition },
		values: { theme: themeDefinition },
	});
	const rowNotifications: string[][] = [];
	let valueNotifications = 0;
	bound.tables.notes.subscribe((ids) => rowNotifications.push(ids));
	bound.values.theme.subscribe(() => {
		valueNotifications += 1;
	});

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange: () => ({
				lifetimeId: AUTHORITY_LIFETIME,
				through: 3,
				records: [
					{
						kind: 'row',
						namespace: TEST_NAMESPACE,
						table: NOTES_TABLE,
						rowId: REMOTE_ROW_A,
						changedSequence: 1,
						fields: { title: 'A', rank: 1 },
					},
					{
						kind: 'row',
						namespace: TEST_NAMESPACE,
						table: NOTES_TABLE,
						rowId: REMOTE_ROW_B,
						changedSequence: 2,
						fields: { title: 'B', rank: 2 },
					},
					{
						kind: 'value',
						namespace: TEST_NAMESPACE,
						value: THEME_VALUE,
						changedSequence: 3,
						payload: 'remote',
					},
				],
				more: false,
			}),
		}),
	);
	expect(rowNotifications).toEqual([[REMOTE_ROW_A, REMOTE_ROW_B]]);
	expect(valueNotifications).toBe(1);
	expect(expectOk(await bound.values.theme.get())).toBe('remote');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('row documents persist across opens and deletion revokes live handles', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const row = await notes.create({ title: 'document', rank: 1 });
	const first = await notes.openDocument(row.id);
	first.get('content').insert(0, 'persisted');
	await first.whenDurable();
	await first[Symbol.asyncDispose]();

	const reopened = await notes.openDocument(row.id);
	expect(reopened.get('content').toString()).toBe('persisted');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
			[TEST_NAMESPACE, NOTES_TABLE, row.id],
		)[0]?.count,
	).toBe(1);
	expect(await notes.delete(row.id)).toBe(true);
	expect(() => reopened.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
			[TEST_NAMESPACE, NOTES_TABLE, row.id],
		)[0]?.count,
	).toBe(0);
	await reopened[Symbol.asyncDispose]();
	await expect(notes.openDocument(row.id)).rejects.toThrow('absent row');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('deletion through an independently authored lens removes document bytes and revokes the other lens', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const authorA = defineTable({
		namespace: TEST_NAMESPACE,
		table: NOTES_TABLE,
		fields: { title: field.string(), rank: field.integer() },
	});
	const authorB = defineTable({
		namespace: TEST_NAMESPACE,
		table: NOTES_TABLE,
		fields: { title: field.string() },
	});
	const lensA = epicenter.bind({ tables: { notes: authorA }, values: {} })
		.tables.notes;
	const lensB = epicenter.bind({ tables: { notes: authorB }, values: {} })
		.tables.notes;

	const row = await lensA.create({ title: 'shared', rank: 1 });
	const document = await lensA.openDocument(row.id);
	document.get('content').insert(0, 'cross-lens');
	await document.whenDurable();

	expect(await lensB.delete(row.id)).toBe(true);
	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
			[TEST_NAMESPACE, NOTES_TABLE, row.id],
		)[0]?.count,
	).toBe(0);
	await expect(lensB.openDocument(row.id)).rejects.toThrow('absent row');
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('installed synchronized deletion removes document bytes and revokes handles', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const session = {
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
	};
	expectOk(
		await epicenter.attachSync({
			...session,
			exchange: () => ({
				lifetimeId: AUTHORITY_LIFETIME,
				through: 1,
				records: [
					{
						kind: 'row',
						namespace: TEST_NAMESPACE,
						table: NOTES_TABLE,
						rowId: REMOTE_ROW_A,
						changedSequence: 1,
						fields: { title: 'remote document', rank: 1 },
					},
				],
				more: false,
			}),
		}),
	);
	const document = await notes.openDocument(REMOTE_ROW_A);
	document.get('content').insert(0, 'remove me');
	expectOk(
		await epicenter.attachSync({
			...session,
			exchange: () => ({
				lifetimeId: AUTHORITY_LIFETIME,
				through: 2,
				records: [
					{
						kind: 'row-deleted',
						namespace: TEST_NAMESPACE,
						table: NOTES_TABLE,
						rowId: REMOTE_ROW_A,
						changedSequence: 2,
					},
				],
				more: false,
			}),
		}),
	);

	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
			[TEST_NAMESPACE, NOTES_TABLE, REMOTE_ROW_A],
		)[0]?.count,
	).toBe(0);
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('two borrowed lenses over one definition address the same stored state', async () => {
	const { rawDatabase, epicenter } = setup();
	const first = epicenter.bind({
		tables: { notes: notesDefinition },
		values: { theme: themeDefinition },
	});
	const second = epicenter.bind({
		tables: { sharedNotes: notesDefinition },
		values: { sharedTheme: themeDefinition },
	});
	const row = await first.tables.notes.create({ title: 'shared', rank: 1 });
	await first.values.theme.set('shared');

	expect(expectOk(await second.tables.sharedNotes.get(row.id))).toEqual(row);
	expect(expectOk(await second.values.sharedTheme.get())).toBe('shared');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});
