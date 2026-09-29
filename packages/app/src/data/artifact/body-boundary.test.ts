/**
 * The row's sole child stays separate from value fields and file frontmatter.
 * Ordinary body, content, and !-prefixed fields survive serialization and import.
 * Metadata conformance cannot hide writing, and deletion removes both parts.
 */
import { expect, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';
import { createMemoryRecord, openMemory } from '../store/memory.js';
import { syncEngineOf } from '../store/store.js';
import { replaceBody } from './body-content.js';
import { readArtifact } from './import.js';
import { renderArtifact } from './render.js';

const definition = defineStore({
	id: 'so.epicenter.body-boundary',
	kv: { body: field.string(), '!setting': field.string() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				body: field.string(),
				content: field.string(),
				'!status': field.string(),
			},
			body: plainText(),
		}),
	},
});

test('ordinary body, content, and ! fields round-trip beside the editor body', async () => {
	await using data = await openMemory(definition);
	data.kv.update({ body: 'a setting', '!setting': 'kept' });
	const note = data.tables.notes.create({
		title: 'Trip',
		body: 'metadata body',
		content: 'an ordinary value',
		'!status': 'draft',
	});
	const body = data.tables.notes.body(note.id)!;
	body.insert(0, ['The writing.']);
	expect(data.tables.notes.get(note.id)).toEqual(note);
	expect(JSON.parse(JSON.stringify(note))).toEqual(note);
	expect(Object.keys(note).sort()).toEqual([
		'!status',
		'body',
		'content',
		'id',
		'title',
	]);
	expectOk(data.tables.notes.update(note.id, { body: 'updated metadata' }));
	expect(data.tables.notes.body(note.id)).toBe(body);
	expect(body.toString()).toBe('The writing.');

	const files = new Map<string, string>();
	for await (const result of renderArtifact(data, definition)) {
		const file = expectOk(result);
		if (file.contents !== undefined) files.set(file.path, file.contents);
	}
	expect(files.get(`notes/${note.id}.md`)).toContain('The writing.');
	await using restored = await openMemory(definition);
	expectOk(
		syncEngineOf(restored).applyRemote(
			expectOk(readArtifact(files, definition)),
		),
	);
	expect(restored.tables.notes.get(note.id)).toEqual({
		...note,
		body: 'updated metadata',
	});
	expect(restored.tables.notes.body(note.id)?.toString()).toBe('The writing.');
	expect(restored.kv.get('body')).toBe('a setting');
	expect(restored.kv.get('!setting')).toBe('kept');
});

test('body access is independent of metadata conformance and ends at deletion', async () => {
	await using data = await openMemory(definition);
	const note = data.tables.notes.create({
		title: 'Trip',
		body: 'metadata body',
		content: '',
		'!status': 'draft',
	});
	const body = data.tables.notes.body(note.id)!;
	body.insert(0, ['Keep the writing.']);
	expectOk(data.tables.notes.update(note.id, { title: 42 } as never));
	expect(data.tables.notes.get(note.id)).toBeUndefined();
	expect(data.tables.notes.body(note.id)).toBe(body);
	expect(body.toString()).toBe('Keep the writing.');
	data.tables.notes.delete(note.id);
	expect(data.tables.notes.body(note.id)).toBeUndefined();
	expect(data.tables.notes.ids()).toEqual([]);
	expect(data.tables.notes.body('absent')).toBeUndefined();
	expect(data.tables.notes.ids()).toEqual([]);
});

test('body metadata and child edits sync independently with separate notifications', async () => {
	await using left = await openMemory(definition);
	await using right = await openMemory(definition);
	const note = left.tables.notes.create({
		title: 'Trip',
		body: 'metadata',
		content: '',
		'!status': 'draft',
	});
	expectOk(syncEngineOf(right).applyRemote(left.encodeStateSince()));
	const leftBody = left.tables.notes.body(note.id)!;
	const rightBody = right.tables.notes.body(note.id)!;
	const tableEvents: string[][] = [];
	let bodyEvents = 0;
	const stopTable = left.tables.notes.subscribe((ids) =>
		tableEvents.push([...ids]),
	);
	const stopBody = left.tables.notes.watch(leftBody, () => {
		bodyEvents += 1;
	});

	expectOk(left.tables.notes.update(note.id, { body: 'changed metadata' }));
	expect(tableEvents).toEqual([[note.id]]);
	expect(bodyEvents).toBe(0);
	rightBody.insert(0, ['writing from the other replica']);
	expectOk(syncEngineOf(left).applyRemote(right.encodeStateSince()));
	expectOk(syncEngineOf(right).applyRemote(left.encodeStateSince()));
	expect(tableEvents).toEqual([[note.id]]);
	expect(bodyEvents).toBe(1);
	expect(left.tables.notes.body(note.id)).toBe(leftBody);
	expect(right.tables.notes.body(note.id)).toBe(rightBody);
	expect(leftBody.toString()).toBe(rightBody.toString());
	expect(right.tables.notes.get(note.id)?.body).toBe('changed metadata');
	stopTable();
	stopBody();
	left.tables.notes.delete(note.id);
	expectOk(syncEngineOf(right).applyRemote(left.encodeStateSince()));
	expect(right.tables.notes.body(note.id)).toBeUndefined();
	expect(right.tables.notes.get(note.id)).toBeUndefined();
});

test('a fresh body retains its attributes through sequence replacement, persistence, and deletion', async () => {
	const record = createMemoryRecord();
	try {
		const original = await openMemory(definition, record);
		const fresh = new Y.Node();
		fresh.setAttr('language', 'en');
		fresh.insert(0, ['Original']);
		const fields = {
			title: 'Trip',
			body: 'metadata',
			content: 'value',
			'!status': 'draft',
		};
		const row = original.tables.notes.create(fields, fresh);
		expect(original.tables.notes.body(row.id)).toBe(fresh);
		original.transact(() =>
			replaceBody(fresh, plainText().decode('Rewritten')),
		);
		expect(fresh.getAttr('language')).toBe('en');
		await original[Symbol.asyncDispose]();
		await using reopened = await openMemory(definition, record);
		const body = reopened.tables.notes.body(row.id)!;
		expect(body.getAttr('language')).toBe('en');
		expect(body.slice().join('')).toBe('Rewritten');
		expect(reopened.tables.notes.get(row.id)).toEqual({
			id: row.id,
			...fields,
		});
		expect(body.parent?.length).toBe(1);
		expect(body.parent?.get(0)).toBe(body);
		reopened.tables.notes.delete(row.id);
		body.insert(0, ['A retained reference cannot resurrect the row']);
		expect(reopened.tables.notes.get(row.id)).toBeUndefined();
		expect(reopened.tables.notes.body(row.id)).toBeUndefined();
	} finally {
		record.close();
	}
});

test('a mixed transaction publishes metadata and body signals once each', async () => {
	await using data = await openMemory(definition);
	const row = data.tables.notes.create({
		title: 'Trip',
		body: 'metadata',
		content: '',
		'!status': 'draft',
	});
	const body = data.tables.notes.body(row.id)!;
	let fields = 0;
	let writing = 0;
	data.tables.notes.subscribe(() => {
		fields++;
	});
	data.tables.notes.watch(body, () => {
		writing++;
	});
	data.transact(() => {
		expectOk(data.tables.notes.update(row.id, { body: 'Changed metadata' }));
		body.insert(0, ['Writing']);
	});
	expect(fields).toBe(1);
	expect(writing).toBe(1);
	expect(data.tables.notes.get(row.id)?.body).toBe('Changed metadata');
	expect(data.tables.notes.body(row.id)).toBe(body);
});
