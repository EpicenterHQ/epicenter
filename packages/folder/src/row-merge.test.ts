/**
 * Row Merge Tests
 *
 * `mergeRow` merges three versions of one row file by field and body, after
 * reading each through `parseRow`. Each test names a pair of changes and
 * shows what merges and what a person must settle.
 *
 * Key behaviors:
 * - Independent field and body changes merge, unknown keys included
 * - Spelling never conflicts: quoting, key order, and comments read as the
 *   same values
 * - Two edits of one field conflict even where a line merge would succeed
 * - Body edits to neighboring lines both merge; only the same lines compete
 * - Competing body lines are one body conflict; merged fields are kept
 * - Two added rows with no base agree only where they are equal
 * - A deleted or unreadable version makes the whole file one unit
 */
import { expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from './contract.js';
import { mergeRow, sameValue } from './row-merge.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.optional(field.tags()),
			},
		}),
	},
});
const todos = definition.tables.todos;

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');

const BASE = row(['title: Walk', 'done: false'], 'Left at dawn.\n');

test('independent field and body changes merge', async () => {
	const merged = await mergeRow(todos, {
		base: BASE,
		ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		theirs: row(
			['title: Walk', 'done: true', 'mood: calm'],
			'Left at dawn.\nCame back by the river.\n',
		),
	});
	expect(merged).toEqual({
		kind: 'merged',
		row: {
			fields: { title: 'Evening walk', done: true, mood: 'calm' },
			body: 'Left at dawn.\nCame back by the river.\n',
		},
	});
});

test('both sides changing different body lines merge by line', async () => {
	const base = row(['title: Walk', 'done: false'], 'one\ntwo\nthree\n');
	const merged = await mergeRow(todos, {
		base,
		ours: row(['title: Walk', 'done: false'], 'ONE\ntwo\nthree\n'),
		theirs: row(['title: Walk', 'done: false'], 'one\ntwo\nTHREE'),
	});
	expect(merged.kind === 'merged' && merged.row.body).toBe('ONE\ntwo\nTHREE');
});

test('body edits to neighboring lines both merge, as Sync and save merge them', async () => {
	const base = row(['title: Walk', 'done: false'], 'one\ntwo\nthree\n');
	const merged = await mergeRow(todos, {
		base,
		ours: row(['title: Walk', 'done: false'], 'ONE\ntwo\nthree\n'),
		theirs: row(['title: Walk', 'done: false'], 'one\nTWO\nthree\n'),
	});
	expect(merged).toMatchObject({
		kind: 'merged',
		row: { body: 'ONE\nTWO\nthree\n' },
	});
});

test('a body line merge keeps every character of each line', async () => {
	for (const [base, ours, theirs, merged] of [
		[
			'x\u2028y\nmid\nz\n',
			'X\u2028y\nmid\nz\n',
			'x\u2028y\nmid\nZ\n',
			'X\u2028y\nmid\nZ\n',
		],
		['x\ry\nmid\nz\n', 'X\ry\nmid\nz\n', 'x\ry\nmid\nZ\n', 'X\ry\nmid\nZ\n'],
		[
			'a\u2029b\r\nmid\nend',
			'a\u2029B\r\nmid\nend',
			'a\u2029b\r\nmid\nEND',
			'a\u2029B\r\nmid\nEND',
		],
	]) {
		const at = (body: string) => row(['title: Walk', 'done: false'], body);
		const result = await mergeRow(todos, {
			base: at(base!),
			ours: at(ours!),
			theirs: at(theirs!),
		});
		expect(result.kind === 'merged' && result.row.body).toBe(merged!);
	}
});

test('quoting, key order, and comments are spelling, not changes', async () => {
	const merged = await mergeRow(todos, {
		base: BASE,
		ours: row(['done: false', "title: 'Walk' # quoted"], 'Left at dawn.\n'),
		theirs: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
	});
	expect(merged).toEqual({
		kind: 'merged',
		row: { fields: { title: 'Walk', done: true }, body: 'Left at dawn.\n' },
	});
});

test('two edits of one field conflict, and the rest merges', async () => {
	const merged = await mergeRow(todos, {
		base: BASE,
		ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		theirs: row(['title: Morning walk', 'done: true'], 'Left at dawn.\n'),
	});
	expect(merged).toEqual({
		kind: 'conflict',
		row: { fields: { done: true }, body: 'Left at dawn.\n' },
		fields: [
			{
				field: 'title',
				base: 'Walk',
				ours: 'Evening walk',
				theirs: 'Morning walk',
			},
		],
		body: undefined,
	});
});

test('a field one side removed and the other changed conflicts', async () => {
	const base = row(['title: Walk', 'done: false', 'tags: [a]']);
	const merged = await mergeRow(todos, {
		base,
		ours: row(['title: Walk', 'done: false']),
		theirs: row(['title: Walk', 'done: false', 'tags: [a, b]']),
	});
	expect(merged.kind === 'conflict' && merged.fields).toEqual([
		{ field: 'tags', base: ['a'], ours: undefined, theirs: ['a', 'b'] },
	]);
});

test('competing body lines are one conflict, and merged fields stay', async () => {
	const merged = await mergeRow(todos, {
		base: BASE,
		ours: row(['title: Evening walk', 'done: false'], 'Left at six.\n'),
		theirs: row(['title: Walk', 'done: false'], 'Left at seven.\n'),
	});
	expect(merged).toEqual({
		kind: 'conflict',
		row: {
			fields: { title: 'Evening walk', done: false },
			body: 'Left at six.\n',
		},
		fields: [],
		body: {
			base: 'Left at dawn.\n',
			ours: 'Left at six.\n',
			theirs: 'Left at seven.\n',
		},
	});
});

test('two added rows with no base agree only where equal', async () => {
	const merged = await mergeRow(todos, {
		base: null,
		ours: row(['title: Walk', 'done: false'], 'Mine\n'),
		theirs: row(['title: Walk', 'done: true'], 'Theirs\n'),
	});
	expect(merged.kind).toBe('conflict');
	if (merged.kind !== 'conflict') return;
	expect(merged.row.fields).toEqual({ title: 'Walk' });
	expect(merged.fields.map(({ field }) => field)).toEqual(['done']);
	expect(merged.body).toEqual({
		base: undefined,
		ours: 'Mine\n',
		theirs: 'Theirs\n',
	});
});

test('a deleted or unreadable version makes the whole file one unit', async () => {
	const changed = row(['title: Evening walk', 'done: false']);
	for (const versions of [
		{ base: BASE, ours: null, theirs: changed },
		{ base: BASE, ours: changed, theirs: null },
		{ base: BASE, ours: changed, theirs: row(['title: Walk']) },
		{ base: BASE, ours: '---\ntitle: [unclosed\n---\n', theirs: changed },
		{ base: row(['done: maybe']), ours: changed, theirs: BASE },
	])
		expect(await mergeRow(todos, versions)).toEqual({ kind: 'whole' });
});

test('values compare as JSON, whatever their key order', () => {
	expect(
		sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
	).toBe(true);
	expect(sameValue([1, 2], [2, 1])).toBe(false);
	expect(sameValue({ a: undefined }, {})).toBe(false);
	expect(sameValue(null, {})).toBe(false);
});
