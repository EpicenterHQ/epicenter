/**
 * `checkData` reads an app's records on disk and reports what does not fit.
 * Names that are one file on a disk that folds case or Unicode form can be
 * made only on a disk that keeps them apart, so that check runs only there.
 * Invalid ids count without being parsed as records.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { checkData, defineData, field } from './index.ts';
import { foldsCase, tempFolder } from './library.test-support.ts';

test.skipIf(foldsCase)(
	'NFC and case aliases form one problem per group, with each affected file counted once',
	async () => {
		const { folder } = await tempFolder({
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
		const report = await checkData(
			folder.path,
			defineData(folder, { notes: { fields: {} } }),
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
				problems.includes('are one file on a disk that ignores case'),
			),
		).toHaveLength(4);
		expect(
			report.notes?.records.find(({ path }) => path === 'notes/cafe\u0301.md')
				?.problems,
		).toEqual(['an id must be Unicode NFC']);
		expect(JSON.stringify(report)).not.toContain('not parsed');
	},
);

test('an id that is not NFC is counted and never read', async () => {
	const { folder } = await tempFolder({
		'data/notes/cafe\u0301.md': '---\nnot parsed\n',
	});
	const report = await checkData(
		folder.path,
		defineData(folder, { notes: { fields: {} } }),
	);
	expect(report.notes).toMatchObject({
		files: 1,
		withProblems: 1,
		kinds: [{ kind: 'an id must be Unicode NFC', count: 1 }],
	});
	expect(JSON.stringify(report)).not.toContain('not parsed');
});

test('an id over 200 UTF-8 bytes is counted and never read', async () => {
	// 'é' is two bytes and 101 of them fit a file name, which allows 255 bytes.
	const path = `data/notes/${'é'.repeat(101)}.md`;
	const { folder } = await tempFolder({ [path]: '---\nnot parsed\n' });
	const report = await checkData(
		folder.path,
		defineData(folder, { notes: { fields: {} } }),
	);
	expect(report.notes).toMatchObject({
		files: 1,
		withProblems: 1,
		records: [{ problems: ['an id must be at most 200 UTF-8 bytes'] }],
	});
});

test('refs in a one-file key and nested lists resolve targets declared later', async () => {
	const { folder } = await tempFolder({
		'data/settings.md':
			'---\nwatch: "Exact"\nnested: [["Exact", "missing"]]\n---\n',
		'data/watches/Exact.md': '',
	});
	const data = defineData(folder, {
		'settings.md': {
			fields: {
				watch: field.ref('watches'),
				nested: field.list(field.list(field.ref('watches'))),
			},
		},
		watches: { fields: {} },
	});
	const report = await checkData(folder.path, data);
	expect(report['settings.md']).toMatchObject({
		files: 1,
		withProblems: 1,
		records: [
			{
				path: 'settings.md',
				problems: ['nested[0][1] "missing" names no file in watches/'],
			},
		],
	});
	expect(report.watches).toMatchObject({ files: 1, withProblems: 0 });
});

test('a union of refs fits when the id is listed in either target', async () => {
	const { folder } = await tempFolder({
		'data/notes/one.md': '---\ntarget: "present"\n---\n',
		'data/second/present.md': '',
	});
	const data = defineData(folder, {
		notes: {
			fields: { target: Type.Union([field.ref('first'), field.ref('second')]) },
		},
		first: { fields: {} },
		second: { fields: {} },
	});
	const report = await checkData(folder.path, data);
	expect(report.notes).toMatchObject({
		files: 1,
		withProblems: 0,
		records: [],
	});
});
