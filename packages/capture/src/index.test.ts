/**
 * Capture entry contract tests.
 * They verify minted rows, durable body text, timeline order, and a visible forest
 * when independent parent links form a cycle.
 */
import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { captureDefinition, createEntry, deleteConfirmedSubtree, entryForest, moveEntry, previewDeletion } from './index.js';

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

test('sequential moves preserve the subtree and materialize a suppressed edge', async () => {
	await using data = await openMemory(captureDefinition);
	const a = createEntry(data, { parentId: null, text: 'A' });
	const b = createEntry(data, { parentId: a.id, text: 'B' });
	const c = createEntry(data, { parentId: b.id, text: 'C' });
	const capturedAt = c.capturedAt;
	moveEntry(data, b.id, null);
	expect(entryForest(data.tables.entries.rows).parent.get(c.id)).toBe(b.id);
	moveEntry(data, a.id, c.id);
	expect(entryForest(data.tables.entries.rows).parent.get(a.id)).toBe(c.id);
	expect(() => moveEntry(data, b.id, a.id)).toThrow();
	expect(data.tables.entries.get(c.id)?.capturedAt).toBe(capturedAt);
	expect(data.tables.entries.body(c.id)?.toString()).toBe('C');

	// Opposing offline moves are represented by the merged raw links.
	data.tables.entries.update(b.id, { parentId: a.id });
	data.tables.entries.update(a.id, { parentId: b.id });
	const before = entryForest(data.tables.entries.rows);
	const root = a.id < b.id ? a.id : b.id;
	const child = root === a.id ? b.id : a.id;
	expect(before.suppressed.has(root)).toBe(true);
	moveEntry(data, child, null);
	expect(data.tables.entries.get(root)?.parentId).toBeNull();
	expect(entryForest(data.tables.entries.rows).parent.get(root)).toBeNull();
});

test('confirmed deletion refreshes changed content and membership, persists, and is idempotent', async () => {
	const record = createMemoryRecord();
	const data = await openMemory(captureDefinition, record);
	const root = createEntry(data, { parentId: null, text: 'root' });
	const child = createEntry(data, { parentId: root.id, text: 'child' });
	const stale = previewDeletion(data, root.id);
	const body = data.tables.entries.body(child.id)!;
	body.applyDelta(body.change.insert('edited ') as never);
	await expect(deleteConfirmedSubtree(data, stale)).rejects.toThrow('changed');
	const confirmed = previewDeletion(data, root.id);
	expect(confirmed.ids).toEqual([root.id, child.id]);
	const unseen = createEntry(data, { parentId: root.id, text: 'later child' });
	await expect(deleteConfirmedSubtree(data, confirmed)).rejects.toThrow('changed');
	const final = previewDeletion(data, root.id);
	await deleteConfirmedSubtree(data, final);
	await deleteConfirmedSubtree(data, final);
	expect(data.persistence.get()).toBe('saved');
	expect(data.tables.entries.get(root.id)).toBeUndefined();
	await data[Symbol.asyncDispose]();
	const reopened = await openMemory(captureDefinition, record);
	expect(reopened.tables.entries.get(root.id)).toBeUndefined();
	expect(reopened.tables.entries.get(unseen.id)).toBeUndefined();
	await reopened[Symbol.asyncDispose]();
	record.close();
});

test('overlapping deletion still removes confirmed children after another replica removed the root', async () => {
	await using data = await openMemory(captureDefinition);
	const root = createEntry(data, { parentId: null, text: 'root' });
	const child = createEntry(data, { parentId: root.id, text: 'child' });
	const confirmed = previewDeletion(data, root.id);
	data.tables.entries.delete(root.id);
	await deleteConfirmedSubtree(data, confirmed);
	expect(data.tables.entries.get(child.id)).toBeUndefined();
	expect(data.persistence.get()).toBe('saved');
});

test('deletion refuses unreadable rows that could hide subtree membership', async () => {
	await using data = await openMemory(captureDefinition);
	const root = createEntry(data, { parentId: null, text: 'root' });
	const broken = createEntry(data, { parentId: root.id, text: 'unreadable child' });
	data.tables.entries.update(broken.id, { capturedAt: 'invalid' } as never);
	expect(() => previewDeletion(data, root.id)).toThrow('Unreadable entries');
	data.tables.entries.update(broken.id, { parentId: null });
	expect(previewDeletion(data, root.id).ids).toEqual([root.id]);
	data.tables.entries.update(broken.id, { parentId: 42 } as never);
	expect(() => previewDeletion(data, root.id)).toThrow('Unreadable entries');
});
