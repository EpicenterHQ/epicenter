/**
 * Data handles read and patch top-level Markdown records in the folder they were defined with.
 * Covers a fixed-id key, exact and refused ids, create, passage edits, concurrent computed
 * edits, repairs, diagnostics, list membership, refused definitions, and the separation
 * between app writes and reference checks.
 */
import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type TSchema, Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { ActionError, defineData, type Folder, field, Ok } from './index.ts';
import { foldsCase, tempFolder, unusedFolder } from './library.test-support.ts';

async function setup(seed: Record<string, string> = {}) {
	const { folder, read, files } = await tempFolder(seed);
	const data = defineData(folder, {
		notes: {
			description: 'note',
			fields: {
				title: field.text(),
				count: field.integer({ optional: true }),
				done: field.boolean({ optional: true }),
				tags: field.list(field.text(), { optional: true }),
			},
		},
		settings: {
			description: 'settings record',
			fields: { title: field.text(), count: field.integer({ optional: true }) },
		},
	});
	return { folder, read, files, data };
}

test('folder verbs read, create, patch, compute, list, and delete flat records', async () => {
	const {
		data: { notes },
	} = await setup();
	expect(expectOk(await notes.get('Dune'))).toBeUndefined();
	expect(notes.path('Dune')).toBe('data/notes/Dune.md');
	const added = expectOk(
		await notes.create('Dune', { title: 'Dune', body: 'Arrakis' }),
	);
	expect(added).toEqual({
		path: 'data/notes/Dune.md',
		id: 'Dune',
		title: 'Dune',
		body: 'Arrakis',
	});
	expect(expectOk(await notes.get('Dune'))).toEqual(added);
	expect(
		expectOk(await notes.patch('Dune', { count: 2, body: 'spice' })).count,
	).toBe(2);
	expect(
		expectOk(
			await notes.edit('Dune', (now) => Ok({ count: (now?.count ?? 0) + 1 })),
		).count,
	).toBe(3);
	expect(
		expectOk(await notes.patch('Dune', { count: null })),
	).not.toHaveProperty('count');
	expect((await notes.list()).map(expectOk)).toEqual([
		{ ...added, body: 'spice' },
	]);
	expect(expectOk(await notes.delete('Dune'))).toBe(true);
	expect(expectOk(await notes.delete('Dune'))).toBe(false);
	expect(expectOk(await notes.get('Dune'))).toBeUndefined();
});

test('one settings record is an ordinary key with a fixed id, made by edit', async () => {
	const {
		data: { settings },
	} = await setup();
	expect(settings.path('settings')).toBe('data/settings/settings.md');
	expect(expectOk(await settings.get('settings'))).toBeUndefined();
	let sawAbsent = false;
	expect(
		expectOk(
			await settings.edit('settings', (now) => {
				sawAbsent = now === undefined;
				return Ok({ title: 'Daily', body: 'notes' });
			}),
		),
	).toEqual({
		path: 'data/settings/settings.md',
		id: 'settings',
		title: 'Daily',
		body: 'notes',
	});
	expect(sawAbsent).toBe(true);
	expect(
		expectOk(
			await settings.edit('settings', (now) =>
				Ok({ count: (now?.count ?? 0) + 1 }),
			),
		),
	).toMatchObject({ title: 'Daily', count: 1 });
	expect(expectOk(await settings.delete('settings'))).toBe(true);
	expect(expectOk(await settings.delete('settings'))).toBe(false);
});

test('create refuses an existing file even when another create supplies identical content', async () => {
	const {
		data: { notes },
	} = await setup();
	const [created, collision] = await Promise.all([
		notes.create('same', { title: 'first' }),
		notes.create('same', { title: 'second' }),
	]);
	expect(expectOk(created)).toMatchObject({ title: 'first' });
	const there = expectErr(collision);
	expect(there).toMatchObject({
		name: 'Changed',
		cause: 'there',
		path: 'data/notes/same.md',
		message: 'data/notes/same.md is already there',
	});
	expect(
		expectErr(await notes.create('same', { title: 'first' })),
	).toMatchObject({ name: 'Changed', cause: 'there' });
	expect(expectOk(await notes.get('same'))).toMatchObject({ title: 'first' });
});

test('patch returns Missing, a computed edit creates only a fitting record, and may create', async () => {
	const { read, data } = await setup();
	expect(expectErr(await data.notes.patch('typo', { title: 'x' })).name).toBe(
		'Missing',
	);
	// A change that does not fit is Misfit, like a file that does not, with
	// each problem and its kind, and no record.
	expect(
		expectErr(await data.settings.edit('settings', () => Ok({ count: 1 }))),
	).toEqual({
		name: 'Misfit',
		message:
			'data/settings/settings.md does not fit its fields:\ndata/settings/settings.md: title is missing',
		path: 'data/settings/settings.md',
		id: 'settings',
		problems: [{ line: 'title is missing', kind: 'title is missing' }],
	});
	expect(
		expectErr(
			await data.notes.create('a', { title: 'x', color: 'red' } as never),
		),
	).toMatchObject({
		name: 'Misfit',
		path: 'data/notes/a.md',
		id: 'a',
		problems: [{ line: 'has no field "color"', kind: 'has no such field' }],
	});
	expect(await read('data/settings/settings.md')).toBeUndefined();
	let absent = false;
	expect(
		expectOk(
			await data.notes.edit('new', (now) => {
				absent = now === undefined;
				return Ok({ title: 'new' });
			}),
		).id,
	).toBe('new');
	expect(absent).toBe(true);
});

test('plain patch repairs misfits and preserves undeclared lines and body', async () => {
	const text = '---\ntitle: 123\nextra: unquoted\ncount: 2\n---\nkept body';
	const { read, data } = await setup({ 'data/notes/a.md': text });
	expect(expectErr(await data.notes.get('a'))).toMatchObject({
		name: 'Misfit',
		record: { id: 'a', count: 2, body: 'kept body' },
	});
	const repaired = expectOk(await data.notes.patch('a', { title: 'fixed' }));
	expect(repaired).toMatchObject({
		title: 'fixed',
		count: 2,
		body: 'kept body',
	});
	expect(await read('data/notes/a.md')).toBe(
		text.replace('title: 123', 'title: "fixed"'),
	);
});

test('edit returns Misfit before calling its function and patch cannot rewrite unreadable front matter', async () => {
	for (const text of [
		'---\ntitle: 123\n---\nbody',
		'---\nnot a field\n---\nbody',
	]) {
		const { read, data } = await setup({ 'data/notes/a.md': text });
		const change = () => {
			throw new Error('must not call on a misfit');
		};
		expect(expectErr(await data.notes.edit('a', change)).name).toBe('Misfit');
		if (text.includes('not a field')) {
			expect(
				expectErr(await data.notes.patch('a', { title: 'fixed' })).name,
			).toBe('Misfit');
		}
		expect(await read('data/notes/a.md')).toBe(text);
	}
});

test('concurrent edits of one data file each land, each computed from the record it replaces', async () => {
	const { folder, read } = await tempFolder({
		'data/counters/a.md': '---\nn: 0\n---\n',
	});
	const { counters } = defineData(folder, {
		counters: {
			description: 'counter',
			fields: { n: field.integer({ optional: true }) },
		},
	});
	await Promise.all(
		Array.from({ length: 5 }, () =>
			counters.edit('a', (record) => Ok({ n: (record?.n ?? 0) + 1 })),
		),
	);
	expect(await read('data/counters/a.md')).toBe('---\nn: 5\n---\n');
	expect((await readdir(join(folder.path, 'data/counters'))).sort()).toEqual([
		'a.md',
	]);
});

test('computed refusals and faults leave a fitting file unchanged', async () => {
	const { data } = await setup();
	await data.notes.create('a', { title: 'a' });
	const refusal = ActionError.Refused({ message: 'stop' });
	expect(await data.notes.edit('a', () => refusal)).toBe(refusal);
	expect(await data.notes.edit('b', () => refusal)).toBe(refusal);
	await expect(
		data.notes.edit('a', () => {
			throw new Error('fault');
		}),
	).rejects.toThrow('fault');
	// A thrown refusal on an absent record escapes as the same object.
	const thrown = await data.notes
		.edit('b', () => {
			throw refusal.error;
		})
		.catch((cause: unknown) => cause);
	expect(thrown).toBe(refusal.error);
	expect(expectOk(await data.notes.get('a'))?.title).toBe('a');
	expect(expectOk(await data.notes.get('b'))).toBeUndefined();
});

// Node would name each of these files something else, so the handle
// refuses it before any folder operation; path checks nothing.
const notFileNames: unknown[] = [
	'',
	'a/b',
	'../x',
	'x/',
	'/x',
	123,
	null,
	undefined,
];
test.each(notFileNames)(
	'every folder verb refuses the id %j without touching the folder',
	async (id) => {
		const untouched = () => {
			throw new Error('a refused id reached the folder');
		};
		// Every read and write starts from the folder's path, so this one throws at any.
		const guarded: Folder = {
			get path(): string {
				return untouched();
			},
			write: untouched,
			edit: untouched,
			delete: untouched,
		};
		const { notes } = defineData(guarded, {
			notes: { description: 'note', fields: { title: field.text() } },
		});
		const given = id as string;
		for (const result of [
			await notes.get(given),
			await notes.create(given, { title: 'x' }),
			await notes.patch(given, { title: 'x' }),
			await notes.edit(given, () => {
				throw new Error('a refused id reached the callback');
			}),
			await notes.delete(given),
		])
			expect(expectErr(result)).toMatchObject({
				name: 'Misfit',
				path: 'data/notes',
				message: `data/notes does not fit its fields:\ndata/notes: ${JSON.stringify(id)} is not a file name: the id is the file name without .md`,
			});
	},
);

test.each([
	'2026-06-26-messi',
	'..',
	'.',
	'.foo',
	'café',
	'Café',
	'trailing ',
	' Dune',
	'Dune  Messiah',
	'token.local',
	'x.md',
	'a'.repeat(250),
])(
	'the id %j is the file name: create writes it and list reads it back',
	async (id) => {
		const { files, data } = await setup();
		const made = expectOk(await data.notes.create(id, { title: 't' }));
		expect(made).toMatchObject({ id, path: `data/notes/${id}.md` });
		expect(await files('data/notes')).toEqual([`data/notes/${id}.md`]);
		expect(expectOk(await data.notes.get(id))?.id).toBe(id);
		expect((await data.notes.list()).map((row) => expectOk(row).id)).toEqual([
			id,
		]);
	},
);

test.each([
	['with a backslash', 'a\\b'],
	['with a NUL byte', 'a\u0000b'],
	['longer than the system allows', 'x'.repeat(300)],
])('an id %s makes every write throw and writes no file', async (_, id) => {
	const { files, data } = await setup();
	for (const write of [
		() => data.notes.create(id, { title: 'x' }),
		() => data.notes.patch(id, { title: 'x' }),
		() => data.notes.edit(id, () => Ok({ title: 'x' })),
	])
		await expect(write()).rejects.toThrow();
	expect(await files('data')).toEqual([]);
});

test('an id with a newline is one file name, and its Misfit message spans lines', async () => {
	// An id holds no `/`, so a line it adds cannot name another file's path.
	const id = 'a\nevery record fits';
	const { files, data } = await setup({
		[`data/notes/${id}.md`]: '---\ntitle: 1\n---\n',
	});
	const misfit = expectErr(await data.notes.get(id));
	expect(misfit.problems).toHaveLength(1);
	expect(misfit.message.split('\n')).toEqual([
		'data/notes/a',
		'every record fits.md does not fit its fields:',
		'data/notes/a',
		'every record fits.md: title: 1 is not text',
	]);
	expect(await files('data/notes')).toEqual([`data/notes/${id}.md`]);
});

test('a Misfit carries the id of its record', async () => {
	const text = '---\ntitle: 123\n---\nbody';
	const { data } = await setup({ 'data/notes/a.md': text });
	expect(expectErr(await data.notes.get('a'))).toMatchObject({
		name: 'Misfit',
		path: 'data/notes/a.md',
		id: 'a',
	});
	expect(expectErr((await data.notes.list())[0] ?? Ok(null)).id).toBe('a');
});

test.each([
	'Notes',
	'two_words',
	'two/parts',
	'notes.txt',
	'notes.local',
	'notes.local.local',
	'.local',
	'',
	'1notes',
])('definitions refuse the data key %j', (key) => {
	expect(() =>
		defineData(unusedFolder, { [key]: { description: 'x', fields: {} } }),
	).toThrow(JSON.stringify(key));
});
test.each(['path', 'body', 'id'])('definitions reserve the field %s', (key) => {
	expect(() =>
		defineData(unusedFolder, {
			notes: { description: 'note', fields: { [key]: field.text() } },
		}),
	).toThrow(`"${key}"`);
});

test('a field may be named edit, old, or new, since no verb folds a passage beside fields', () => {
	expect(() =>
		defineData(unusedFolder, {
			notes: {
				description: 'note',
				fields: { edit: field.text(), old: field.text(), new: field.text() },
			},
		}),
	).not.toThrow();
});

test.each([
	['fields', { title: 'x' }],
	['a passage', { old: 'x', new: 'y' }],
	['null', null],
])('edit throws for %s: it takes only a function', async (_, change) => {
	const { data } = await setup();
	expect(() => data.notes.edit('a', change as never)).toThrow(
		'edit takes a function of the record',
	);
});

test('list reads every file directly in the folder whose extension is .md, sorted by path', async () => {
	const text = '---\ntitle: "valid"\n---\n';
	const files = [
		'z.md',
		'a.md',
		'bad.md',
		'a/attachment.md',
		'a/photo.png',
		'notes.txt',
		'.md',
		'x.md.bak',
		'x.MD',
		'.foo.md',
		'...md',
		'token.local.md',
		' trailing .md',
	];
	const {
		data: { notes },
	} = await setup(
		Object.fromEntries(
			files.map((name) => [
				`data/notes/${name}`,
				name === 'bad.md' ? '---\ntitle: 1\n---\n' : text,
			]),
		),
	);
	const rows = await notes.list();
	expect(rows.map((r) => r.error?.id ?? r.data?.id)).toEqual([
		' trailing ',
		'..',
		'.foo',
		'a',
		'bad',
		'token.local',
		'z',
	]);
	expect(expectErr(rows[4] ?? Ok(null))).toMatchObject({
		name: 'Misfit',
		path: 'data/notes/bad.md',
	});
});

test('definitions refuse cyclic schemas before they can break discovery', () => {
	const schema: { type: string; properties: Record<string, TSchema> } = {
		type: 'object',
		properties: {},
	};
	schema.properties.self = schema;
	expect(() =>
		defineData(unusedFolder, {
			records: { description: 'record', fields: { value: schema } },
		}),
	).toThrow(TypeError);
});

test('definitions refuse readOnly fields', () => {
	expect(() =>
		defineData(unusedFolder, {
			notes: {
				description: 'note',
				fields: {
					created: Type.String({ format: 'date-time', readOnly: true }),
				},
			},
		}),
	).toThrow('"created" readOnly');
});

test('a write refuses a ref that names no record, and nothing checks it again', async () => {
	const { folder, read, files } = await tempFolder({
		'data/watches/sfo-nyc.md': '',
		'data/watches/sfo-bos.md': '',
	});
	const data = defineData(folder, {
		watches: { description: 'watch', fields: {} },
		checks: {
			description: 'check',
			fields: {
				watch: field.ref('watches'),
				many: field.list(field.ref('watches'), { optional: true }),
				maybe: field.ref('watches', { optional: true }),
				count: field.integer(),
			},
		},
	});
	const missing = (field: string, id: string) => ({
		line: `${field} ${JSON.stringify(id)} names no record in watches`,
		kind: `${field} names no record in watches`,
	});
	expect(
		expectErr(await data.checks.create('a', { watch: 'missing', count: 1 })),
	).toMatchObject({
		name: 'Misfit',
		path: 'data/checks/a.md',
		problems: [missing('watch', 'missing')],
	});
	// An id Node would not keep is no record either, and nothing outside the target is read.
	expect(
		expectErr(
			await data.checks.create('a', { watch: '../checks/a', count: 1 }),
		),
	).toMatchObject({ problems: [missing('watch', '../checks/a')] });
	expect(await files('data/checks')).toEqual([]);

	expectOk(await data.checks.create('a', { watch: 'sfo-nyc', count: 1 }));
	expect(
		expectErr(
			await data.checks.patch('a', { many: ['sfo-bos', 'gone', 'sfo-nyc'] }),
		),
	).toMatchObject({ problems: [missing('many[1]', 'gone')] });
	expect(
		expectErr(await data.checks.edit('a', () => Ok({ maybe: 'gone' }))),
	).toMatchObject({ problems: [missing('maybe', 'gone')] });
	const before = await read('data/checks/a.md');
	expect(before).toBe('---\nwatch: "sfo-nyc"\ncount: 1\n---\n');

	expectOk(
		await data.checks.patch('a', { many: ['sfo-bos', 'sfo-nyc'], maybe: null }),
	);
	// A delete leaves the ref naming nothing; a write that does not set it passes.
	expect(expectOk(await data.watches.delete('sfo-nyc'))).toBe(true);
	expect(expectOk(await data.checks.patch('a', { count: 2 })).watch).toBe(
		'sfo-nyc',
	);
	expect(expectOk(await data.checks.get('a'))?.watch).toBe('sfo-nyc');
});

test.skipIf(!foldsCase)(
	'on a disk that ignores case, two ids that differ by case are one record',
	async () => {
		const { folder, read, files } = await tempFolder();
		const data = defineData(folder, {
			notes: { description: 'note', fields: {} },
			links: { description: 'link', fields: { note: field.ref('notes') } },
		});
		expectOk(await data.notes.create('dune', { body: 'first' }));
		// Each verb finds the one file and answers with the id it was given.
		expect(expectOk(await data.notes.get('DUNE'))).toMatchObject({
			id: 'DUNE',
			path: 'data/notes/DUNE.md',
			body: 'first',
		});
		expect(
			expectOk(await data.notes.patch('DUNE', { body: 'second' })).id,
		).toBe('DUNE');
		// The file keeps its first name, so list still says dune.
		expect(await files('data/notes')).toEqual(['data/notes/dune.md']);
		expect(await read('data/notes/dune.md')).toBe('---\n---\nsecond');
		expect((await data.notes.list()).map((row) => expectOk(row).id)).toEqual([
			'dune',
		]);
		// A ref passes the check by any case, and names nothing on a disk that keeps case.
		expectOk(await data.links.create('l', { note: 'Dune' }));
		expect(expectOk(await data.notes.delete('DUNE'))).toBe(true);
		expect(await files('data/notes')).toEqual([]);
	},
);

test('defineData refuses a ref to a key it does not declare, in a list or optional too', () => {
	for (const target of [
		field.ref('missing'),
		field.list(field.ref('missing')),
		field.ref('missing', { optional: true }),
	])
		expect(() =>
			defineData(unusedFolder, {
				notes: { description: 'note', fields: { target } },
				settings: { description: 'settings record', fields: {} },
			}),
		).toThrow(
			'The data key notes\'s field "target" refers to "missing", which must name a key in this defineData',
		);
});

test('a write rewrites only the lines it names, in the form the writer gives them', async () => {
	const { read, data } = await setup({
		'data/notes/a.md':
			'---\ntitle: "a"\ntags: ["x","y"]\ndone: false\n---\nbody',
	});
	expectOk(await data.notes.patch('a', { done: true }));
	expect(await read('data/notes/a.md')).toBe(
		'---\ntitle: "a"\ntags: ["x","y"]\ndone: true\n---\nbody',
	);
	// A field named in the change is written again, though its value is the same.
	expectOk(await data.notes.edit('a', (record) => Ok({ tags: record?.tags })));
	expect(await read('data/notes/a.md')).toBe(
		'---\ntitle: "a"\ntags: ["x", "y"]\ndone: true\n---\nbody',
	);
});

test('a write gives a file without front matter its fences, and an empty change writes nothing', async () => {
	const { read, data } = await setup({
		'data/settings/settings.md': 'old text',
	});
	expectErr(await data.settings.patch('settings', {}));
	expect(await read('data/settings/settings.md')).toBe('old text');
	expectOk(
		await data.settings.patch('settings', { title: 'T', body: 'new text' }),
	);
	expect(await read('data/settings/settings.md')).toBe(
		'---\ntitle: "T"\n---\nnew text',
	);
});

test('patch and edit refuse a change that names path or id in one wording, and write nothing', async () => {
	const { read, data } = await setup();
	await data.notes.create('a', { title: 'first' });
	const before = await read('data/notes/a.md');
	const refusal = (named: string) => ({
		name: 'Misfit',
		problems: [
			{
				line: `the change names ${named}, which name the record and are not fields; give only the fields that change, such as { done: true }`,
			},
		],
	});
	expect(
		expectErr(
			await data.notes.edit('a', (record) =>
				Ok({ ...record, title: 'second' }),
			),
		),
	).toMatchObject(refusal('path and id'));
	expect(
		expectErr(await data.notes.patch('a', { id: 'b' } as { title?: string })),
	).toMatchObject(refusal('id'));
	expect(await read('data/notes/a.md')).toBe(before);
	expect(
		expectOk(await data.notes.edit('a', () => Ok({ title: 'second' }))).title,
	).toBe('second');
});

test('edit of an absent record that returns an empty change makes it, as create with no fields does', async () => {
	const { folder, read } = await tempFolder();
	const data = defineData(folder, {
		marks: {
			description: 'mark',
			fields: { note: field.text({ optional: true }) },
		},
	});
	expect(expectOk(await data.marks.edit('a', () => Ok({})))).toEqual({
		path: 'data/marks/a.md',
		id: 'a',
		body: '',
	});
	expectOk(await data.marks.create('b', {}));
	expect(await read('data/marks/a.md')).toBe(await read('data/marks/b.md'));
	// On a record that is there, the same empty change leaves the file alone.
	const before = await read('data/marks/a.md');
	expectOk(await data.marks.edit('a', () => Ok({})));
	expect(await read('data/marks/a.md')).toBe(before);
});

test('a key named like a file says every key is a folder now, and what to write', () => {
	expect(() =>
		defineData(unusedFolder, {
			'settings.md': { description: 'settings record', fields: {} },
		}),
	).toThrow(
		'The data key "settings.md" must be a name: every key is a folder of records now, so write "settings", give the one record a fixed id, and move data/settings.md to data/settings/<id>.md',
	);
});

test('definitions name a key with no description or no fields', () => {
	expect(() =>
		defineData(unusedFolder, {
			notes: { fields: {} } as unknown as { description: string; fields: {} },
		}),
	).toThrow(
		'The data key notes needs a description: what one record is, such as "task"',
	);
	expect(() =>
		defineData(unusedFolder, {
			notes: { description: 'note' } as { description: string; fields: {} },
		}),
	).toThrow(
		'The data key notes needs fields: an object of field schemas, {} for none',
	);
});

test('data definitions refuse defaults', () => {
	expect(() =>
		defineData(unusedFolder, {
			notes: {
				description: 'note',
				fields: {
					nested: Type.Object({ number: Type.Number({ default: 1 }) }),
				},
			},
		}),
	).toThrow('default');
});

test.skipIf(!foldsCase)(
	'create refuses a name the disk already holds under another case',
	async () => {
		const { folder, read } = await tempFolder();
		const { notes } = defineData(folder, {
			notes: { description: 'note', fields: {} },
		});
		expect(expectOk(await notes.create('Dune', { body: 'first' })).body).toBe(
			'first',
		);
		expect(
			expectErr(await notes.create('dune', { body: 'second' })),
		).toMatchObject({ name: 'Changed', cause: 'there' });
		expect(await read('data/notes/Dune.md')).toContain('first');
	},
);
