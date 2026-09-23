/**
 * Fields-only declarations preserve every row's node at artifact boundaries.
 * Empty nodes round-trip; populated nodes and incoming bodies are refused.
 */
import { expect, test } from 'bun:test';
import { defineStore } from '@epicenter/app';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { compileData } from '../definition/compile.js';
import { defineTable, field } from '../definition/index.js';
import { openMemory } from '../store/memory.js';
import { syncEngineOf } from '../store/store.js';
import { readArtifact } from './import.js';
import { renderArtifact, renderRow } from './render.js';

const definition = defineStore({
	id: 'so.epicenter.saved-queries',
	kv: {},
	tables: {
		queries: defineTable({ name: field.string(), sql: field.string() }),
	},
});

test('a fields-only artifact round-trips fields and an empty node', async () => {
	await using data = await openMemory(definition);
	const row = data.tables.queries.create({ name: 'Inbox', sql: 'SELECT 1' });
	const files = new Map<string, string>();
	for await (const result of renderArtifact(data, definition)) {
		const file = expectOk(result);
		if (file.contents !== undefined) files.set(file.path, file.contents);
	}
	expect(files.get(`queries/${row.id}.md`)).toBe(
		'---\nname: "Inbox"\nsql: "SELECT 1"\n---\n',
	);
	await using restored = await openMemory(definition);
	expectOk(
		syncEngineOf(restored).applyRemote(
			expectOk(readArtifact(files, definition)),
		),
	);
	const reopened = restored.tables.queries.get(row.id)!;
	expect(reopened.name).toBe('Inbox');
	expect(reopened.sql).toBe('SELECT 1');
	expect(reopened.content.length).toBe(0);
	expect([...reopened.content.attrKeys()]).toEqual([]);
});

test('a codec-less populated sequence or attribute refuses export', async () => {
	await using data = await openMemory(definition);
	const sequence = data.tables.queries.create({ name: 'Sequence', sql: '' });
	sequence.content.insert(0, ['preserve me']);
	const attributes = data.tables.queries.create({
		name: 'Attributes',
		sql: '',
	});
	attributes.content.setAttr('note', 'preserve me');
	for (const row of [sequence, attributes]) {
		expect(
			expectErr(
				await renderRow(
					data,
					expectOk(compileData(definition)),
					'queries',
					row.id,
				),
			).name,
		).toBe('UncodedRow');
	}
});

test('a nonempty incoming body refuses import without a codec', () => {
	const files = new Map([
		[
			'queries/query1.md',
			'---\nname: "Inbox"\nsql: "SELECT 1"\n---\n\nuninterpreted body',
		],
	]);
	expect(expectErr(readArtifact(files, definition)).name).toBe('UncodedBody');
});
