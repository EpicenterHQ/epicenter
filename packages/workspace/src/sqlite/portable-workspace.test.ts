import { expect, test } from 'bun:test';
import { defineTable } from './definition.js';
import { document } from './document-format.js';
import { field } from './field.js';
import { planTablesApply } from './portable-workspace.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

test('desired table planning previews exact row and unreachable-content fallout', () => {
	const definition = defineWorkspace({
		appId: 'apply-plan-test',
		tables: {
			notes: defineTable({
				fields: {
					id: field.id(),
					title: field.string(),
					attachment: field.blob(),
					body: field.doc(document.plainText),
				},
			}),
		},
	});
	const oldBlob = {
		hash: '1'.repeat(64),
		size: 1,
		mediaType: 'text/plain',
	};
	const keptBlob = {
		hash: '2'.repeat(64),
		size: 2,
		mediaType: 'text/plain',
	};
	const addedBlob = {
		hash: '3'.repeat(64),
		size: 3,
		mediaType: 'text/plain',
	};
	const plan = planTablesApply(
		definition,
		[
			{
				table: 'notes',
				rowId: 'delete',
				cells: { title: 'Delete', attachment: oldBlob },
			},
			{
				table: 'notes',
				rowId: 'update',
				cells: { title: 'Before', attachment: keptBlob },
			},
		],
		[
			{
				table: 'notes',
				rowId: 'create',
				cells: { title: 'Create', attachment: addedBlob },
			},
			{
				table: 'notes',
				rowId: 'update',
				cells: { title: 'After', attachment: keptBlob },
			},
		],
	);

	expect(plan.creates).toEqual([
		{
			table: 'notes',
			rowId: 'create',
			after: { id: 'create', title: 'Create', attachment: addedBlob },
		},
	]);
	expect(plan.updates).toEqual([
		{
			table: 'notes',
			rowId: 'update',
			changes: { title: { before: 'Before', after: 'After' } },
		},
	]);
	expect(plan.deletes).toEqual([
		{
			table: 'notes',
			rowId: 'delete',
			before: { id: 'delete', title: 'Delete', attachment: oldBlob },
		},
	]);
	expect(plan.documentFallout).toEqual([
		{ table: 'notes', rowId: 'delete', field: 'body' },
	]);
	expect(plan.blobFallout).toEqual([oldBlob]);
	expect(plan.mutations).toEqual([
		{
			kind: 'create',
			table: 'notes',
			row: { id: 'create', title: 'Create', attachment: addedBlob },
		},
		{
			kind: 'patch',
			table: 'notes',
			rowId: 'update',
			cells: { title: 'After' },
		},
		{ kind: 'remove', table: 'notes', rowId: 'delete' },
	]);
});
