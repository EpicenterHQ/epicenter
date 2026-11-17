/**
 * Filename checks use a case-sensitive memory folder to retain aliases that
 * the host disk merges. Invalid ids count without being parsed as records.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import {
	checkData,
	createMemoryContext,
	defineApp,
	defineData,
	field,
	inRun,
} from './index.ts';

test('NFC and case aliases form one problem per group, with each affected file counted once', async () => {
	const context = createMemoryContext({
		'data/notes/Dune.md': '',
		'data/notes/dune.md': '',
		'data/notes/DUNE.md': '',
		'data/notes/café.md': '',
		'data/notes/cafe\u0301.md': '---\nnot parsed\n',
		'data/notes/ı.md': '',
		'data/notes/i.md': '',
		'data/notes/Ꭰ.md': '',
		'data/notes/ꭰ.md': '',
		'data/notes/Ᏸ.md': '',
		'data/notes/ᏸ.md': '',
	});
	const report = await inRun(context, () =>
		checkData(defineData({ notes: { fields: {} } })),
	);
	expect(report.notes).toMatchObject({
		files: 11,
		withProblems: 9,
		kinds: [
			{ kind: 'are one file on a disk that ignores case', count: 9 },
			{ kind: 'an id must be Unicode NFC', count: 1 },
		],
	});
	expect(
		report.notes?.records.filter(({ problems }) =>
			problems.some(
				({ line }) => line === 'are one file on a disk that ignores case',
			),
		),
	).toHaveLength(4);
	expect(
		report.notes?.records.find(({ path }) => path === 'notes/cafe\u0301.md')
			?.problems,
	).toEqual([
		{ line: 'an id must be Unicode NFC', kind: 'an id must be Unicode NFC' },
	]);
	expect(JSON.stringify(report)).not.toContain('not parsed');
});

test('an id over 200 UTF-8 bytes is counted and never read', async () => {
	const path = `data/notes/${'é'.repeat(101)}.md`;
	const context = createMemoryContext({ [path]: '---\nnot parsed\n' });
	const report = await inRun(context, () =>
		checkData(defineData({ notes: { fields: {} } })),
	);
	expect(report.notes).toMatchObject({
		files: 1,
		withProblems: 1,
		records: [
			{ problems: [{ line: 'an id must be at most 200 UTF-8 bytes' }] },
		],
	});
});

test('refs in a one-file key and nested lists resolve targets declared later', async () => {
	const data = defineData({
		'settings.md': {
			fields: {
				watch: field.ref('watches'),
				nested: field.list(field.list(field.ref('watches'))),
			},
		},
		watches: { fields: {} },
	});
	const context = createMemoryContext({
		'data/settings.md':
			'---\nwatch: "Exact"\nnested: [["Exact", "missing"]]\n---\n',
		'data/watches/Exact.md': '',
	});
	const app = defineApp({ description: 'Watches', data, actions: {} });
	const report = await inRun(context, () => checkData(app.data));
	expect(report['settings.md']).toMatchObject({
		files: 1,
		withProblems: 1,
		records: [
			{
				path: 'settings.md',
				problems: [
					{ line: 'nested[0][1] "missing" names no file in watches/' },
				],
			},
		],
	});
	expect(report.watches).toMatchObject({ files: 1, withProblems: 0 });
});

test('a union of refs fits when the id is listed in either target', async () => {
	const data = defineData({
		notes: {
			fields: { target: Type.Union([field.ref('first'), field.ref('second')]) },
		},
		first: { fields: {} },
		second: { fields: {} },
	});
	const context = createMemoryContext({
		'data/notes/one.md': '---\ntarget: "present"\n---\n',
		'data/second/present.md': '',
	});
	const report = await inRun(context, () => checkData(data));
	expect(report.notes).toMatchObject({
		files: 1,
		withProblems: 0,
		records: [],
	});
});
