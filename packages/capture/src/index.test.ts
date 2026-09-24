/**
 * Capture store contract tests.
 * Verifies dated captures, independent thought bodies and order, recovery, exact deletion,
 * and read access to earlier entries after the two-table cutover.
 */
import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import {
	captureDefinition,
	captureView,
	createCapture,
	createPromotedCapture,
	createThought,
	deleteConfirmedCapture,
	deleteConfirmedThought,
	moveThought,
	previewCaptureDeletion,
	reorderThought,
} from './index.js';

test('promotion replay returns the same capture after reopening', async () => {
	const record = createMemoryRecord();
	const capturedAt = InstantString.fromDate(new Date('2026-01-01T00:00:00Z'));
	const first = await openMemory(captureDefinition, record);
	const request = {
		requestId: 'request-1',
		text: 'Selected cleaned text',
		capturedAt,
	};
	const id = createPromotedCapture(first, request);
	expect(createPromotedCapture(first, request)).toBe(id);
	await first[Symbol.asyncDispose]();
	await using reopened = await openMemory(captureDefinition, record);
	expect(createPromotedCapture(reopened, request)).toBe(id);
	expect(reopened.tables.captures.rows).toHaveLength(1);
	expect(reopened.tables.captures.body(id)?.toString()).toBe(
		'Selected cleaned text',
	);
});

test('an accepted promotion key without an ID never creates another root', async () => {
	await using data = await openMemory(captureDefinition);
	data.tables.promotions.create({ requestId: 'uncertain', captureId: null });
	expect(() =>
		createPromotedCapture(data, {
			requestId: 'uncertain',
			text: 'Do not duplicate',
			capturedAt: InstantString.now(),
		}),
	).toThrow('Inspect Capture');
	expect(data.tables.captures.rows).toHaveLength(0);
});

test('dated captures, multiline bodies, thoughts, and order survive reopening', async () => {
	const record = createMemoryRecord();
	const data = await openMemory(captureDefinition, record);
	const older = createCapture(
		data,
		'Dinner\nBring the invitation',
		InstantString.fromDate(new Date('2026-01-01T00:00:00Z')),
	);
	const newer = createCapture(
		data,
		'Idea',
		InstantString.fromDate(new Date('2026-01-02T00:00:00Z')),
	);
	const a = createThought(data, older.id, 'first paragraph\nsecond line');
	const b = createThought(data, older.id, 'another');
	const originalBody = data.tables.thoughts.body(a.id);
	reorderThought(data, b.id, -1);
	expect(captureView(data).captures.map((row) => row.id)).toEqual([
		newer.id,
		older.id,
	]);
	expect(
		captureView(data)
			.thoughts.get(older.id)
			?.map((row) => row.id),
	).toEqual([b.id, a.id]);
	expect(data.tables.thoughts.body(a.id)).toBe(originalBody);
	await data.persistence.flush();
	await data[Symbol.asyncDispose]();
	const reopened = await openMemory(captureDefinition, record);
	expect(reopened.tables.captures.body(older.id)?.toString()).toBe(
		'Dinner\nBring the invitation',
	);
	expect(reopened.tables.thoughts.body(a.id)?.toString()).toBe(
		'first paragraph\nsecond line',
	);
	expect(
		captureView(reopened)
			.thoughts.get(older.id)
			?.map((row) => row.id),
	).toEqual([b.id, a.id]);
	await reopened[Symbol.asyncDispose]();
	record.close();
});

test('move preserves thought identity and missing parents place survivors in recovery', async () => {
	await using data = await openMemory(captureDefinition);
	const a = createCapture(data, 'A');
	const b = createCapture(data, 'B');
	const thought = createThought(data, a.id, 'keep me');
	const body = data.tables.thoughts.body(thought.id);
	moveThought(data, thought.id, b.id);
	expect(data.tables.thoughts.body(thought.id)).toBe(body);
	expect(captureView(data).thoughts.get(b.id)?.[0]?.id).toBe(thought.id);
	data.tables.captures.delete(b.id);
	expect(captureView(data).recovery.map((row) => row.id)).toEqual([thought.id]);
	expect(data.tables.thoughts.get(thought.id)?.captureId).toBe(b.id);
	moveThought(data, thought.id, a.id);
	expect(captureView(data).recovery).toEqual([]);
});

test('deletion refreshes membership and text, deletes only confirmed IDs, then persists', async () => {
	const record = createMemoryRecord();
	const data = await openMemory(captureDefinition, record);
	const capture = createCapture(data, 'root');
	const thought = createThought(data, capture.id, 'one');
	const stale = previewCaptureDeletion(data, capture.id);
	const body = data.tables.thoughts.body(thought.id);
	if (!body) throw new Error('Created thought has no body.');
	body.applyDelta(body.change.insert('changed ') as never);
	await expect(deleteConfirmedCapture(data, stale)).rejects.toThrow('changed');
	const reviewed = previewCaptureDeletion(data, capture.id);
	const unseen = createThought(data, capture.id, 'unseen');
	await expect(deleteConfirmedCapture(data, reviewed)).rejects.toThrow(
		'changed',
	);
	const final = previewCaptureDeletion(data, capture.id);
	// An offline replica's row arrives after this local deletion transaction.
	await deleteConfirmedCapture(data, final);
	data.tables.thoughts.create({ captureId: capture.id, position: 99 });
	expect(captureView(data).recovery).toHaveLength(1);
	expect(data.tables.thoughts.get(unseen.id)).toBeUndefined();
	await data.persistence.flush();
	expect(data.persistence.get()).toBe('saved');
	await data[Symbol.asyncDispose]();
	record.close();
});

test('a surviving confirmed thought is rechecked when its capture disappeared', async () => {
	await using data = await openMemory(captureDefinition);
	const capture = createCapture(data, 'root');
	const thought = createThought(data, capture.id, 'original');
	const preview = previewCaptureDeletion(data, capture.id);
	data.tables.captures.delete(capture.id);
	const body = data.tables.thoughts.body(thought.id);
	if (!body) throw new Error('Created thought has no body.');
	body.applyDelta(body.change.insert('edited ') as never);
	await expect(deleteConfirmedCapture(data, preview)).rejects.toThrow(
		'changed',
	);
	expect(data.tables.thoughts.get(thought.id)).toBeDefined();
});

test('deleting one thought leaves its capture and siblings saved', async () => {
	const record = createMemoryRecord();
	const data = await openMemory(captureDefinition, record);
	const capture = createCapture(data, 'root');
	const removed = createThought(data, capture.id, 'remove');
	const kept = createThought(data, capture.id, 'keep');
	await deleteConfirmedThought(data, removed.id, 'remove');
	expect(data.persistence.get()).toBe('saved');
	await data[Symbol.asyncDispose]();
	const reopened = await openMemory(captureDefinition, record);
	expect(reopened.tables.captures.get(capture.id)).toBeDefined();
	expect(reopened.tables.thoughts.get(removed.id)).toBeUndefined();
	expect(reopened.tables.thoughts.body(kept.id)?.toString()).toBe('keep');
	await reopened[Symbol.asyncDispose]();
	record.close();
});

test('unreadable thought membership blocks a complete deletion preview', async () => {
	await using data = await openMemory(captureDefinition);
	const capture = createCapture(data, 'root');
	const thought = createThought(data, capture.id, 'text');
	data.tables.thoughts.update(thought.id, { position: 'broken' } as never);
	expect(() => previewCaptureDeletion(data, capture.id)).toThrow(
		'Unreadable thoughts',
	);
});

test('earlier entries remain readable after the two-table cutover', async () => {
	await using data = await openMemory(captureDefinition);
	const root = data.tables.entries.create({
		parentId: null,
		capturedAt: InstantString.now(),
	});
	const child = data.tables.entries.create({
		parentId: root.id,
		capturedAt: InstantString.now(),
	});
	expect(new Set(data.tables.entries.rows.map((row) => row.id))).toEqual(
		new Set([root.id, child.id]),
	);
	expect(captureView(data).captures).toEqual([]);
	expect(data.tables.entries.get(child.id)?.parentId).toBe(root.id);
});
