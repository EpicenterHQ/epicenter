/**
 * File Merge Tests
 *
 * `mergeFile` merges three versions of one file by its kind: a row by field
 * and body after reading each version through `parseRow`, `kv.json` by key,
 * any other text by line, and binary or a side with no file as the whole
 * file. Each test names a pair of changes and shows what merges, what
 * competes, and what each pick settles to.
 *
 * Key behaviors:
 * - Independent field and body changes merge, unknown keys included
 * - Spelling never conflicts: quoting, key order, and comments read as the
 *   same values
 * - Two edits of one field compete even where a line merge would succeed
 * - Body edits to neighboring lines both merge; only the same lines compete,
 *   and each side of a competing body keeps the other side's other lines
 * - Two added rows with no base agree only where they are equal
 * - A row version that does not read as a row merges as text
 * - A side with no file, or a version that is not text, is the whole file
 * - A settled row is checked against its table
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './contract.js';
import { fileKindOf, type MergeUnit, mergeFile } from './merge-file.js';
import { sameValue } from './row-merge.js';

const definition = defineFolder({
	kv: { theme: field.string() },
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
const ROW = fileKindOf(definition, 'todos/walk.md');

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');

const BASE = row(['title: Walk', 'done: false'], 'Left at dawn.\n');

const ours = { kind: 'take', side: 'ours' } as const;
const theirs = { kind: 'take', side: 'theirs' } as const;

/** A merge that must be clean, as its settled text. */
async function clean(versions: Parameters<typeof mergeFile>[1], kind = ROW) {
	const merged = await mergeFile(kind, versions);
	expect(merged.units).toEqual([]);
	return expectOk(
		merged.settle(() => {
			throw new Error('nothing competes');
		}),
	);
}

test('a path is a row of its table, kv.json, or a plain file', () => {
	expect(ROW).toEqual({ kind: 'row', table: definition.tables.todos });
	expect(fileKindOf(definition, 'kv.json')).toEqual({
		kind: 'kv',
		schemas: definition.kv,
	});
	for (const path of ['todos/a.txt', 'todos/x/a.md', 'other/a.md', 'a.md'])
		expect(fileKindOf(definition, path)).toEqual({ kind: 'file' });
	expect(fileKindOf(undefined, 'kv.json')).toEqual({ kind: 'file' });
});

test('independent field and body changes merge, written in canonical form', async () => {
	expect(
		await clean({
			base: BASE,
			ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
			theirs: row(
				['title: Walk', 'done: true', 'mood: calm'],
				'Left at dawn.\nCame back by the river.\n',
			),
		}),
	).toBe(
		row(
			['title: Evening walk', 'done: true', 'mood: calm'],
			'Left at dawn.\nCame back by the river.\n',
		),
	);
});

test('body edits to neighboring lines both merge, as Sync and save merge them', async () => {
	const base = row(['title: Walk', 'done: false'], 'one\ntwo\nthree\n');
	expect(
		await clean({
			base,
			ours: row(['title: Walk', 'done: false'], 'ONE\ntwo\nthree\n'),
			theirs: row(['title: Walk', 'done: false'], 'one\nTWO\nthree\n'),
		}),
	).toBe(row(['title: Walk', 'done: false'], 'ONE\nTWO\nthree\n'));
});

test('quoting, key order, and comments are spelling, not changes', async () => {
	expect(
		await clean({
			base: BASE,
			ours: row(['done: false', "title: 'Walk' # quoted"], 'Left at dawn.\n'),
			theirs: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
		}),
	).toBe(row(['title: Walk', 'done: true'], 'Left at dawn.\n'));
});

test('two edits of one field compete, and each pick settles a valid row', async () => {
	const merged = await mergeFile(ROW, {
		base: BASE,
		ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		theirs: row(['title: Morning walk', 'done: true'], 'Left at dawn.\n'),
	});
	expect(merged.units).toEqual([
		{
			kind: 'field',
			field: 'title',
			base: 'Walk',
			ours: 'Evening walk',
			theirs: 'Morning walk',
		},
	]);
	expect(expectOk(merged.settle(() => ours))).toBe(
		row(['title: Evening walk', 'done: true'], 'Left at dawn.\n'),
	);
	expect(
		expectOk(merged.settle(() => ({ kind: 'replace', value: 'Noon walk' }))),
	).toBe(row(['title: Noon walk', 'done: true'], 'Left at dawn.\n'));
	// The table refuses a value it does not admit, naming the unit.
	const refused = expectErr(
		merged.settle(() => ({ kind: 'replace', value: 7 })),
	);
	expect(refused).toMatchObject([{ unit: merged.units[0] }]);
});

test('a field one side removed and the other changed competes', async () => {
	const merged = await mergeFile(ROW, {
		base: row(['title: Walk', 'done: false', 'tags: [a]']),
		ours: row(['title: Walk', 'done: false']),
		theirs: row(['title: Walk', 'done: false', 'tags: [a, b]']),
	});
	expect(merged.units).toEqual([
		{
			kind: 'field',
			field: 'tags',
			base: ['a'],
			ours: undefined,
			theirs: ['a', 'b'],
		},
	]);
	expect(expectOk(merged.settle(() => ours))).toBe(
		row(['title: Walk', 'done: false']),
	);
});

test("competing body lines are one unit, and each side keeps the other side's other lines", async () => {
	const at = (title: string, body: string) =>
		row([`title: ${title}`, 'done: false'], body);
	const merged = await mergeFile(ROW, {
		base: at('Walk', 'one\ntwo\nthree\nfour\n'),
		ours: at('Evening walk', 'ONE\ntwo\nthree\nfour (ours)\n'),
		theirs: at('Walk', 'one\nTWO\nthree\nfour (theirs)\n'),
	});
	expect(merged.units).toEqual([
		{
			kind: 'text',
			part: 'body',
			base: 'one\ntwo\nthree\nfour\n',
			ours: 'ONE\nTWO\nthree\nfour (ours)\n',
			theirs: 'ONE\nTWO\nthree\nfour (theirs)\n',
			regions: [{ line: 3, kept: 'four (ours)\n', theirs: 'four (theirs)\n' }],
		},
	]);
	// Taking theirs keeps our other lines and our title.
	expect(expectOk(merged.settle(() => theirs))).toBe(
		at('Evening walk', 'ONE\nTWO\nthree\nfour (theirs)\n'),
	);
	expect(expectErr(merged.settle(() => ({ kind: 'remove' })))).toMatchObject([
		{ message: 'A body cannot be removed; replace it with empty text' },
	]);
});

test('two added rows with no base agree only where equal', async () => {
	const merged = await mergeFile(ROW, {
		base: null,
		ours: row(['title: Walk', 'done: false'], 'Mine\n'),
		theirs: row(['title: Walk', 'done: true'], 'Theirs\n'),
	});
	expect(merged.units.map((unit) => unit.kind)).toEqual(['field', 'text']);
	expect(merged.units[1]).toMatchObject({ part: 'body', base: undefined });
});

test('a row version that does not read as a row merges as text', async () => {
	const broken = '---\ntitle: [unclosed\n---\n';
	// Their added body line does not compete with our broken frontmatter.
	expect(
		await clean({
			base: BASE,
			ours: broken,
			theirs: row(['title: Walk', 'done: false'], 'Left at dawn.\nAnd more.\n'),
		}),
	).toBe('---\ntitle: [unclosed\n---\nAnd more.\n');
	// Their changed title does.
	const merged = await mergeFile(ROW, {
		base: BASE,
		ours: broken,
		theirs: row(['title: Run', 'done: false'], 'Left at dawn.\nAnd more.\n'),
	});
	expect(merged.units).toMatchObject([{ kind: 'text', part: 'file' }]);
	expect(expectOk(merged.settle(() => ours))).toBe(
		'---\ntitle: [unclosed\n---\nAnd more.\n',
	);
});

test('kv.json merges by key, and a competing key settles by its schema', async () => {
	const KV = fileKindOf(definition, 'kv.json');
	const merged = await mergeFile(KV, {
		base: '{\n  "theme": "light"\n}\n',
		ours: '{\n  "theme": "dark",\n  "other": 1\n}\n',
		theirs: '{\n  "theme": "sepia",\n  "more": 2\n}\n',
	});
	expect(merged.units).toEqual([
		{
			kind: 'setting',
			key: 'theme',
			base: 'light',
			ours: 'dark',
			theirs: 'sepia',
		},
	]);
	expect(expectOk(merged.settle(() => ours))).toBe(
		'{\n  "more": 2,\n  "other": 1,\n  "theme": "dark"\n}\n',
	);
	expect(
		expectErr(merged.settle(() => ({ kind: 'replace', value: 7 }))),
	).toHaveLength(1);
});

test('other text merges by line', async () => {
	const FILE = fileKindOf(definition, 'notes.txt');
	expect(
		await clean(
			{ base: 'a\nb\nc\n', ours: 'A\nb\nc\n', theirs: 'a\nb\nC\n' },
			FILE,
		),
	).toBe('A\nb\nC\n');
	const merged = await mergeFile(FILE, {
		base: 'a\nb\n',
		ours: 'a\nB (ours)\n',
		theirs: 'a\nB (theirs)\n',
	});
	expect(merged.units).toMatchObject([{ kind: 'text', part: 'file' }]);
	expect(expectOk(merged.settle(() => ({ kind: 'remove' })))).toBeNull();
});

test('a side with no file, or a version that is not text, is the whole file', async () => {
	const changed = row(['title: Evening walk', 'done: false']);
	const bytes = new Uint8Array([0, 1, 2]);
	const cases: [Parameters<typeof mergeFile>[1], boolean][] = [
		[{ base: BASE, ours: null, theirs: changed }, false],
		[{ base: BASE, ours: changed, theirs: null }, false],
		[{ base: BASE, ours: changed, theirs: bytes }, true],
		[{ base: bytes, ours: new Uint8Array([1]), theirs: bytes.slice(1) }, true],
	];
	for (const [versions, binary] of cases) {
		const merged = await mergeFile(ROW, versions);
		expect(merged.units).toEqual([
			{ kind: 'whole', binary, ...versions } as MergeUnit,
		]);
		expect(expectOk(merged.settle(() => theirs))).toBe(versions.theirs);
		if (binary)
			expect(
				expectErr(merged.settle(() => ({ kind: 'replace', value: 'x' }))),
			).toHaveLength(1);
	}
});

test('values compare as JSON, whatever their key order', () => {
	expect(
		sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
	).toBe(true);
	expect(sameValue([1, 2], [2, 1])).toBe(false);
	expect(sameValue({ a: undefined }, {})).toBe(false);
	expect(sameValue(null, {})).toBe(false);
});
