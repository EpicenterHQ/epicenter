/**
 * Capture entry contract tests.
 * They verify minted rows, durable body text, timeline order, and a visible forest
 * when independent parent links form a cycle.
 */
import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { captureDefinition, createEntry, entryForest } from './index.js';

test('entry text survives reopening and nested entries keep capture order', async () => {
	const record = createMemoryRecord();
	const first = await openMemory(captureDefinition, record);
	const older = createEntry(first, {
		parentId: null,
		text: 'older thought',
		capturedAt: InstantString.fromDate(new Date('2026-01-01T00:00:00.000Z')),
	});
	const newer = createEntry(first, {
		parentId: null,
		text: 'newer thought',
		capturedAt: InstantString.fromDate(new Date('2026-01-02T00:00:00.000Z')),
	});
	const child = createEntry(first, { parentId: older.id, text: 'child' });
	const editable = first.tables.entries.body(older.id);
	if (!editable) throw new Error('Created entry has no body.');
	editable.applyDelta(editable.change.retain(5).insert(' saved') as never);
	expect(older.id).not.toBe(newer.id);
	expect(
		entryForest(first.tables.entries.rows)
			.children.get(null)
			?.map(({ id }) => id),
	).toEqual([newer.id, older.id]);
	expect(
		entryForest(first.tables.entries.rows).children.get(older.id)?.[0]?.id,
	).toBe(child.id);
	await first.persistence.flush();
	await first[Symbol.asyncDispose]();
	const reopened = await openMemory(captureDefinition, record);
	expect(reopened.tables.entries.body(older.id)?.toString()).toBe(
		'older saved thought',
	);
	expect(reopened.tables.entries.body(child.id)?.toString()).toBe('child');
	await reopened[Symbol.asyncDispose]();
	record.close();
});

test('the visible hierarchy resolves missing parents and cycles', async () => {
	await using data = await openMemory(captureDefinition);
	const a = createEntry(data, { parentId: null, text: 'A' });
	const b = createEntry(data, { parentId: a.id, text: 'B' });
	data.tables.entries.update(a.id, { parentId: b.id });
	const forest = entryForest(data.tables.entries.rows);
	const root = a.id < b.id ? a.id : b.id;
	const child = a.id < b.id ? b.id : a.id;
	expect(forest.parent.get(root)).toBeNull();
	expect(forest.parent.get(child)).toBe(root);
	data.tables.entries.update(root, { parentId: 'missing' });
	expect(entryForest(data.tables.entries.rows).parent.get(root)).toBeNull();
});
