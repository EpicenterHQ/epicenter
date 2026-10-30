/**
 * Saved view projections retain typed values and saved document identity.
 * Filters distinguish missing values, sorting never coerces types or moves
 * missing values ahead, and board destinations keep colliding labels distinct.
 */
import { expect, test } from 'bun:test';
import type { SavedView } from '@epicenter/folder/declaration';
import { readDocument } from '@epicenter/folder/documents';
import { applyView, boardLanes } from './view.js';

type TableView = Extract<SavedView, { type: 'grid' | 'board' }>;
const document = (name: string, fields: Record<string, unknown> = {}) =>
	readDocument(
		`tasks/${name}.md`,
		new TextEncoder().encode(`---\n${JSON.stringify(fields)}\n---\nBody`),
	);
const grid = (
	overrides: Partial<Extract<TableView, { type: 'grid' }>> = {},
): Extract<TableView, { type: 'grid' }> => ({
	type: 'grid',
	title: 'Work',
	table: 'tasks',
	...overrides,
});
const names = (documents: ReturnType<typeof document>[]) =>
	documents.map((doc) => doc.stem);

test('equality compares JSON deeply and distinguishes missing, null, number and text', () => {
	const documents = [
		document('missing'),
		document('null', { value: null }),
		document('number', { value: 1 }),
		document('text', { value: '1' }),
		document('nested', { value: { b: [1, { done: true }], a: null } }),
	];
	const filtered = (operator: 'eq' | 'ne', value: unknown) =>
		names(
			applyView(
				documents,
				grid({ filters: [{ field: 'value', operator, value }] }),
			).documents,
		);
	expect(filtered('eq', null)).toEqual(['null']);
	expect(filtered('ne', null)).toEqual(['missing', 'nested', 'number', 'text']);
	expect(filtered('eq', 1)).toEqual(['number']);
	expect(filtered('eq', '1')).toEqual(['text']);
	expect(filtered('eq', { a: null, b: [1, { done: true }] })).toEqual([
		'nested',
	]);
});

test('relational filtering compares matching text or numbers without coercion', () => {
	const documents = [
		document('two', { value: 2 }),
		document('ten', { value: 10 }),
		document('text-two', { value: '2' }),
		document('text-ten', { value: '10' }),
		document('null', { value: null }),
		document('missing'),
	];
	expect(
		names(
			applyView(
				documents,
				grid({ filters: [{ field: 'value', operator: 'gt', value: 2 }] }),
			).documents,
		),
	).toEqual(['ten']);
	expect(
		names(
			applyView(
				documents,
				grid({ filters: [{ field: 'value', operator: 'lt', value: '2' }] }),
			).documents,
		),
	).toEqual(['text-ten']);
	expect(
		names(
			applyView(
				documents,
				grid({
					filters: [
						{ field: 'value', operator: 'gte', value: 2 },
						{ field: 'value', operator: 'lte', value: 2 },
					],
				}),
			).documents,
		),
	).toEqual(['two']);
});

test('contains finds substrings or deeply equal array elements without text coercion', () => {
	const documents = [
		document('text', { value: 'abc' }),
		document('array', { value: ['b', { labels: [1, 2] }] }),
		document('number', { value: 12 }),
	];
	expect(
		names(
			applyView(
				documents,
				grid({
					filters: [{ field: 'value', operator: 'contains', value: 'b' }],
				}),
			).documents,
		),
	).toEqual(['array', 'text']);
	expect(
		names(
			applyView(
				documents,
				grid({
					filters: [
						{ field: 'value', operator: 'contains', value: { labels: [1, 2] } },
					],
				}),
			).documents,
		),
	).toEqual(['array']);
	expect(
		names(
			applyView(
				documents,
				grid({
					filters: [{ field: 'value', operator: 'contains', value: '2' }],
				}),
			).documents,
		),
	).toEqual([]);
});

test('exists defaults to true and treats null and false as present values', () => {
	const documents = [
		document('missing'),
		document('null', { value: null }),
		document('false', { value: false }),
	];
	expect(
		names(
			applyView(
				documents,
				grid({ filters: [{ field: 'value', operator: 'exists' }] }),
			).documents,
		),
	).toEqual(['false', 'null']);
	expect(
		names(
			applyView(
				documents,
				grid({
					filters: [{ field: 'value', operator: 'exists', value: false }],
				}),
			).documents,
		),
	).toEqual(['missing']);
});

test('invalid filter operands report problems and exclude rows instead of being ignored', () => {
	const documents = [document('one', { value: 1 })];
	for (const filter of [
		{ field: 'value', operator: 'eq' as const },
		{ field: 'value', operator: 'exists' as const, value: 'false' },
		{ field: 'value', operator: 'lt' as const, value: null },
		{ field: ' ', operator: 'eq' as const, value: 1 },
	]) {
		const result = applyView(documents, grid({ filters: [filter] }));
		expect(result.problems).toHaveLength(1);
		expect(result.documents).toEqual([]);
	}
});

test('sorting uses typed deterministic order, secondary fields and path ties with missing last in both directions', () => {
	const documents = [
		document('missing'),
		document('text', { value: '2' }),
		document('number-ten', { value: 10 }),
		document('number-two', { value: 2 }),
		document('null', { value: null }),
		document('false', { value: false }),
		document('z', { value: 2, second: 'a' }),
		document('a', { value: 2, second: 'a' }),
	];
	const ascending = applyView(
		documents,
		grid({
			sort: [
				{ field: 'value', direction: 'asc' },
				{ field: 'second', direction: 'asc' },
			],
		}),
	);
	expect(names(ascending.documents)).toEqual([
		'null',
		'false',
		'a',
		'z',
		'number-two',
		'number-ten',
		'text',
		'missing',
	]);
	const descending = applyView(
		documents,
		grid({ sort: [{ field: 'value', direction: 'desc' }] }),
	);
	expect(names(descending.documents)).toEqual([
		'text',
		'number-ten',
		'a',
		'number-two',
		'z',
		'false',
		'null',
		'missing',
	]);
	expect(documents[0]?.stem).toBe('missing');
});

test('string sorting follows the strings rather than their JSON escape spelling', () => {
	const documents = [
		document('letter', { value: 'B' }),
		document('quote', { value: '"' }),
	];
	expect(
		names(
			applyView(
				documents,
				grid({ sort: [{ field: 'value', direction: 'asc' }] }),
			).documents,
		),
	).toEqual(['quote', 'letter']);
});

test('board lanes keep null, missing and same-label scalar types distinct and objects inaccessible as destinations', () => {
	const documents = [
		document('number', { value: 1 }),
		document('text-number', { value: '1' }),
		document('boolean', { value: true }),
		document('text-boolean', { value: 'true' }),
		document('null', { value: null }),
		document('text-null', { value: 'null' }),
		document('text-null-suffix', { value: 'null (null)' }),
		document('missing'),
		document('text-missing', { value: 'No value' }),
		document('object', { value: { status: 'done' } }),
		document('array', { value: [1] }),
		document('text-other', { value: 'Other' }),
	];
	const lanes = boardLanes(documents, 'value');
	expect(new Set(lanes.map((lane) => lane.key)).size).toBe(lanes.length);
	expect(new Set(lanes.map((lane) => lane.label)).size).toBe(lanes.length);
	expect(
		lanes.find((lane) => lane.value === 1)?.documents.map((doc) => doc.stem),
	).toEqual(['number']);
	expect(
		lanes.find((lane) => lane.value === '1')?.documents.map((doc) => doc.stem),
	).toEqual(['text-number']);
	expect(
		lanes
			.find((lane) => lane.key === 'missing')
			?.documents.map((doc) => doc.stem),
	).toEqual(['missing']);
	expect(lanes.find((lane) => lane.key === 'other')).toMatchObject({
		editable: false,
		value: undefined,
	});
	expect(
		lanes
			.find((lane) => lane.key === 'other')
			?.documents.map((doc) => doc.stem),
	).toEqual(['object', 'array']);
});

test('enum and boolean hints retain empty lanes and enum order before observed values and missing', () => {
	const schema = {
		type: 'object' as const,
		properties: {
			state: { enum: ['done', 'todo'] },
			active: { type: 'boolean' as const },
			choice: { anyOf: [{ const: 2 }, { const: '2' }, { const: null }] },
		},
	};
	const documents = [document('one', { state: 'other' })];
	expect(
		boardLanes(documents, 'state', schema).map((lane) => lane.value),
	).toEqual(['done', 'todo', 'other', undefined]);
	expect(boardLanes([], 'active', schema).map((lane) => lane.value)).toEqual([
		false,
		true,
		undefined,
	]);
	expect(boardLanes([], 'choice', schema).map((lane) => lane.value)).toEqual([
		2,
		'2',
		null,
		undefined,
	]);
	expect(boardLanes(documents, 'state', schema)[0]?.documents).toEqual([]);
});

test('malformed readable documents keep their issues and document identity in default projections', () => {
	const broken = readDocument(
		'tasks/broken.md',
		new TextEncoder().encode('---\nvalue: [\n---\nBody'),
	);
	expect(broken.issues?.length).toBeGreaterThan(0);
	expect(applyView([broken], grid()).documents[0]).toBe(broken);
	expect(
		boardLanes([broken], 'value').find((lane) => lane.key === 'missing')
			?.documents[0],
	).toBe(broken);
});
