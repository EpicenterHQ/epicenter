/**
 * SQLite Workspace Client Tests
 *
 * Verifies fresh-id allocation, serialized mutation batches, response
 * validation, commit deltas, and child-document identity at the async port.
 *
 * Key behaviors:
 * - create allocates UUID identities and returns committed rows
 * - transaction builders allocate ids synchronously and send one batch
 * - malformed service rows and results are rejected
 */

import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { sha256Hex } from '../shared/sha256.js';
import { createWorkspaceClient, type WorkspaceServicePort } from './client.js';
import { defineTable } from './definition.js';
import { document, inspectDocumentFormat } from './document-format.js';
import { field } from './field.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

test('async client sends one write-only transaction and filters table deltas', async () => {
	const requests: unknown[] = [];
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			requests.push(request);
			if (request.kind === 'mutate') {
				return {
					kind: 'mutation',
					results: request.mutations.map((mutation) =>
						mutation.kind === 'create' ? mutation.row : null,
					),
				};
			}
			return { kind: 'row', row: null };
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
	};
	const notes = defineTable({
		fields: { id: field.string(), title: field.string() },
	});
	const definition = defineWorkspace({
		appId: 'client-test',
		name: 'Client test',
		tables: { notes },
	});
	const client = createWorkspaceClient(definition, port);
	const deltas: unknown[] = [];
	client.tables.notes.observe((delta) => deltas.push(delta));

	let createdId = '';
	await client.transact((batch) => {
		createdId = batch.tables.notes.create({ title: 'One' });
		batch.tables.notes.patch(createdId, { title: 'Updated' });
	});
	expect(createdId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(requests).toEqual([
		{
			kind: 'mutate',
			mutations: [
				{
					kind: 'create',
					table: 'notes',
					row: { id: createdId, title: 'One' },
				},
				{
					kind: 'patch',
					table: 'notes',
					rowId: createdId,
					cells: { title: 'Updated' },
				},
			],
		},
	]);

	for (const observer of observers) {
		observer({
			tables: {
				notes: { upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
			},
		});
	}
	expect(deltas).toEqual([
		{ upserted: [{ id: 'one', title: 'Updated' }], removed: [] },
	]);
});

test('create returns committed rows with distinct UUID identities', async () => {
	const port: WorkspaceServicePort = {
		async request(request) {
			if (request.kind !== 'mutate') throw new Error('unexpected read');
			return {
				kind: 'mutation',
				results: request.mutations.map((mutation) =>
					mutation.kind === 'create' ? mutation.row : null,
				),
			};
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		appId: 'client-create-test',
		name: 'Client create test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const client = createWorkspaceClient(definition, port);

	const first = await client.tables.notes.create({ title: 'Draft' });
	const second = await client.tables.notes.create({ title: 'Draft' });

	expect(first).toEqual({ id: first.id, title: 'Draft' });
	expect(second).toEqual({ id: second.id, title: 'Draft' });
	expect(first.id).not.toBe(second.id);
	expect(first.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
});

test('empty and async transaction builders never send a partial mutation', async () => {
	const requests: unknown[] = [];
	const port: WorkspaceServicePort = {
		async request(request) {
			requests.push(request);
			return { kind: 'mutation', results: [] };
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		appId: 'client-builder-test',
		name: 'Client builder test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await client.transact(() => undefined);
	await expect(
		client.transact(async (batch) => {
			batch.tables.notes.create({ title: 'Not sent' });
		}),
	).rejects.toThrow('must be synchronous');

	expect(requests).toEqual([]);
});

test('typed client rejects malformed rows, deltas, and mutation results', async () => {
	const observers = new Set<Parameters<WorkspaceServicePort['observe']>[0]>();
	const port: WorkspaceServicePort = {
		async request(request) {
			switch (request.kind) {
				case 'get':
					return { kind: 'row', row: { id: request.rowId, title: 42 } };
				case 'mutate':
					return { kind: 'mutation', results: [] };
				default:
					return { kind: 'count', value: 0 };
			}
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
	};
	const definition = defineWorkspace({
		appId: 'client-validation-test',
		name: 'Client validation test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await expect(client.tables.notes.get('one')).rejects.toThrow(
		"invalid 'notes' row",
	);
	await expect(client.tables.notes.create({ title: 'One' })).rejects.toThrow(
		'wrong mutation result count',
	);

	client.tables.notes.observe(() => undefined);
	const [tableObserver] = observers;
	expect(() =>
		tableObserver?.({
			tables: {
				notes: { upserted: [{ id: 'one', title: 42 }], removed: [] },
			},
		}),
	).toThrow("invalid 'notes' row");
});

test('sql validates every result row against the caller schema', async () => {
	const port: WorkspaceServicePort = {
		async request(request) {
			if (request.kind !== 'sql') throw new Error('unexpected request');
			return { kind: 'sql', rows: [{ title: 'Valid' }, { title: 42 }] };
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		appId: 'client-sql-validation-test',
		name: 'Client SQL validation test',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
		},
	});
	const client = createWorkspaceClient(definition, port);

	await expect(
		client.sql(
			'SELECT title FROM notes',
			[],
			Type.Object({ title: Type.String() }),
		),
	).rejects.toThrow('invalid row at index 1');
});

test('declared documents have format-addressed identity without becoming row cells', async () => {
	const port: WorkspaceServicePort = {
		async request(request) {
			if (request.kind === 'get') {
				return {
					kind: 'row',
					row: { id: request.rowId },
				};
			}
			throw new Error('document guid derivation must not use the service');
		},
		observe() {
			return () => undefined;
		},
	};
	const definition = defineWorkspace({
		appId: 'client-docs-test',
		name: 'Client docs test',
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					body: field.doc(document.xmlFragment),
					summary: field.doc(document.plainText),
				},
			}),
		},
	});
	const client = createWorkspaceClient(definition, port);
	const row = await client.tables.notes.get('row-1');

	const bodyGuid: string = client.tables.notes.docs.body.guid('row-1');
	const summaryGuid: string = client.tables.notes.docs.summary.guid('row-1');
	const rowDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify('row-1')}`,
	);
	expect(bodyGuid).toBe(
		`${definition.workspaceId}.notes.${rowDigest}.body.${inspectDocumentFormat(document.xmlFragment).formatHash.slice('sha256:'.length)}`,
	);
	expect(row?.id).toBe('row-1');
	expect(summaryGuid).toBe(
		`${definition.workspaceId}.notes.${rowDigest}.summary.${inspectDocumentFormat(document.plainText).formatHash.slice('sha256:'.length)}`,
	);
	expect(bodyGuid).not.toBe(summaryGuid);
	// Record ids are values, not address grammar, so imported ids remain valid.
	expect(client.tables.notes.docs.body.guid('bad.row')).toContain(
		sha256Hex(`epicenter.document-row/1\0${JSON.stringify('bad.row')}`),
	);
});
