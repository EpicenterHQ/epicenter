/**
 * File Merge Tests
 *
 * `merge` merges three versions of one file by its kind, the writer acting
 * (`ours`) winning each unit both sides changed differently: a row by field
 * and body after reading each version through `parseRow`, `kv.json` by key,
 * any other text by line, and binary or a side with no file as the whole
 * file. Each test names a pair of changes and shows what merges and what
 * the writer overrode.
 *
 * Key behaviors:
 * - Independent field and body changes merge, unknown keys included
 * - Spelling never conflicts: quoting, key order, and comments read as the
 *   same values
 * - Two edits of one field compete even where a line merge would succeed
 * - Body edits to neighboring lines both merge; only the same lines compete,
 *   and the writer keeps the other side's other lines
 * - Two added rows with no base agree only where they are equal; two bodies
 *   added at one place both stay
 * - A row version that does not read as a row merges as text
 * - A side with no file, or a version that is not text, is the whole file
 */
import { expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from './contract.js';
import { type FileVersions, fileKindOf, merge } from './merge-file.js';
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

/** A merge where nothing competes, as its content. */
async function clean(versions: FileVersions, kind = ROW) {
	const merged = await merge(kind, versions);
	expect(merged.overridden).toEqual([]);
	return merged.content;
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

test('two edits of one field compete, and the writer wins a valid row', async () => {
	expect(
		await merge(ROW, {
			base: BASE,
			ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
			theirs: row(['title: Morning walk', 'done: true'], 'Left at dawn.\n'),
		}),
	).toEqual({
		content: row(['title: Evening walk', 'done: true'], 'Left at dawn.\n'),
		overridden: [{ kind: 'field', field: 'title' }],
	});
});

test('a field one side removed and the other changed competes', async () => {
	expect(
		await merge(ROW, {
			base: row(['title: Walk', 'done: false', 'tags: [a]']),
			ours: row(['title: Walk', 'done: false']),
			theirs: row(['title: Walk', 'done: false', 'tags: [a, b]']),
		}),
	).toEqual({
		content: row(['title: Walk', 'done: false']),
		overridden: [{ kind: 'field', field: 'tags' }],
	});
});

test("competing body lines are one unit, and the writer keeps the other side's other lines", async () => {
	const at = (title: string, body: string) =>
		row([`title: ${title}`, 'done: false'], body);
	const versions = {
		base: at('Walk', 'one\ntwo\nthree\nfour\n'),
		ours: at('Evening walk', 'ONE\ntwo\nthree\nfour (ours)\n'),
		theirs: at('Walk', 'one\nTWO\nthree\nfour (theirs)\n'),
	};
	expect(await merge(ROW, versions)).toEqual({
		content: at('Evening walk', 'ONE\nTWO\nthree\nfour (ours)\n'),
		overridden: [{ kind: 'lines', part: 'body', line: 4, count: 1 }],
	});
	// The merge driver's other side keeps our other lines and our title.
	expect((await merge(ROW, versions, { winner: 'theirs' })).content).toBe(
		at('Evening walk', 'ONE\nTWO\nthree\nfour (theirs)\n'),
	);
});

test('two added rows with no base agree only where equal, and both bodies stay', async () => {
	expect(
		await merge(ROW, {
			base: null,
			ours: row(['title: Walk', 'done: false'], 'Mine\n'),
			theirs: row(['title: Walk', 'done: true'], 'Theirs\n'),
		}),
	).toEqual({
		content: row(['title: Walk', 'done: false'], 'Theirs\nMine\n'),
		overridden: [{ kind: 'field', field: 'done' }],
	});
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
	// Their changed title does, and ours stands.
	const merged = await merge(ROW, {
		base: BASE,
		ours: broken,
		theirs: row(['title: Run', 'done: false'], 'Left at dawn.\nAnd more.\n'),
	});
	expect(merged.content).toBe('---\ntitle: [unclosed\n---\nAnd more.\n');
	expect(merged.overridden).toMatchObject([{ kind: 'lines', part: 'text' }]);
});

test('kv.json merges by key, and the writer wins a competing key', async () => {
	expect(
		await merge(fileKindOf(definition, 'kv.json'), {
			base: '{\n  "theme": "light"\n}\n',
			ours: '{\n  "theme": "dark",\n  "other": 1\n}\n',
			theirs: '{\n  "theme": "sepia",\n  "more": 2\n}\n',
		}),
	).toEqual({
		content: '{\n  "more": 2,\n  "other": 1,\n  "theme": "dark"\n}\n',
		overridden: [{ kind: 'setting', key: 'theme' }],
	});
});

test('other text merges by line', async () => {
	const FILE = fileKindOf(definition, 'notes.txt');
	expect(
		await clean(
			{ base: 'a\nb\nc\n', ours: 'A\nb\nc\n', theirs: 'a\nb\nC\n' },
			FILE,
		),
	).toBe('A\nb\nC\n');
	expect(
		await merge(FILE, {
			base: 'a\nb\n',
			ours: 'a\nB (ours)\n',
			theirs: 'a\nB (theirs)\n',
		}),
	).toEqual({
		content: 'a\nB (ours)\n',
		overridden: [{ kind: 'lines', part: 'text', line: 2, count: 1 }],
	});
});

test('a side with no file, or a version that is not text, is the whole file', async () => {
	const changed = row(['title: Evening walk', 'done: false']);
	const bytes = new Uint8Array([0, 1, 2]);
	const cases: [FileVersions, string | Uint8Array | null, 'ours' | 'theirs'][] =
		[
			// A delete beats the edit it never saw, from either side.
			[{ base: BASE, ours: null, theirs: changed }, null, 'theirs'],
			[{ base: BASE, ours: changed, theirs: null }, null, 'ours'],
			[{ base: BASE, ours: changed, theirs: bytes }, changed, 'theirs'],
			[
				{ base: bytes, ours: new Uint8Array([1]), theirs: bytes.slice(1) },
				new Uint8Array([1]),
				'theirs',
			],
		];
	for (const [versions, content, lost] of cases)
		expect(await merge(ROW, versions)).toEqual({
			content,
			overridden: [{ kind: 'file', lost }],
		});
});

test('values compare as JSON, whatever their key order', () => {
	expect(
		sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
	).toBe(true);
	expect(sameValue([1, 2], [2, 1])).toBe(false);
	expect(sameValue({ a: undefined }, {})).toBe(false);
	expect(sameValue(null, {})).toBe(false);
});
