/**
 * Saved query persistence uses the real Local Mail declaration and data store.
 * Invalid SQL remains ordinary text across a durable reopen and artifact
 * round-trip. Rows from an incompatible peer remain available for repair or
 * deletion under their original structural ids.
 */
import { expect, test } from 'bun:test';
import { defineApp, defineTable, field } from '@epicenter/app';
import { readArtifact, renderArtifact } from '@epicenter/app/artifact';
import { syncEngineOf } from '@epicenter/app/direct';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { expectOk } from 'wellcrafted/testing';
import { mailDefinition } from './data.js';

test('invalid SQL and duplicate names survive a durable close and reopen with their row ids', async () => {
	const record = createMemoryRecord();
	try {
		const initial = await openMemory(mailDefinition, record);
		const first = initial.tables.savedQueries.create({
			name: 'Receipts',
			sql: "this is not SQL;\nSELECT '購物 🧾';\n-- unfinished draft",
		});
		const second = initial.tables.savedQueries.create({
			name: 'Receipts',
			sql: '',
		});
		await initial.persistence.flush();
		expect(initial.persistence.get()).toBe('saved');
		await initial[Symbol.asyncDispose]();
		await using reopened = await openMemory(mailDefinition, record);
		expect(reopened.tables.savedQueries.get(first.id)?.sql).toBe(first.sql);
		expect(reopened.tables.savedQueries.get(second.id)?.sql).toBe('');
		expect(reopened.tables.savedQueries.rows).toHaveLength(2);
		expect(first.id).not.toBe(second.id);
	} finally {
		record.close();
	}
});

test('SQL remains a field through frontmatter export and import without a content codec', async () => {
	await using initial = await openMemory(mailDefinition);
	const query = initial.tables.savedQueries.create({
		name: 'Header-looking text',
		sql: "---\nSELECT '<script>alert(1)</script>' AS text;\n---\nnot valid SQL",
	});
	const files = new Map<string, string>();
	for await (const result of renderArtifact(initial, mailDefinition)) {
		const file = expectOk(result);
		if (file.contents !== undefined) files.set(file.path, file.contents);
	}
	expect(files.has(`savedQueries/${query.id}.md`)).toBe(true);
	await using imported = await openMemory(mailDefinition);
	expectOk(
		syncEngineOf(imported).applyRemote(
			expectOk(readArtifact(files, mailDefinition)),
		),
	);
	expect(imported.tables.savedQueries.get(query.id)?.sql).toBe(query.sql);
	expect(imported.tables.savedQueries.get(query.id)?.name).toBe(query.name);
});

test('incompatible saved queries can be repaired or deleted using their original ids', async () => {
	const incompatible = defineApp({
		id: mailDefinition.id,
		kv: {},
		tables: {
			savedQueries: defineTable({ name: field.string(), sql: field.boolean() }),
		},
	});
	await using peer = await openMemory(incompatible);
	const repair = peer.tables.savedQueries.create({
		name: 'Repair me',
		sql: false,
	});
	const remove = peer.tables.savedQueries.create({
		name: 'Delete me',
		sql: true,
	});
	await using local = await openMemory(mailDefinition);
	expectOk(syncEngineOf(local).applyRemote(peer.encodeStateSince()));
	expect(local.tables.savedQueries.rows).toHaveLength(0);
	expect(local.tables.savedQueries.nonconforming).toHaveLength(2);
	expectOk(
		local.tables.savedQueries.update(repair.id, {
			name: 'Repaired',
			sql: 'SELECT 1',
		}),
	);
	local.tables.savedQueries.delete(remove.id);
	expect(local.tables.savedQueries.get(repair.id)?.sql).toBe('SELECT 1');
	expect(local.tables.savedQueries.nonconforming).toHaveLength(0);
	expect(local.tables.savedQueries.ids()).toEqual([repair.id]);
});
