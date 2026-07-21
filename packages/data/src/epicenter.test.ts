/**
 * Typed Data API Tests
 *
 * Verifies inert definitions, grouped binding, classified scalar traversal,
 * committed observation, and local row-document persistence over Bun SQLite.
 *
 * Key behaviors:
 * - Invalid and duplicate qualified keys fail before storage work
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
import { createEpicenter, createTableReadMethods } from './epicenter.js';
import { openReplica } from './replica/index.js';

const NOTES_KEY = 'so.epicenter.tests.notes';
const THEME_KEY = 'so.epicenter.tests.theme';
const REMOTE_ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const notesDefinition = defineTable({
	key: NOTES_KEY,
	fields: {
		title: field.string(),
		rank: field.integer(),
		note: optional(field.string()),
		label: optional(field.json(Type.Union([Type.String(), Type.Null()]))),
	},
});

const themeDefinition = defineValue({
	key: THEME_KEY,
	value: field.string(),
});

function setup(log?: Logger) {
	const rawDatabase = new Database(':memory:');
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplica({ database }));
	const epicenter = createEpicenter({ replica, database, log });
	return { rawDatabase, database, replica, epicenter };
}

test('definitions reject invalid qualified keys and structural id fields', () => {
	expect(() =>
		defineTable({ key: 'notes', fields: { title: field.string() } }),
	).toThrow("Invalid qualified key 'notes'");
	expect(() =>
		defineValue({ key: 'Not.Qualified.Value', value: field.string() }),
	).toThrow("Invalid qualified key 'Not.Qualified.Value'");
	expect(() =>
		defineTable({
			key: 'so.epicenter.tests.invalid-id',
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

test('bind rejects duplicate qualified keys across tables and values', async () => {
	const { rawDatabase, epicenter } = setup();
	const sameKeyValue = defineValue({
		key: NOTES_KEY,
		value: field.string(),
	});
	expect(() =>
		epicenter.bind({
			tables: { notes: notesDefinition },
			values: { duplicate: sameKeyValue },
		}),
	).toThrow("'tables.notes' and 'values.duplicate'");
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('table CRUD lowers undefined and scan returns stable row-ID order', async () => {
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

	const nullLabel = await notes.create({
		title: 'null label',
		rank: 3,
		label: null,
	});
	const scanned = await notes.scan();
	expect(scanned.nonconforming).toEqual([]);
	expect(scanned.rows.map(({ id }) => id)).toEqual(
		[first.id, second.id, third.id, nullLabel.id].sort(),
	);

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

test('stored nonconforming rows and values are reported without repair', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	expectOk(
		replica.write({
			kind: 'create',
			key: NOTES_KEY,
			rowId: REMOTE_ROW_A,
			fields: { title: 42, rank: 1 },
		}),
	);
	expectOk(replica.write({ kind: 'set', key: THEME_KEY, value: 42 }));
	const bound = epicenter.bind({
		tables: { notes: notesDefinition },
		values: { theme: themeDefinition },
	});

	const rowError = expectErr(await bound.tables.notes.get(REMOTE_ROW_A));
	expect(rowError.name).toBe('NonconformingRow');
	expect(rowError).toMatchObject({
		key: NOTES_KEY,
		id: REMOTE_ROW_A,
		issues: [{ field: 'title', kind: 'invalid' }],
	});
	const scanned = await bound.tables.notes.scan();
	expect(scanned.rows).toEqual([]);
	expect(scanned.nonconforming).toHaveLength(1);
	const entries = [];
	for await (const entry of bound.tables.notes.entries()) entries.push(entry);
	expect(entries).toHaveLength(1);
	const [entry] = entries;
	if (entry === undefined) throw new Error('Expected one table entry');
	expect(expectErr(entry)).toMatchObject({ id: REMOTE_ROW_A });
	expect(expectErr(await bound.values.theme.get()).name).toBe(
		'NonconformingValue',
	);
	expect(expectOk(replica.readRow(NOTES_KEY, REMOTE_ROW_A))).toEqual({
		title: 42,
		rank: 1,
	});

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('entries streams every classified row across internal batches', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const ids = Array.from({ length: 105 }, (_, index) =>
		String(index).padStart(24, '0'),
	);
	for (const [rank, id] of ids.entries()) {
		expectOk(
			replica.write({
				kind: 'create',
				key: NOTES_KEY,
				rowId: id,
				fields: { title: `Note ${rank}`, rank },
			}),
		);
	}

	const streamed = [];
	for await (const entry of notes.entries()) streamed.push(expectOk(entry));
	expect(streamed.map(({ id }) => id)).toEqual(ids);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('stopping entries early does not request another internal batch', async () => {
	let batchReads = 0;
	const methods = createTableReadMethods<typeof notesDefinition>(
		async (after) => {
			batchReads += 1;
			if (after !== undefined) throw new Error('Unexpected second batch');
			return {
				entries: [
					{
						data: { id: REMOTE_ROW_A, title: 'first', rank: 1 },
						error: null,
					},
				],
				nextAfter: REMOTE_ROW_A,
			};
		},
	);

	const iterator = methods.entries()[Symbol.asyncIterator]();
	expect((await iterator.next()).done).toBe(false);
	await iterator.return?.();
	expect(batchReads).toBe(1);
});

test('the current keyset batcher observes inserts ahead of its row-ID boundary, not behind it', async () => {
	// Adapter-mechanism coverage only: neither the batch size nor concurrent
	// insertion visibility is part of the public traversal contract.
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind({
		tables: { notes: notesDefinition },
		values: {},
	}).tables.notes;
	const initialIds = Array.from({ length: 101 }, (_, index) =>
		String(index + 100).padStart(24, '0'),
	);
	for (const [rank, id] of initialIds.entries()) {
		expectOk(
			replica.write({
				kind: 'create',
				key: NOTES_KEY,
				rowId: id,
				fields: { title: `Initial ${rank}`, rank },
			}),
		);
	}

	const iterator = notes.entries()[Symbol.asyncIterator]();
	const firstBatch = [];
	for (let index = 0; index < 100; index += 1) {
		const next = await iterator.next();
		if (next.done) throw new Error('Traversal ended before the batch boundary');
		firstBatch.push(expectOk(next.value));
	}

	const behindBoundary = '000000000000000000000050';
	const aheadOfBoundary = '000000000000000000000300';
	for (const [rowId, title] of [
		[behindBoundary, 'Behind'],
		[aheadOfBoundary, 'Ahead'],
	] as const) {
		expectOk(
			replica.write({
				kind: 'create',
				key: NOTES_KEY,
				rowId,
				fields: { title, rank: 300 },
			}),
		);
	}

	const remainder = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) break;
		remainder.push(expectOk(next.value));
	}
	const lastInitialId = initialIds.at(-1);
	if (lastInitialId === undefined) throw new Error('Expected initial rows');

	expect(firstBatch.map(({ id }) => id)).toEqual(initialIds.slice(0, 100));
	expect(remainder.map(({ id }) => id)).toEqual([
		lastInitialId,
		aheadOfBoundary,
	]);

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
	).rejects.toThrow("Invalid value for 'so.epicenter.tests.theme'");
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
				through: 3,
				records: [
					{
						kind: 'row',
						key: NOTES_KEY,
						rowId: REMOTE_ROW_A,
						changedSequence: 1,
						fields: { title: 'A', rank: 1 },
					},
					{
						kind: 'row',
						key: NOTES_KEY,
						rowId: REMOTE_ROW_B,
						changedSequence: 2,
						fields: { title: 'B', rank: 2 },
					},
					{
						kind: 'value',
						key: THEME_KEY,
						changedSequence: 3,
						value: 'remote',
					},
				],
				next: null,
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
			 WHERE qualified_key = ? AND row_id = ?`,
			[NOTES_KEY, row.id],
		)[0]?.count,
	).toBe(1);
	expect(await notes.delete(row.id)).toBe(true);
	expect(() => reopened.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE qualified_key = ? AND row_id = ?`,
			[NOTES_KEY, row.id],
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
		key: NOTES_KEY,
		fields: { title: field.string(), rank: field.integer() },
	});
	const authorB = defineTable({
		key: NOTES_KEY,
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
			 WHERE qualified_key = ? AND row_id = ?`,
			[NOTES_KEY, row.id],
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
				through: 1,
				records: [
					{
						kind: 'row',
						key: NOTES_KEY,
						rowId: REMOTE_ROW_A,
						changedSequence: 1,
						fields: { title: 'remote document', rank: 1 },
					},
				],
				next: null,
			}),
		}),
	);
	const document = await notes.openDocument(REMOTE_ROW_A);
	document.get('content').insert(0, 'remove me');
	expectOk(
		await epicenter.attachSync({
			...session,
			exchange: () => ({
				through: 2,
				records: [
					{
						kind: 'row-deleted',
						key: NOTES_KEY,
						rowId: REMOTE_ROW_A,
						changedSequence: 2,
					},
				],
				next: null,
			}),
		}),
	);

	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE qualified_key = ? AND row_id = ?`,
			[NOTES_KEY, REMOTE_ROW_A],
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
