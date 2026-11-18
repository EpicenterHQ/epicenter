/**
 * Data handles read and patch top-level Markdown records in the folder they were defined with.
 * Covers both key shapes, exact and refused ids, create, passage edits, repairs, diagnostics,
 * list membership, and the separation between app writes and reference checks.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { idProblem } from './id.ts';
import {
	ActionError,
	defineData,
	type Folder,
	field,
	Ok,
	timeId,
} from './index.ts';
import { foldsCase, tempFolder } from './temp-folder.test-support.ts';

/** For a definition that is refused before any handle exists, so no folder is used. */
const nowhere = {} as Folder;

async function setup(seed: Record<string, string> = {}) {
	const { folder, read, files } = await tempFolder(seed);
	const data = defineData(folder, {
		notes: {
			fields: {
				title: field.text(),
				count: field.integer({ optional: true }),
				done: field.boolean(),
				tags: field.list(field.text()),
			},
		},
		'settings.md': {
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
		done: false,
		tags: [],
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

test('one-file verbs read absent, create through patch, compute, and delete without an id', async () => {
	const { data } = await setup();
	const settings = data['settings.md'];
	expect(settings).not.toHaveProperty('list');
	expect(settings).not.toHaveProperty('create');
	expect(settings.path()).toBe('data/settings.md');
	expect(expectOk(await settings.get())).toBeUndefined();
	expect(
		expectOk(await settings.patch({ title: 'Daily', body: 'notes' })),
	).toEqual({ path: 'data/settings.md', title: 'Daily', body: 'notes' });
	expect(
		expectOk(
			await settings.edit((now) => Ok({ count: (now?.count ?? 0) + 1 })),
		),
	).toMatchObject({ title: 'Daily', count: 1 });
	expect(expectOk(await settings.get())).not.toHaveProperty('id');
	expect(expectOk(await settings.delete())).toBe(true);
	expect(expectOk(await settings.delete())).toBe(false);
	let sawAbsent = false;
	expect(
		expectOk(
			await settings.edit((now) => {
				sawAbsent = now === undefined;
				return Ok({ title: 'New' });
			}),
		),
	).toMatchObject({ title: 'New' });
	expect(sawAbsent).toBe(true);
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

test('folder patch returns Missing, one-file patch creates only a fitting record, and a computed edit may create', async () => {
	const { read, data } = await setup();
	expect(expectErr(await data.notes.patch('typo', { title: 'x' })).name).toBe(
		'Missing',
	);
	// A change that does not fit is Misfit, like a file that does not, with
	// each problem and its kind, and no record.
	expect(expectErr(await data['settings.md'].patch({ count: 1 }))).toEqual({
		name: 'Misfit',
		message:
			'data/settings.md does not fit its fields:\ndata/settings.md: title is missing',
		path: 'data/settings.md',
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
	expect(await read('data/settings.md')).toBeUndefined();
	expect(expectOk(await data['settings.md'].patch({ title: 'x' })).title).toBe(
		'x',
	);
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

test('plain patch repairs misfits and preserves undeclared lines and body for both key shapes', async () => {
	const text = '---\ntitle: 123\nextra: unquoted\ncount: 2\n---\nkept body';
	const { read, data } = await setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
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
	expect(
		expectOk(await data['settings.md'].patch({ title: 'fixed' })).title,
	).toBe('fixed');
	for (const path of ['data/notes/a.md', 'data/settings.md'])
		expect(await read(path)).toBe(text.replace('title: 123', 'title: "fixed"'));
});

test('edit returns Misfit before calling its function and patch cannot rewrite unreadable front matter', async () => {
	for (const text of [
		'---\ntitle: 123\n---\nbody',
		'---\nnot a field\n---\nbody',
	]) {
		const { read, data } = await setup({
			'data/notes/a.md': text,
			'data/settings.md': text,
		});
		const change = () => {
			throw new Error('must not call on a misfit');
		};
		expect(expectErr(await data.notes.edit('a', change)).name).toBe('Misfit');
		expect(expectErr(await data['settings.md'].edit(change)).name).toBe(
			'Misfit',
		);
		if (text.includes('not a field')) {
			expect(
				expectErr(await data.notes.patch('a', { title: 'fixed' })).name,
			).toBe('Misfit');
			expect(
				expectErr(await data['settings.md'].patch({ title: 'fixed' })).name,
			).toBe('Misfit');
		}
		expect(await read('data/notes/a.md')).toBe(text);
		expect(await read('data/settings.md')).toBe(text);
	}
});

test('computed refusals and faults leave a fitting file unchanged', async () => {
	const { data } = await setup();
	await data.notes.create('a', { title: 'a' });
	const refusal = ActionError.Refused({ message: 'stop' });
	expect(await data.notes.edit('a', () => refusal)).toBe(refusal);
	expect(await data['settings.md'].edit(() => refusal)).toBe(refusal);
	await expect(
		data.notes.edit('a', () => {
			throw new Error('fault');
		}),
	).rejects.toThrow('fault');
	expect(expectOk(await data.notes.get('a'))?.title).toBe('a');
	expect(expectOk(await data['settings.md'].get())).toBeUndefined();
});

// Each refusal happens before any folder operation; path checks nothing.
const invalidIds = [
	'',
	'   ',
	'a/b',
	'a\\b',
	'a\u0000b',
	'a\u007fb',
	'a\u0085b',
	'.hidden',
	' .hidden',
	'界'.repeat(67),
	'a'.repeat(201),
];
test.each(invalidIds)(
	'every folder verb refuses the id %j without touching the folder',
	async (id) => {
		const untouched = () => {
			throw new Error('invalid id reached the folder');
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
			notes: { fields: { title: field.text() } },
		});
		for (const result of [
			await notes.get(id),
			await notes.create(id, { title: 'x' }),
			await notes.patch(id, { title: 'x' }),
			await notes.edit(id, () => {
				throw new Error('invalid id reached callback');
			}),
			await notes.delete(id),
		])
			expect(expectErr(result).name).toBe('Misfit');
		expect(idProblem(id)).toBeDefined();
	},
);

test.each([
	[
		' Dune',
		'data/notes does not fit its fields:\ndata/notes: " Dune": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Dune ',
		'data/notes does not fit its fields:\ndata/notes: "Dune ": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Dune\u00a0',
		'data/notes does not fit its fields:\ndata/notes: "Dune\u00a0": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'\u3000Dune',
		'data/notes does not fit its fields:\ndata/notes: "\u3000Dune": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Cafe\u0301',
		'data/notes does not fit its fields:\ndata/notes: "Cafe\u0301": an id must be Unicode NFC; send "Caf\u00e9"',
	],
])(
	'an id is never tidied: %j is refused by every verb with the reason',
	async (id, message) => {
		const {
			files,
			data: { notes },
		} = await setup({
			'data/notes/Dune.md': '',
			'data/notes/Caf\u00e9.md': '',
		});
		expect(notes.path(id)).toBe(`data/notes/${id}.md`);
		for (const result of [
			await notes.get(id),
			await notes.create(id, { title: 'x' }),
			await notes.patch(id, { title: 'x' }),
			await notes.edit(id, () => Ok({ title: 'x' })),
			await notes.delete(id),
		])
			expect(expectErr(result)).toMatchObject({ name: 'Misfit', message });
		expect((await files('data/notes')).sort()).toEqual(
			['data/notes/Caf\u00e9.md', 'data/notes/Dune.md'].sort(),
		);
		expect(idProblem(id)).toBeDefined();
	},
);

test('a Misfit carries the id of a folder record and none for a one-file key', async () => {
	const text = '---\ntitle: 123\n---\nbody';
	const { data } = await setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	expect(expectErr(await data.notes.get('a'))).toMatchObject({
		name: 'Misfit',
		path: 'data/notes/a.md',
		id: 'a',
	});
	expect(expectErr((await data.notes.list())[0] ?? Ok(null)).id).toBe('a');
	const single = expectErr(await data['settings.md'].get());
	expect(single.path).toBe('data/settings.md');
	expect(single).not.toHaveProperty('id');
});

test('ids retain internal spaces, case, NFC accents, and the byte limit', async () => {
	const {
		data: { notes },
	} = await setup();
	for (const id of ['Dune  Messiah', 'é', 'a'.repeat(200), '界'.repeat(66)]) {
		expect(idProblem(id)).toBeUndefined();
		expect(expectOk(await notes.create(id, { title: id })).id).toBe(id);
		expect(expectOk(await notes.get(id))?.id).toBe(id);
	}
	expect(expectOk(await notes.get('Dune Messiah'))).toBeUndefined();
});

test('token.local is a valid id in a folder key', async () => {
	const {
		data: { notes },
	} = await setup();
	expect(idProblem('token.local')).toBeUndefined();
	expect(
		expectOk(await notes.create('token.local', { title: 'Token' })).id,
	).toBe('token.local');
	expect(expectOk(await notes.get('token.local'))?.path).toBe(
		'data/notes/token.local.md',
	);
});

test.each([
	'Notes',
	'two_words',
	'two/parts',
	'notes.txt',
	'notes.local',
	'notes.local.md',
	'notes.md.local',
	'notes.local.local',
	'.local',
	'',
	'1notes',
])('definitions refuse the data key %j', (key) => {
	expect(() => defineData(nowhere, { [key]: { fields: {} } })).toThrow(
		JSON.stringify(key),
	);
});
test.each(['path', 'body', 'id'])('definitions reserve the field %s', (key) => {
	expect(() =>
		defineData(nowhere, { notes: { fields: { [key]: field.text() } } }),
	).toThrow(`"${key}"`);
});

test('a field may be named edit, old, or new, since no verb folds a passage beside fields', () => {
	expect(() =>
		defineData(nowhere, {
			notes: {
				fields: { edit: field.text(), old: field.text(), new: field.text() },
			},
		}),
	).not.toThrow();
});

test.each(['folder', 'one-file'] as const)(
	'%s passage edit replaces exactly one occurrence and refuses a missing, repeated, or empty passage without writing',
	async (kind) => {
		const path = kind === 'folder' ? 'data/notes/a.md' : 'data/settings.md';
		const text = '---\ntitle: "a"\n---\none two two';
		const { read, data } = await setup({ [path]: text });
		const edit = (passage: { old: string; new: string }) =>
			kind === 'folder'
				? data.notes.edit('a', passage)
				: data['settings.md'].edit(passage);
		expect(expectErr(await edit({ old: 'three', new: 'x' }))).toMatchObject({
			name: 'Changed',
			cause: 'quote',
			path,
		});
		expect(expectErr(await edit({ old: 'two', new: 'x' }))).toMatchObject({
			name: 'Changed',
			cause: 'twice',
			path,
		});
		expect(expectErr(await edit({ old: '', new: 'x' })).name).toBe('Misfit');
		expect(await read(path)).toBe(text);
		expect(expectOk(await edit({ old: 'one', new: 'ONE' })).body).toBe(
			'ONE two two',
		);
	},
);

test('a passage edit of an absent file is Missing for folder and one-file keys, and writes nothing', async () => {
	const { files, data } = await setup();
	expect(
		expectErr(await data.notes.edit('a', { old: 'x', new: 'y' })),
	).toMatchObject({ name: 'Missing', path: 'data/notes/a.md' });
	expect(
		expectErr(await data['settings.md'].edit({ old: 'x', new: 'y' })),
	).toMatchObject({ name: 'Missing', path: 'data/settings.md' });
	expect(await files('data')).toEqual([]);
});

test('a passage edit of a misfit returns the Misfit before any change', async () => {
	const text = '---\ntitle: 123\n---\nold body';
	const { read, data } = await setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	expect(
		expectErr(await data.notes.edit('a', { old: 'old', new: 'new' })).name,
	).toBe('Misfit');
	expect(
		expectErr(await data['settings.md'].edit({ old: 'old', new: 'new' })).name,
	).toBe('Misfit');
	expect(await read('data/notes/a.md')).toBe(text);
	expect(await read('data/settings.md')).toBe(text);
});

test.each([
	['fields', { title: 'x' }],
	['half a passage', { old: 'x' }],
	['a passage with fields', { old: 'x', new: 'y', title: 'z' }],
	['a passage of numbers', { old: 1, new: 2 }],
	['an array', ['x', 'y']],
	[
		'a class instance',
		new (class {
			old = 'x';
			new = 'y';
		})(),
	],
	['null', null],
	['text', 'x'],
])('edit refuses %s at run time, before reading', async (_, change) => {
	const { data } = await setup({
		'data/notes/a.md': '---\ntitle: "a"\n---\nx',
	});
	for (const result of [
		await data.notes.edit('a', change as never),
		await data['settings.md'].edit(change as never),
	])
		expect(expectErr(result).name).toBe('Misfit');
});

test('list reads only directly contained Markdown files with valid ids, sorted by path', async () => {
	const text = '---\ntitle: "valid"\n---\n';
	const files = [
		'z.md',
		'a.md',
		'bad.md',
		'nested/child.md',
		'picture.png',
		'.hidden.md',
		'token.local.md',
		'token.LOCAL.extra.md',
		' trailing .md',
		'e\u0301.md',
		`${'x'.repeat(201)}.md`,
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
	expect(rows.map((r) => r.error?.path ?? r.data?.path)).toEqual([
		'data/notes/a.md',
		'data/notes/bad.md',
		'data/notes/token.LOCAL.extra.md',
		'data/notes/token.local.md',
		'data/notes/z.md',
	]);
	for (const row of rows) {
		if (row.error) expect(expectErr(row).name).toBe('Misfit');
	}
});

test('definitions refuse readOnly fields', () => {
	expect(() =>
		defineData(nowhere, {
			notes: {
				fields: {
					created: Type.String({ format: 'date-time', readOnly: true }),
				},
			},
		}),
	).toThrow('"created" readOnly');
});

test('handles write refs as given without opening the referenced file', async () => {
	// A file where the target's folder would be: opening anything in it throws.
	const { folder } = await tempFolder({ 'data/watches': 'not a folder' });
	const data = defineData(folder, {
		watches: { fields: {} },
		checks: {
			fields: {
				watch: field.ref('watches'),
				many: field.list(field.ref('watches')),
				count: field.integer(),
			},
		},
	});
	expect(
		expectOk(await data.checks.create('a', { watch: 'missing', count: 1 }))
			.watch,
	).toBe('missing');
	expect(
		expectOk(await data.checks.patch('a', { watch: 'also-missing', count: 2 }))
			.count,
	).toBe(2);
	expect(
		expectOk(await data.checks.edit('a', () => Ok({ count: 3 }))).count,
	).toBe(3);
	expect(expectOk(await data.checks.get('a'))?.watch).toBe('also-missing');
});

test('data refs validate their target at runtime', () => {
	for (const target of ['missing', 'settings.md']) {
		// Dynamic schemas exercise runtime validation without bypassing the public types.
		const ref = Type.String({ 'x-epicenter-ref': { key: target } });
		expect(() =>
			defineData(nowhere, {
				notes: { fields: { ref } },
				'settings.md': { fields: {} },
			}),
		).toThrow(target);
	}
});

test('timeId preserves the UTC ISO stamp and adds exactly eight lowercase base36 characters', () => {
	const at = new Date('2026-11-16T09:12:04.120Z');
	const ids = Array.from({ length: 100 }, () => timeId(at));
	expect(
		ids.every((id) => /^2026-11-16T09-12-04-120Z-[a-z0-9]{8}$/.test(id)),
	).toBe(true);
	expect(new Set(ids).size).toBe(100);
	expect(
		ids.every((id) => timeId(new Date('2026-11-16T09:12:04.121Z')) > id),
	).toBe(true);
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
	// A spread names every field, so tags is written again, though its value is the same.
	expectOk(await data.notes.edit('a', (record) => Ok({ ...record })));
	expect(await read('data/notes/a.md')).toBe(
		'---\ntitle: "a"\ntags: ["x", "y"]\ndone: true\n---\nbody',
	);
});

test('a write gives a file without front matter its fences, and an empty change writes nothing', async () => {
	const { read, data } = await setup({ 'data/settings.md': 'old text' });
	expectErr(await data['settings.md'].patch({}));
	expect(await read('data/settings.md')).toBe('old text');
	expectOk(await data['settings.md'].patch({ title: 'T', body: 'new text' }));
	expect(await read('data/settings.md')).toBe('---\ntitle: "T"\n---\nnew text');
});

test('edit accepts a whole record spread without storing its path or id as fields', async () => {
	const { read, data } = await setup();
	await data.notes.create('a', { title: 'first' });
	await data['settings.md'].patch({ title: 'first' });
	expect(
		expectOk(
			await data.notes.edit('a', (record) =>
				Ok({ ...record, title: 'second' }),
			),
		).title,
	).toBe('second');
	expect(
		expectOk(
			await data['settings.md'].edit((record) =>
				Ok({ ...record, title: 'second' }),
			),
		).title,
	).toBe('second');
	const text = await read('data/notes/a.md');
	expect(text).not.toContain('path:');
	expect(text).not.toContain('id:');
});

test('data definitions refuse defaults', () => {
	expect(() =>
		defineData(nowhere, {
			notes: {
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
		const { notes } = defineData(folder, { notes: { fields: {} } });
		expect(expectOk(await notes.create('Dune', { body: 'first' })).body).toBe(
			'first',
		);
		expect(
			expectErr(await notes.create('dune', { body: 'second' })),
		).toMatchObject({ name: 'Changed', cause: 'there' });
		expect(await read('data/notes/Dune.md')).toContain('first');
	},
);
